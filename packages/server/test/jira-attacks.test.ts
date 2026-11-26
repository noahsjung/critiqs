import { afterAll, beforeAll, expect, test } from "bun:test";
import * as jiraModule from "../src/tickets/trackers/jira.ts";
import { markdownToAdf } from "../src/tickets/trackers/adf.ts";
import { addJiraIssue, adfText, jiraStandIn } from "./jira-standin.ts";

// The attacks the security reviews of the Linear tickets port made, against
// Jira's adapter: a hostile or broken Jira or Atlassian (answers too long,
// too large, redirects, silence, sites on private hosts), and hostile people
// (text with links and escapes that must reach Jira's document format as
// text, search words and destinations that would change JQL). Each test
// names what it guards.

const { jiraAdapter, readJiraWebhook } = jiraModule;
type Adapter = ReturnType<typeof jiraAdapter>;
type Endpoint = Parameters<typeof jiraAdapter>[0];
const ORIGIN = "https://jira.test";
/** Ticket text and addresses as Critiqs makes them; plain strings at run time. */
const md = <T>(value: string) => value as unknown as T;

/** Jira's adapter against the stand-in, recording every address it calls. */
function recorded() {
  const standIn = jiraStandIn();
  const sent: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input, init).url);
    return await standIn.fetchFn(input, init);
  }) as typeof fetch;
  const jira: Adapter = jiraAdapter({ fetch: fetchFn, baseUrl: ORIGIN, sitesUrl: ORIGIN } as Endpoint);
  const site = { id: standIn.site.cloudId, name: standIn.site.host };
  const pasted = { method: "token" as const, value: "dana@example.com:ATATT-dana-token", site };
  return { standIn, sent, jira, site, pasted };
}

async function outcome<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

const create = (jira: Adapter, token: Parameters<Adapter["create"]>[0], overrides: Record<string, unknown> = {}) =>
  jira.create(token, { destinationId: "10001/10010", title: "Department label is wrong", body: md("Text\n"), labels: [], templateId: null, creationId: crypto.randomUUID(), ...overrides } as Parameters<Adapter["create"]>[1]);

/** Every link a document carries, and its whole text. */
function linksOf(document: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    const record = node as { marks?: { type: string; attrs?: { href?: string } }[]; content?: unknown[] };
    for (const mark of record.marks ?? []) if (mark.type === "link") found.push(mark.attrs?.href ?? "");
    for (const child of record.content ?? []) walk(child);
  };
  walk(document);
  return found;
}

// A server that plays a hostile Jira site over HTTP, and one that should never be reached.
let hostile: ReturnType<typeof Bun.serve>;
let elsewhere: ReturnType<typeof Bun.serve>;
let reply: (request: Request) => Response | Promise<Response> = () => new Response(null, { status: 404 });
const reached: Request[] = [];
beforeAll(() => {
  hostile = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => reply(request) });
  elsewhere = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      reached.push(request);
      return Response.json({ accountId: "stolen", displayName: "x" });
    },
  });
});
afterAll(() => {
  hostile.stop(true);
  elsewhere.stop(true);
});
/** Jira's adapter whose sites are on the hostile server, with a pasted token for acme. */
const hostileJira = (options: { timeoutMs?: number } = {}) => {
  const base = `http://127.0.0.1:${hostile.port}`;
  return {
    jira: jiraAdapter({ baseUrl: base, sitesUrl: base, ...options } as Endpoint),
    token: { method: "token" as const, value: "dana@example.com:ATATT", site: { id: "cloud-1", name: "acme.atlassian.net" } },
  };
};

test("Jira attack: an over-long key, summary, or status name in an issue is cut to what Critiqs shows", async () => {
  const { standIn, jira, pasted } = recorded();
  standIn.intercept = (method, path) =>
    method === "GET" && /\/rest\/api\/3\/issue\/\d+$/.test(path)
      ? Response.json({ id: "10500", key: `WEB-${"9".repeat(300)}`, fields: { summary: "S".repeat(5_000), status: { name: "N".repeat(100_000), statusCategory: { key: "new" } }, updated: "2026-01-01T00:00:00.000+0000", project: { id: "10001" } } })
      : undefined;
  const made = await create(jira, pasted);
  expect(made.status).toBe("created");
  if (made.status !== "created") return;
  expect(made.ticket.key.length).toBeLessThanOrEqual(256);
  expect(made.ticket.title.length).toBeLessThanOrEqual(255);
  expect(made.ticket.status.label.length).toBeLessThanOrEqual(100);
});

test("Jira attack: an issue key can't make the ticket's address anything but the site's own page", async () => {
  const { standIn, jira, pasted } = recorded();
  standIn.intercept = (method, path) =>
    method === "GET" && /\/rest\/api\/3\/issue\/\d+$/.test(path)
      ? Response.json({ id: "10500", key: "@evil.example/x", fields: { summary: "x", status: { name: "To Do", statusCategory: { key: "new" } }, updated: "2026-01-01T00:00:00.000+0000" } })
      : undefined;
  const made = await create(jira, pasted);
  expect(made.status === "created" ? new URL(made.ticket.url).host : "not created").toBe("acme.atlassian.net");
});

test("Jira attack: a site that isn't one of Atlassian's cloud hosts never gets a request, or the token", async () => {
  const { sent, jira } = recorded();
  for (const name of ["169.254.169.254", "localhost", "127.0.0.1", "acme.atlassian.net.evil.test", "evil.test/acme.atlassian.net"]) {
    sent.length = 0;
    const token = { method: "token" as const, value: "dana@example.com:ATATT-dana-token", site: { id: "cloud-1", name } };
    await outcome(jira.verify(token));
    await outcome(jira.search(token, "words"));
    await outcome(jira.attachImage!(token, { tracker: "jira", externalId: "cloud-1/10001", key: "WEB-1", url: md("https://acme.atlassian.net/browse/WEB-1"), title: "t" } as never, { data: new Blob([new Uint8Array([1])]), contentType: "image/png", name: "c.png" }));
    expect({ name, sent: sent.filter((url) => url.includes(name.split("/")[0]!)) }).toEqual({ name, sent: [] });
  }
});

