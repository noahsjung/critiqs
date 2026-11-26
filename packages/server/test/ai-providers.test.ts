import { afterEach, describe, expect, test } from "bun:test";
import type { AiProvider } from "@critiqs/core";
import { isLocalHost } from "@critiqs/server";
import { checkEndpoint, guardedFetch } from "../src/ai/endpoints.ts";
import { accessCheck, AiError } from "../src/ai/model.ts";
import { testRequest, interpretRequest } from "../src/ai/prompts.ts";
import { createStructuredModel } from "../src/ai/providers.ts";
import type { ResolvedConnection } from "../src/ai/settings.ts";

// The AI SDK path against local stand-ins for each provider's HTTP API. These
// check what Critiqs sends (address, key header, model, schema) and how it
// reads answers and errors; they say nothing about real providers' quality.

type Ready = Extract<ResolvedConnection, { ready: true }>;
interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const KEY = "sk-test-SECRET-1234";

/** Answers each request with `respond`, recording what arrived. */
function provider(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const entry: Seen = {
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers),
        body: request.method === "POST" ? await request.json().catch(() => null) : null,
      };
      seen.push(entry);
      return await respond(entry);
    },
  });
  servers.push(server);
  return { seen, base: `http://127.0.0.1:${server.port}/v1` };
}

function connection(provider: AiProvider, baseUrl: string, apiKey: string | undefined = KEY): Ready {
  return { ready: true, mode: "own", provider, model: "test-model", baseUrl, apiKey, trustedEndpoint: true, epoch: 0 };
}

const usage = { input_tokens: 5, output_tokens: 3, total_tokens: 8 };

interface Reported {
  openrouter?: Record<string, unknown>;
  gateway?: Record<string, unknown>;
}
const REPORTED: Required<Reported> = {
  openrouter: { cost: 0.0042, is_byok: false, cost_details: { upstream_inference_cost: 0.0042 } },
  gateway: { cost: "0.0042", marketCost: "0.0042", generationId: "gen_1" },
};

/** A successful answer carrying `text`, in each provider's own format. */
function answer(kind: AiProvider, text: string, request: Seen, reported: Reported = REPORTED): Response {
  switch (kind) {
    case "openai":
      return Response.json({
        id: "resp_1",
        object: "response",
        created_at: 1_700_000_000,
        status: "completed",
        model: "test-model",
        output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
        usage: { ...usage, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
        incomplete_details: null,
      });
    case "compatible":
    case "openrouter":
      return Response.json({
        id: "chat_1",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 3,
          total_tokens: 8,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
          ...(kind === "openrouter" ? reported.openrouter : {}),
        },
      });
    case "anthropic": {
      // Anthropic answers either through its structured output format or the `json` tool, as asked.
      const tool = (request.body?.tools ?? []).some((entry: { name?: string }) => entry.name === "json");
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: tool ? [{ type: "tool_use", id: "toolu_1", name: "json", input: JSON.parse(text) }] : [{ type: "text", text }],
        stop_reason: tool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 3 },
      });
    }
    case "google":
      return Response.json({
        candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 5, cachedContentTokenCount: 2, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 8 },
      });
    case "gateway":
      return Response.json({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 5, noCache: 3, cacheRead: 2, cacheWrite: undefined },
          outputTokens: { total: 3, text: 2, reasoning: 1 },
        },
        ...(reported.gateway === undefined ? {} : { providerMetadata: { gateway: reported.gateway } }),
        warnings: [],
      });
  }
}

const EXPECTED: Record<AiProvider, { path: string; auth: (headers: Record<string, string>) => string | undefined }> = {
  openai: { path: "/v1/responses", auth: (headers) => headers.authorization },
  compatible: { path: "/v1/chat/completions", auth: (headers) => headers.authorization },
  openrouter: { path: "/v1/chat/completions", auth: (headers) => headers.authorization },
  anthropic: { path: "/v1/messages", auth: (headers) => headers["x-api-key"] },
  google: { path: "/v1/models/test-model:generateContent", auth: (headers) => headers["x-goog-api-key"] },
  gateway: { path: "/v1/language-model", auth: (headers) => headers.authorization },
};

