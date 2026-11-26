import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CritiqsError } from "../src/errors.ts";
import { isCheckedAdapter } from "../src/tickets/trackers/index.ts";
import { linearAdapter } from "../src/tickets/trackers/linear.ts";

// Everything a tracker answers is outside Critiqs's control: a broken or
// hostile tracker (or a stand-in for one) must not make Critiqs read without
// limit, wait forever, follow it elsewhere, or keep text of any length.
// Adapters call trackers only through the endpoint Critiqs gives them, which
// enforces this for every adapter (`trackerEndpoint` in trackers/index.ts).

let reply: () => Response = () => Response.json({});
const elsewhere: string[] = [];
let tracker: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  tracker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => reply() });
  other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      elsewhere.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get("Authorization")}`);
      return Response.json({ data: { viewer: { id: "u", name: "Elsewhere", email: null }, organization: null } });
    },
  });
});
afterAll(() => {
  tracker.stop(true);
  other.stop(true);
});

const key = { method: "token" as const, value: "lin_api_secret" };
const baseUrl = () => `http://127.0.0.1:${tracker.port}`;
const viewer = (name: string) => ({ data: { viewer: { id: "user-1", name, email: null }, organization: { id: "org-1", name } } });

async function refusal(promise: Promise<unknown>): Promise<CritiqsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CritiqsError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

test("an answer larger than Critiqs reads is refused, not read whole", async () => {
  reply = () => Response.json({ ...viewer("Dana"), padding: "x".repeat(3 * 1024 * 1024) });
  expect((await refusal(linearAdapter({ baseUrl: baseUrl() }).verify(key))).code).toBe("unavailable");
});

test("a tracker that doesn't answer is given up on", async () => {
  const silent = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const started = Date.now();
  expect((await refusal(linearAdapter({ baseUrl: baseUrl(), fetch: silent, timeoutMs: 200 } as Parameters<typeof linearAdapter>[0]).verify(key))).code).toBe("unavailable");
  expect(Date.now() - started).toBeLessThan(2_000);
}, 3_000);

test("a tracker's redirect isn't followed, so the person's token never goes elsewhere", async () => {
  reply = () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${other.port}/graphql` } });
  elsewhere.length = 0;
  expect((await refusal(linearAdapter({ baseUrl: baseUrl() }).verify(key))).code).toBe("unavailable");
  expect(elsewhere).toEqual([]);
});

test("names a tracker sends are cut to a length Critiqs shows", async () => {
  reply = () => Response.json(viewer("D".repeat(10_000)));
  const identity = await linearAdapter({ baseUrl: baseUrl() }).verify(key);
  expect(identity.accountName.length).toBeLessThanOrEqual(200);
  expect(identity.site!.name.length).toBeLessThanOrEqual(200);
});

test("every tracker's adapter has its answers checked", () => {
  expect(isCheckedAdapter(linearAdapter())).toBe(true);
});

test("adapters call trackers only through the endpoint Critiqs gives them", () => {
  const folder = join(import.meta.dir, "../src/tickets/trackers");
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".ts") && name !== "index.ts")) {
    const source = readFileSync(join(folder, file), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
    // `to.fetch(...)` is the endpoint's; a bare `fetch` or `globalThis` would bypass its limits and address checks.
    const bare = [...source.matchAll(/(?<![.\w])(fetch|globalThis|XMLHttpRequest|WebSocket)\b/g)].map((match) => match[0]);
    expect({ file, bare }).toEqual({ file, bare: [] });
  }
});