test("Jira attack: a sign-in's accessible resources can't name a private host as the person's site", async () => {
  const standIn = jiraStandIn();
  standIn.intercept = (method, path) => (method === "GET" && path === "/oauth/token/accessible-resources" ? Response.json([{ id: "cloud-evil", url: "https://127.0.0.1", scopes: ["read:jira-work"], name: "evil" }]) : undefined);
  const lookup = (jiraModule as Record<string, unknown>).jiraSignInSite as undefined | ((endpoint: unknown, token: string, chosen: string) => Promise<unknown>);
  const old = (jiraModule as Record<string, unknown>).jiraSignInSites as undefined | ((endpoint: unknown, token: string) => Promise<{ name: string }[]>);
  const found = lookup !== undefined ? await outcome(lookup({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, "token", "127.0.0.1")) : { ok: true, value: (await old!({ fetch: standIn.fetchFn, baseUrl: ORIGIN }, "token")).find((site) => site.name === "127.0.0.1") };
  expect(found.ok && found.value !== undefined).toBe(false);
});

test("Jira attack: a redirect isn't followed, so the person's token never reaches another address", async () => {
  reached.length = 0;
  reply = () => new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${elsewhere.port}/rest/api/3/myself` } });
  const { jira, token } = hostileJira();
  await outcome(jira.search(token, "words"));
  expect(reached).toHaveLength(0);
});

test("Jira attack: an answer larger than Critiqs reads is refused, not read whole", async () => {
  reply = () => Response.json({ issues: [], padding: "a".repeat(3 * 1024 * 1024) });
  const { jira, token } = hostileJira();
  expect((await outcome(jira.search(token, "words"))).ok).toBe(false);
});

test("Jira attack: a Jira that doesn't answer is given up on", async () => {
  reply = () => new Promise<Response>(() => undefined);
  const { jira, token } = hostileJira({ timeoutMs: 200 });
  const read = await Promise.race([outcome(jira.search(token, "words")), new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3_000))]);
  expect(read === "hung" ? "hung" : read.ok).toBe(false);
});

test("Jira attack: an over-long display name is cut, and required fields' names and options are bounded", async () => {
  const { standIn, jira, pasted } = recorded();
  standIn.intercept = (method, path) => {
    if (method === "GET" && path.endsWith("/rest/api/3/myself")) return Response.json({ accountId: "557058:dana", displayName: "D".repeat(1_000), emailAddress: "dana@example.com" });
    if (method === "GET" && path.includes("/rest/api/3/issue/createmeta/10001/issuetypes/10010")) {
      return Response.json({ fields: [{ fieldId: "customfield_1", name: "F".repeat(5_000), required: true, schema: { type: "option" }, allowedValues: Array.from({ length: 2_000 }, (_, index) => ({ id: String(index), value: "V".repeat(1_000) })) }] });
    }
    return undefined;
  };
  const identity = await jira.verify(pasted);
  expect(identity.accountName.length).toBeLessThanOrEqual(200);
  const required = await jira.requiredFields!(pasted, "10001/10010");
  for (const field of required.fields) {
    expect(field.name.length).toBeLessThanOrEqual(200);
    expect(field.options.length).toBeLessThanOrEqual(500);
    for (const option of field.options) expect(option.name.length).toBeLessThanOrEqual(200);
  }
});

test("Jira attack: escaped Markdown, script and credential addresses, and HTML in ticket text reach Jira's document as text, never as links", () => {
  const text = "\\[Admin\\]\\(https://evil.example\\) [x](javascript:alert(1)) [y](https://user:pass@evil.example/) <img src=x onerror=alert(1)> <https://ok.example/a>\n";
  const document = markdownToAdf(md(text));
  expect(linksOf(document)).toEqual(["https://ok.example/a"]);
  expect(adfText(document)).toContain("[Admin](https://evil.example)");
  expect(adfText(document)).toContain("<img src=x onerror=alert(1)>");
});

test("Jira attack: words and a project a person names can't change the search's JQL", async () => {
  const { standIn, jira, pasted } = recorded();
  const bodies: unknown[] = [];
  standIn.intercept = (method, path, body) => {
    if (path.endsWith("/rest/api/3/search/jql")) bodies.push(body);
    return undefined;
  };
  await jira.search(pasted, 'x" OR project = "OPS" ORDER BY created');
  const refused = await outcome(jira.search(pasted, "words", "10001 OR project = 10002/10010"));
  expect(refused.ok).toBe(false);
  const jql = bodies.map((body) => (body as { jql: string }).jql);
  expect(jql).toHaveLength(1);
  expect(jql[0]).toMatch(/^text ~ "[^"]*" ORDER BY updated DESC$/);
});

test("Jira attack: a delivery that matches a hundred webhooks, or names no issue address, isn't used", async () => {
  const { standIn } = recorded();
  const issue = addJiraIssue(standIn, { summary: "Hooked" });
  const { jiraIssueWebhook } = await import("./jira-standin.ts");
  const many = await jiraIssueWebhook(standIn, { event: "jira:issue_updated", issueId: issue.id, webhookIds: Array.from({ length: 100 }, (_, index) => index), sentAt: Date.now() });
  const read = await readJiraWebhook("jira-standin-client-secret", new TextEncoder().encode(many.body), many.headers.Authorization!, Date.now());
  expect(read.status).toBe("ignored");
});