describe("each provider", () => {
  for (const kind of ["openai", "compatible", "openrouter", "anthropic", "google", "gateway"] as const) {
    test(`${kind}: sends the model, key, and schema to the configured address and reads the structured answer and its usage`, async () => {
      const { seen, base } = provider((request) => answer(kind, JSON.stringify({ status: "ok" }), request));
      const result = await createStructuredModel(connection(kind, base)).generate(testRequest());
      // 5 input tokens, 2 of them cached; 3 output tokens, 1 of them reasoning.
      const reports = kind === "openrouter" || kind === "gateway";
      expect(result).toEqual({ output: { ok: true }, usage: { inputTokens: 5, outputTokens: 3, ...(reports ? { costUsd: 0.0042 } : {}) } });
      expect(seen).toHaveLength(1);
      const [request] = seen;
      expect(request!.path).toBe(EXPECTED[kind].path);
      expect(EXPECTED[kind].auth(request!.headers)).toContain(KEY);
      const body = JSON.stringify(request!.body);
      // The schema reaches the provider, and the gateway is told which model.
      expect(body).toContain('"status"');
      if (kind === "gateway") expect(request!.headers["ai-language-model-id"]).toBe("test-model");
      else if (kind !== "google") expect(body).toContain("test-model");
    });

    test(`${kind}: refused keys, unknown models, and rate limits are explained without the provider's response`, async () => {
      for (const [status, code] of [
        [401, "auth"],
        [404, "model"],
        [429, "rate-limit"],
      ] as const) {
        const { base } = provider(() => Response.json({ error: { message: `bad key ${KEY}`, type: "error" } }, { status }));
        const failure = await createStructuredModel(connection(kind, base))
          .generate(testRequest())
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AiError);
        expect((failure as AiError).code).toBe(code);
        expect((failure as AiError).message).not.toContain(KEY);
      }
    });

    test(`${kind}: an answer that doesn't fit the schema is a capability error`, async () => {
      const { base } = provider((request) => answer(kind, JSON.stringify({ status: "maybe" }), request));
      const failure = await createStructuredModel(connection(kind, base))
        .generate(testRequest())
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "capability" });
    });
  }
});

describe("reported costs", () => {
  async function costOf(kind: "openrouter" | "gateway", reported: Record<string, unknown> | undefined) {
    const { base } = provider((request) => answer(kind, JSON.stringify({ status: "ok" }), request, { [kind]: reported }));
    return (await createStructuredModel(connection(kind, base)).generate(testRequest())).usage.costUsd;
  }

  test("OpenRouter: its own key's charge is `cost` alone; with a key of one's own, the provider's charge plus OpenRouter's fee", async () => {
    expect(await costOf("openrouter", { cost: 0.0042, is_byok: false, cost_details: { upstream_inference_cost: 0.0042 } })).toBe(0.0042);
    expect(await costOf("openrouter", { cost: 0.0042 })).toBe(0.0042);
    expect(await costOf("openrouter", { cost: 0.0002, is_byok: true, cost_details: { upstream_inference_cost: 0.004 } })).toBe(0.0042);
  });

  test("OpenRouter: a charge it can't fully report leaves the price to the model's tokens", async () => {
    for (const reported of [
      { cost: 0.0002, is_byok: true, cost_details: { upstream_inference_cost: null } },
      { cost: 0.0002, is_byok: true },
      { cost: -1, is_byok: false },
      { cost: "0.0042", is_byok: false },
      { cost: 0.0002, is_byok: true, cost_details: { upstream_inference_cost: -0.004 } },
      undefined,
    ]) {
      expect(await costOf("openrouter", reported)).toBeUndefined();
    }
  });

  test("Vercel AI Gateway: the cost it reports, as text or a number; its market cost when that is higher, as with a key of one's own", async () => {
    expect(await costOf("gateway", { cost: "0.0042", generationId: "gen_1" })).toBe(0.0042);
    expect(await costOf("gateway", { cost: 0.0042 })).toBe(0.0042);
    expect(await costOf("gateway", { cost: "0", marketCost: "0.0042" })).toBe(0.0042);
    for (const reported of [{ generationId: "gen_1" }, { cost: "free" }, { cost: "-0.1" }, { cost: "" }, undefined]) {
      expect(await costOf("gateway", reported)).toBeUndefined();
    }
  });

  test("Vercel AI Gateway: a key of one's own reporting no charge and no market cost leaves the price to the model's tokens", async () => {
    for (const reported of [{ cost: "0" }, { cost: 0, marketCost: null }, { cost: "0", marketCost: "" }, { cost: "0", marketCost: "0" }]) {
      expect(await costOf("gateway", reported)).toBeUndefined();
    }
  });
});

test("a model's search interpretation is checked against the project's own tags and groups", async () => {
  const { base } = provider((request) =>
    answer(
      "compatible",
      JSON.stringify({ terms: ["label", "", "x".repeat(70)], tags: ["Wording", "invented"], groups: ["G1", "G9"], status: "unspecified", since: "2026-01-05", until: "nonsense", screen: "" }),
      request,
    ),
  );
  const result = await createStructuredModel(connection("compatible", base)).generate(
    interpretRequest({ question: "label copy since Jan 5", tags: [{ key: "wording", label: "wording" }], groups: [{ id: "group-1", name: "Copy & wording" }], today: "2026-02-01" }),
  );
  expect(result.output).toEqual({
    terms: ["label"],
    tags: ["wording"],
    groupIds: ["group-1"],
    status: null,
    since: Date.parse("2026-01-05T00:00:00Z"),
    until: null,
    screen: null,
  });
});

