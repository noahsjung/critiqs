import { describe, expect, test } from "bun:test";
import type { AiProvider } from "@critiqs/core";
import { AiError } from "../src/ai/model.ts";
import { fetchModelList, MAX_LISTED_MODELS, MAX_MODEL_LIST_BYTES, type ModelListTarget, modelListTarget, parseModelList } from "../src/ai/model-lists.ts";
import { keyBinding } from "../src/ai/secrets.ts";
import { type AiDeployment, sealKey, prepareSettings } from "../src/ai/settings.ts";
import type { StoredConnection } from "../src/store.ts";

// Providers' model lists, read from each provider's own format with a fake
// fetch: the address and key headers Critiqs sends, what it keeps from the
// answer, and how it refuses redirects, large answers, and failures without
// repeating the provider's response.

const KEY = "sk-list-SECRET-1234";

interface Sent {
  url: string;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
}

/** A fetch answering every request with `respond`, recording what was sent. */
function fakeFetch(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry = { url: String(input), headers: Object.fromEntries(new Headers(init?.headers)), redirect: init?.redirect };
    sent.push(entry);
    return respond(entry);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const target = (provider: AiProvider, baseUrl: string | null = null, apiKey: string | undefined = KEY): ModelListTarget => ({ provider, baseUrl, apiKey, allowHttp: false });

describe("each provider's list", () => {
  const cases: { provider: AiProvider; baseUrl?: string; url: string; key: [string, string]; body: unknown; models: { id: string; label: string | null }[] }[] = [
    {
      provider: "openai",
      url: "https://api.openai.com/v1/models",
      key: ["authorization", `Bearer ${KEY}`],
      body: { object: "list", data: [{ id: "gpt-5-mini", object: "model" }, { id: "text-embedding-3-small" }, { id: "gpt-5" }, { id: "whisper-1" }, { id: "tts-1" }] },
      models: [
        { id: "gpt-5", label: null },
        { id: "gpt-5-mini", label: null },
      ],
    },
    {
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/models?limit=1000",
      key: ["x-api-key", KEY],
      body: { data: [{ type: "model", id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }, { type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }], has_more: false },
      models: [
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
        { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      ],
    },
    {
      provider: "google",
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      key: ["x-goog-api-key", KEY],
      body: {
        models: [
          { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
          { name: "models/text-embedding-004", displayName: "Text Embedding 004", supportedGenerationMethods: ["embedContent"] },
        ],
      },
      models: [{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }],
    },
    {
      provider: "gateway",
      url: "https://ai-gateway.vercel.sh/v1/models",
      key: ["authorization", `Bearer ${KEY}`],
      body: { object: "list", data: [{ id: "openai/gpt-5", name: "GPT-5", type: "language" }, { id: "openai/text-embedding-3-small", name: "Embedding", type: "embedding" }] },
      models: [{ id: "openai/gpt-5", label: "GPT-5" }],
    },
    {
      provider: "openrouter",
      url: "https://openrouter.ai/api/v1/models",
      key: ["authorization", `Bearer ${KEY}`],
      body: { data: [{ id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", pricing: {} }, { id: "openai/gpt-5-mini", name: "OpenAI: GPT-5 Mini" }] },
      models: [
        { id: "anthropic/claude-sonnet-4.5", label: "Anthropic: Claude Sonnet 4.5" },
        { id: "openai/gpt-5-mini", label: "OpenAI: GPT-5 Mini" },
      ],
    },
    {
      provider: "compatible",
      baseUrl: "https://llm.example.com/v1",
      url: "https://llm.example.com/v1/models",
      key: ["authorization", `Bearer ${KEY}`],
      body: { object: "list", data: [{ id: "llama3.2:latest", object: "model" }] },
      models: [{ id: "llama3.2:latest", label: null }],
    },
  ];
  for (const entry of cases) {
    test(`${entry.provider}: asks its list address with the key and reads ids and names`, async () => {
      const { fetch, sent } = fakeFetch(() => Response.json(entry.body));
      expect(await fetchModelList(target(entry.provider, entry.baseUrl ?? null), { fetch })).toEqual({ models: entry.models, truncated: false });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe(entry.url);
      expect(sent[0]!.headers[entry.key[0]]).toBe(entry.key[1]);
      expect(sent[0]!.redirect).toBe("manual");
      if (entry.provider === "anthropic") expect(sent[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    });
  }
});

test("lists keep usable ids once, with names only when they differ, sorted by name, at most 500", () => {
  const body = {
    data: [
      { id: "b-model", name: "b-model" },
      { id: "a-model", name: "  Alpha\n model " },
      { id: "a-model", name: "Repeat" },
      { id: "has space" },
      { id: 42 },
      "not an object",
      { id: "model-10" },
      { id: "model-9" },
    ],
  };
  expect(parseModelList("openrouter", body)).toEqual({
    models: [
      { id: "a-model", label: "Alpha model" },
      { id: "b-model", label: null },
      { id: "model-9", label: null },
      { id: "model-10", label: null },
    ],
    truncated: false,
  });
  expect(parseModelList("openai", { models: [] })).toBeNull();
  expect(parseModelList("google", { data: [] })).toBeNull();
  const many = parseModelList("openai", { data: Array.from({ length: MAX_LISTED_MODELS + 20 }, (_, i) => ({ id: `m-${i}` })) });
  expect(many!.models).toHaveLength(MAX_LISTED_MODELS);
  expect(many!.truncated).toBe(true);
});

test("redirects are refused, and requests can't leave the list's address", async () => {
  const { fetch } = fakeFetch(() => new Response(null, { status: 302, headers: { Location: "https://attacker.example.com/steal" } }));
  const failure = await fetchModelList(target("openai"), { fetch }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AiError);
  expect(failure).toMatchObject({ code: "network", message: "The provider answered with a redirect, which Critiqs doesn't follow." });
  // Plain HTTP only where the operator allowed local endpoints and the address passed that policy.
  const plain = await fetchModelList(target("compatible", "http://llm.example.com/v1"), { fetch }).catch((error: unknown) => error);
  expect(plain).toMatchObject({ code: "config", message: "Endpoints must use HTTPS." });
  // The Gateway lists its models only at its own address.
  expect(await fetchModelList(target("gateway", "https://llm.example.com/v1"), { fetch }).catch((error: unknown) => error)).toMatchObject({ code: "config" });
});

test("failures are sorted like connection tests and never repeat the provider's response", async () => {
  for (const [status, code] of [
    [401, "auth"],
    [403, "auth"],
    [404, "capability"],
    [429, "rate-limit"],
    [500, "network"],
    [400, "unknown"],
  ] as const) {
    const { fetch } = fakeFetch(() => Response.json({ error: { message: `bad key ${KEY}` } }, { status }));
    const failure = (await fetchModelList(target("openai"), { fetch }).catch((error: unknown) => error)) as AiError;
    expect(failure.code).toBe(code);
    expect(failure.message).not.toContain(KEY);
  }
  const broken = fakeFetch(() => new Response(`not json ${KEY}`));
  expect(await fetchModelList(target("openai"), { fetch: broken.fetch }).catch((error: unknown) => error)).toMatchObject({ code: "capability", message: expect.not.stringContaining(KEY) });
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
  expect(await fetchModelList(target("openai"), { fetch: offline }).catch((error: unknown) => error)).toMatchObject({ code: "network" });
});

test("an answer larger than the limit is refused, declared or not", async () => {
  const declared = fakeFetch(() => new Response("{}", { headers: { "content-length": String(MAX_MODEL_LIST_BYTES + 1) } }));
  expect(await fetchModelList(target("openai"), { fetch: declared.fetch }).catch((error: unknown) => error)).toMatchObject({ code: "capability", message: expect.stringContaining("too large") });
  const chunk = new Uint8Array(1024 * 1024).fill(32);
  const streamed = fakeFetch(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
      ),
  );
  expect(await fetchModelList(target("openai"), { fetch: streamed.fetch }).catch((error: unknown) => error)).toMatchObject({ code: "capability", message: expect.stringContaining("too large") });
});

test("an answer that breaks off or times out partway through is a network error", async () => {
  for (const failure of [new TypeError("terminated"), new DOMException("The operation timed out.", "TimeoutError")]) {
    const broken = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data": ['));
              controller.error(failure);
            },
          }),
        ),
    );
    const result = await fetchModelList(target("openai"), { fetch: broken.fetch }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AiError);
    expect(result).toMatchObject({ code: "network", message: "Critiqs couldn't reach the provider, or it didn't answer in time." });
  }
});

describe("what a list request uses", () => {
  const deployment: AiDeployment = {
    managed: null,
    defaultProvider: null,
    encryptionKey: "operator-encryption-key-".padEnd(48, "x"),
    endpoints: { allowed: ["https://llm.example.com/v1", "http://10.0.0.5/v1"], allowLocal: false },
  };

  async function saved(provider: AiProvider, baseUrl: string | null, apiKey: string): Promise<StoredConnection> {
    const prepared = await sealKey(await prepareSettings({ enabled: true, mode: "own", provider, model: "m", baseUrl, apiKey }, deployment), keyBinding("personal", "u1"), deployment);
    return { enabled: true, mode: "own", provider, model: "m", ...(prepared.baseUrl === null ? {} : { baseUrl: prepared.baseUrl }), secret: prepared.secret as StoredConnection["secret"], epoch: 1, updatedAt: 0 };
  }

  test("private, unlisted, and plain HTTP addresses are refused before any request", async () => {
    for (const baseUrl of ["https://10.0.0.5/v1", "http://10.0.0.5/v1", "https://localhost/v1", "https://other.example.com/v1", "https://user:pw@llm.example.com/v1"]) {
      expect(await modelListTarget("personal", "u1", null, { provider: "compatible", baseUrl }, deployment)).toMatchObject({ ok: false });
    }
    expect(await modelListTarget("personal", "u1", null, { provider: "compatible" }, deployment)).toEqual({ ok: false, reason: "Enter the endpoint's address." });
    // Allowed local endpoints may use HTTP, as the operator chose.
    expect(await modelListTarget("personal", "u1", null, { provider: "compatible", baseUrl: "http://10.0.0.5/v1" }, { ...deployment, endpoints: { ...deployment.endpoints, allowLocal: true } })).toMatchObject({
      ok: true,
      target: { baseUrl: "http://10.0.0.5/v1", allowHttp: true },
    });
  });

  test("a typed key is used as typed; a saved key only for its own provider and address, as its owner", async () => {
    const record = await saved("compatible", "https://llm.example.com/v1", "sk-saved-0001");
    expect(await modelListTarget("personal", "u1", record, { provider: "compatible", baseUrl: "https://llm.example.com/v1", apiKey: "sk-typed" }, deployment)).toMatchObject({ ok: true, target: { apiKey: "sk-typed" } });
    expect(await modelListTarget("personal", "u1", record, { provider: "compatible", baseUrl: "https://llm.example.com/v1/" }, deployment)).toMatchObject({ ok: true, target: { apiKey: "sk-saved-0001" } });
    expect(await modelListTarget("personal", "u1", record, undefined, deployment)).toMatchObject({ ok: true, target: { apiKey: "sk-saved-0001" } });
    // Another address, or another person, never gets the saved key.
    expect(await modelListTarget("personal", "u1", record, { provider: "compatible", baseUrl: "https://llm.example.com/v1/other" }, deployment)).toMatchObject({ ok: true, target: { apiKey: undefined } });
    expect(await modelListTarget("personal", "u2", record, undefined, deployment)).toMatchObject({ ok: false, reason: expect.stringContaining("can't be read") });
    expect(await modelListTarget("personal", "u1", record, { provider: "openai" }, deployment)).toEqual({ ok: false, reason: "Enter your OpenAI API key to list its models." });
    expect(await modelListTarget("personal", "u1", null, { provider: "openai", apiKey: "has space" }, deployment)).toEqual({ ok: false, reason: "That doesn't look like an API key." });
    expect(await modelListTarget("personal", "u1", { ...record, mode: "managed" }, undefined, deployment)).toEqual({ ok: false, reason: "Choose a provider first." });
  });
});
