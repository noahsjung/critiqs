import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CritiqsError } from "../src/errors.ts";
import { isCheckedAdapter, trackerEndpoint } from "../src/tickets/trackers/index.ts";
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

test("destinations a tracker sends keep only IDs Critiqs can use, with names cut", async () => {
  reply = () => Response.json({ data: { teams: { nodes: [{ id: "t".repeat(5_000), name: "Long ID", key: "L" }, { id: "t1", name: "N".repeat(5_000), key: "K".repeat(5_000) }] } } });
  const teams = await linearAdapter({ baseUrl: baseUrl() }).destinations(key);
  expect(teams.map((team) => team.id)).toEqual(["t1"]);
  expect(teams[0]!.name.length).toBeLessThanOrEqual(200);
  expect(teams[0]!.key!.length).toBeLessThanOrEqual(256);
});

test("every tracker Critiqs offers has its answers checked", async () => {
  const { TRACKER_ADAPTERS } = await import("../src/tickets/trackers/index.ts");
  expect(Object.keys(TRACKER_ADAPTERS).sort()).toEqual(["github", "jira", "linear"]);
  for (const [tracker, make] of Object.entries(TRACKER_ADAPTERS)) expect({ tracker, checked: isCheckedAdapter(make({})) }).toEqual({ tracker, checked: true });
});

test("an upload goes only to a public HTTPS address, with only the storage headers the tracker names, and its asset address must be a web address", async () => {
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const answers: Response[] = [];
  const recorder = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return answers.shift() ?? new Response(null, { status: 200 });
  }) as typeof fetch;
  const linear = linearAdapter({ baseUrl: "https://api.linear.test", fetch: recorder });
  const image = { data: new Blob([new Uint8Array([137, 80, 78, 71])]), contentType: "image/png", name: "c.png" };
  const upload = (uploadUrl: string, assetUrl: string) =>
    Response.json({
      data: {
        fileUpload: {
          success: true,
          uploadFile: {
            uploadUrl,
            assetUrl,
            headers: [
              { key: "x-goog-meta-id", value: "1" },
              { key: "X-Injected-Header", value: "pwned" },
              { key: "Authorization", value: "Bearer stolen" },
              { key: "Cookie", value: "a=b" },
            ],
          },
        },
      },
    });
  answers.push(upload("http://127.0.0.1:5731/internal", "https://uploads.linear.app/a"));
  expect((await refusal(linear.uploadImage!(key, image))).code).toBe("unavailable");
  expect(sent.map((each) => each.url)).toEqual(["https://api.linear.test/graphql"]);
  sent.length = 0;
  answers.push(upload("https://storage.example/put?sig=1", "https://uploads.linear.app/a"));
  expect((await linear.uploadImage!(key, image)) as string).toBe("https://uploads.linear.app/a");
  const put = sent[1]!;
  expect(put.url).toBe("https://storage.example/put?sig=1");
  expect(put.headers["x-goog-meta-id"]).toBe("1");
  expect(put.headers["x-injected-header"]).toBeUndefined();
  expect(put.headers.authorization).toBeUndefined();
  expect(put.headers.cookie).toBeUndefined();
  answers.push(upload("https://storage.example/put?sig=1", "javascript:alert(document.domain)"));
  expect((await refusal(linear.uploadImage!(key, image))).code).toBe("unavailable");
});

test("a request given as a Request never sends the person's token elsewhere, and keeps its own headers", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const record = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, headers: Object.fromEntries(request.headers) });
    return Response.json({});
  }) as typeof fetch;
  const endpoint = trackerEndpoint({ fetch: record, baseUrl: "http://127.0.0.1:9" }, "https://api.linear.app");
  // An address the tracker names elsewhere never gets the token or cookies, however the request was made.
  await endpoint.fetch(new Request("https://uploads.example.com/file", { method: "PUT", headers: { Authorization: "Bearer secret", Cookie: "a=b", "Content-Type": "image/png" }, body: "x" }));
  expect(seen[0]!.headers.authorization).toBeUndefined();
  expect(seen[0]!.headers.cookie).toBeUndefined();
  expect(seen[0]!.headers["content-type"]).toBe("image/png");
  // The tracker's own address gets the Request's headers.
  await endpoint.fetch(new Request("http://127.0.0.1:9/graphql", { method: "POST", headers: { "Content-Type": "application/json", "X-Critiqs-Test": "kept", Authorization: "Bearer secret" }, body: "{}" }));
  expect(seen[1]!.headers).toMatchObject({ "content-type": "application/json", "x-critiqs-test": "kept", authorization: "Bearer secret" });
  // Headers given with the call add to the Request's.
  await endpoint.fetch(new Request("http://127.0.0.1:9/graphql", { headers: { "X-Critiqs-Test": "request" } }), { headers: { "X-Other": "init" } });
  expect(seen[2]!.headers).toMatchObject({ "x-critiqs-test": "request", "x-other": "init" });
});

test("templates and labels a tracker sends keep only IDs Critiqs can use, with names cut and a template's text bounded", async () => {
  const team = { id: "t1", name: "Team", key: "T" };
  reply = () => Response.json({ data: { templateSearch: [{ id: "x".repeat(5_000), name: "Long ID", team }, { id: "tpl-1", name: "N".repeat(5_000), team }] } });
  const groups = await linearAdapter({ baseUrl: baseUrl() }).templates!(key);
  expect(groups.flatMap((group) => group.templates.map((template) => template.id))).toEqual(["tpl-1"]);
  expect(groups[0]!.templates[0]!.name.length).toBeLessThanOrEqual(200);
  reply = () => Response.json({ data: { templateSearch: [{ id: "tpl-1", name: "Bug", team, content: "x".repeat(60_000) }] } });
  expect((await refusal(linearAdapter({ baseUrl: baseUrl() }).template!(key, "tpl-1"))).code).toBe("unavailable");
  reply = () => Response.json({ data: { issueLabels: { nodes: [{ id: "l".repeat(5_000), name: "Long ID" }, { id: "label-1", name: "B".repeat(5_000), parent: { id: "g".repeat(5_000), groupType: null } }] } } });
  const labels = await linearAdapter({ baseUrl: baseUrl() }).labels!(key, "t1");
  expect(labels.map((label) => label.id)).toEqual(["label-1"]);
  expect(labels[0]!.name.length).toBeLessThanOrEqual(200);
  expect(labels[0]!.exclusiveGroup).toBeNull();
});