test("redirects are never followed, so a key can't be sent elsewhere", async () => {
  const target = provider(() => Response.json({}));
  const { base } = provider(() => new Response(null, { status: 307, headers: { Location: `${target.base}/chat/completions` } }));
  const failure = await createStructuredModel(connection("compatible", base))
    .generate(testRequest())
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "network" });
  expect(target.seen).toEqual([]);
});

test("requests can't leave the configured address, and default addresses must use HTTPS", async () => {
  const fetch = guardedFetch("https://llm.example.com/v1", 1000);
  await expect(fetch("https://llm.example.com/other")).rejects.toThrow("outside its configured endpoint");
  await expect(fetch("https://evil.example/v1/chat")).rejects.toThrow("outside its configured endpoint");
  await expect(guardedFetch("http://127.0.0.1:1/v1", 1000, false)("http://127.0.0.1:1/v1/x")).rejects.toThrow("HTTPS");
});

test("slow providers time out as a network error", async () => {
  const { base } = provider(() => new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json({})), 2000)));
  const failure = await createStructuredModel(connection("compatible", base), { timeoutMs: 100 })
    .generate(testRequest())
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "network" });
});

describe("endpoints owners may enter", () => {
  const policy = { allowed: ["https://llm.example.com/v1", "http://ollama.internal:11434/v1"], allowLocal: false };
  test("must be HTTPS, on the operator's list, without credentials or private addresses", () => {
    expect(checkEndpoint("https://llm.example.com/v1/", policy)).toEqual({ ok: true, url: "https://llm.example.com/v1" });
    expect(checkEndpoint("https://llm.example.com/v1/deployments/a", policy)).toMatchObject({ ok: true });
    expect(checkEndpoint("https://llm.example.com/v10", policy)).toMatchObject({ ok: false });
    expect(checkEndpoint("https://llm.example.com.evil.example/v1", policy)).toMatchObject({ ok: false });
    expect(checkEndpoint("http://llm.example.com/v1", policy)).toMatchObject({ ok: false });
    expect(checkEndpoint("https://key@llm.example.com/v1", policy)).toMatchObject({ ok: false });
    expect(checkEndpoint("https://llm.example.com/v1?x=1", policy)).toMatchObject({ ok: false });
    for (const address of ["https://127.0.0.1/v1", "https://10.0.0.2/v1", "https://169.254.169.254/latest", "https://[::1]/v1", "https://[::ffff:127.0.0.1]/v1", "https://localhost/v1", "http://ollama.internal:11434/v1"]) {
      expect(checkEndpoint(address, { ...policy, allowed: [...policy.allowed, address] })).toMatchObject({ ok: false });
    }
  });

  test("isLocalHost is still exported from @critiqs/server", () => {
    expect(["localhost", "10.0.0.2", "[::1]", "ollama.internal"].map(isLocalHost)).toEqual([true, true, true, true]);
    expect(["llm.example.com", "8.8.8.8"].map(isLocalHost)).toEqual([false, false]);
  });

  test("local addresses work only where the operator allows them", () => {
    expect(checkEndpoint("http://ollama.internal:11434/v1", { ...policy, allowLocal: true })).toMatchObject({ ok: true });
    // Still only listed ones.
    expect(checkEndpoint("http://127.0.0.1:8080/v1", { ...policy, allowLocal: true })).toMatchObject({ ok: false });
  });
});

describe("access checks at dispatch", () => {
  test("every attempt the AI SDK sends, its retry included, is checked first, and a refused check sends nothing more", async () => {
    let failFirst = true;
    const { seen, base } = provider((request) => {
      if (failFirst) {
        failFirst = false;
        return Response.json({ error: { message: "overloaded", type: "server_error" } }, { status: 500 });
      }
      return answer("compatible", JSON.stringify({ status: "ok" }), request);
    });
    const model = createStructuredModel(connection("compatible", base));
    let checks = 0;
    const result = await model.generate({ ...testRequest(), beforeSend: async () => void checks++ });
    expect(result.output).toEqual({ ok: true });
    // The first attempt failed and was retried: two requests, each checked.
    expect(seen).toHaveLength(2);
    expect(checks).toBe(2);

    // Access ends after the first attempt: the retry isn't sent, and the refusal comes back as it was thrown.
    failFirst = true;
    seen.length = 0;
    checks = 0;
    const refusal = new Error("Access ended.");
    const access = accessCheck(async () => {
      if (++checks > 1) throw refusal;
    });
    const failure = await model.generate({ ...testRequest(), beforeSend: access.beforeSend }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiError);
    expect(() => access.rethrow()).toThrow(refusal);
    expect(seen).toHaveLength(1);
    expect(checks).toBe(2);
  });
});
