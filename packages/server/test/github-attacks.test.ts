import { afterAll, beforeAll, expect, test } from "bun:test";
import { githubAdapter, readGithubWebhook } from "../src/tickets/trackers/github.ts";
import { addGithubIssue, githubIssueWebhook, githubStandIn } from "./github-standin.ts";

// The attacks the security reviews of the Linear tickets port made, against
// GitHub's adapter: a hostile or broken GitHub (answers too long, too large,
// addresses that aren't web addresses, redirects, silence), and hostile
// people (text that would end the creation's mark, or search words and
// repositories that would add qualifiers). Each test names what it guards.

type Adapter = ReturnType<typeof githubAdapter>;
type Endpoint = Parameters<typeof githubAdapter>[0];
const PAT = { method: "token" as const, value: "github_pat_dana" };
/** Ticket text and addresses as Critiqs makes them; plain strings at run time. */
const md = <T>(value: string) => value as unknown as T;

/** A request GitHub's adapter sent: its address, and its token if any. */
interface Sent {
  url: string;
  authorization: string | null;
}

/** GitHub's adapter against the stand-in, recording every address it calls. */
function recorded(options: { timeoutMs?: number } = {}) {
  const standIn = githubStandIn();
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, authorization: request.headers.get("Authorization") });
    return await standIn.fetchFn(input, init);
  }) as typeof fetch;
  const github: Adapter = githubAdapter({ fetch: fetchFn, baseUrl: standIn.origin, ...options } as Endpoint);
  return { standIn, sent, github };
}

async function outcome<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

const issueJson = (overrides: Record<string, unknown>) => ({
  id: 77,
  node_id: "I_hostile",
  number: 1,
  title: "Fine",
  state: "open",
  state_reason: null,
  html_url: "https://github.com/acme/web/issues/1",
  updated_at: "2026-01-01T00:00:00Z",
  body: "",
  ...overrides,
});

const create = (github: Adapter, overrides: Record<string, unknown> = {}) =>
  github.create(PAT, {
    destinationId: "acme/web",
    title: "Department label is unclear",
    body: md("> The label is unclear.\n"),
    labels: [],
    templateId: null,
    creationId: "6f1c2b9a-3d4e-4f50-8a1b-2c3d4e5f6a7b",
    ...overrides,
  } as Parameters<Adapter["create"]>[1]);

// A server that plays a hostile GitHub over HTTP, and one that should never be reached.
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
      return Response.json({ id: 1, login: "stolen" });
    },
  });
});
afterAll(() => {
  hostile.stop(true);
  elsewhere.stop(true);
});
const hostileGithub = (options: { timeoutMs?: number } = {}) => githubAdapter({ baseUrl: `http://127.0.0.1:${hostile.port}`, ...options } as Endpoint);

test("GitHub attack: an over-long title in a created issue is cut to what Critiqs shows", async () => {
  const { standIn, github } = recorded();
  standIn.intercept = (method, path) => (method === "POST" && path === "/repos/acme/web/issues" ? Response.json(issueJson({ title: "T".repeat(5_000) }), { status: 201 }) : undefined);
  const made = await create(github);
  expect(made.status).toBe("created");
  if (made.status === "created") expect(made.ticket.title.length).toBeLessThanOrEqual(255);
});

test("GitHub attack: an issue whose repository name is over-long is never kept with a key past 256 characters", async () => {
  const { standIn, github } = recorded();
  const name = "w".repeat(300);
  standIn.intercept = (method, path) =>
    method === "POST" && path === "/graphql"
      ? Response.json({
          data: {
            node: { __typename: "Issue", id: "I_long", number: 1, title: "x", url: "https://github.com/acme/web/issues/1", state: "OPEN", stateReason: null, updatedAt: "2026-01-01T00:00:00Z", repository: { name, nameWithOwner: `acme/${name}` } },
          },
        })
      : undefined;
  const read = await outcome(github.get(PAT, "I_long"));
  expect(!read.ok || read.value.key.length <= 256).toBe(true);
});

test("GitHub attack: an issue address that isn't a web address is never kept as the ticket's link", async () => {
  const { standIn, github } = recorded();
  standIn.intercept = (method, path) => (method === "POST" && path === "/repos/acme/web/issues" ? Response.json(issueJson({ html_url: "javascript:alert(document.domain)" }), { status: 201 }) : undefined);
  const made = await create(github);
  expect(String(made.status === "created" ? made.ticket.url : null)).not.toContain("javascript:");
  standIn.intercept = (method, path) =>
    method === "GET" && path === "/search/issues"
      ? Response.json({ items: [issueJson({ html_url: "javascript:alert(1)", repository_url: `${standIn.origin}/repos/acme/web` })] })
      : undefined;
  expect((await github.search(PAT, "label")).map((ticket) => ticket.url)).toEqual([]);
});

test("GitHub attack: the issue address a ticket carries is never called; every request goes to GitHub's own address", async () => {
  const { standIn, sent, github } = recorded();
  const existing = addGithubIssue(standIn, "acme/web", { number: 7, title: "Existing" });
  const ref = { tracker: "github" as const, externalId: existing.nodeId, key: "web#7", url: md<string>("https://169.254.169.254/acme/web/issues/7"), title: "Existing", site: "acme/web" };
  // An address that isn't GitHub's page for the issue: nothing is written, and nothing is called.
  expect((await outcome(github.linkBack(PAT, ref, { url: md("https://review.example/?critiqs=t1"), title: "t" }))).ok).toBe(false);
  expect((await outcome(github.comment(PAT, ref, md("> Summary\n")))).ok).toBe(false);
  expect(sent).toEqual([]);
  // GitHub's own page for it: written, at GitHub's own address.
  const held = { ...ref, url: md<string>(`${standIn.origin}/acme/web/issues/7`) };
  await github.linkBack(PAT, held, { url: md("https://review.example/?critiqs=t1"), title: "t" });
  await github.comment(PAT, held, md("> Summary\n"));
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.filter((request) => !request.url.startsWith(standIn.origin))).toEqual([]);
});

test("GitHub attack: a write goes to the issue Critiqs holds, by its repository and number, never to one an address names", async () => {
  const { standIn, sent, github } = recorded();
  const mine = addGithubIssue(standIn, "acme/web", { number: 7, title: "Mine" });
  const other = addGithubIssue(standIn, "acme/api", { number: 9, title: "Someone else's" });
  // Held as issue 7 in acme/web, but its address names acme/api#9, which the person's token can also write to.
  const crossed = { tracker: "github" as const, externalId: mine.nodeId, key: "web#7", url: md<string>(`${standIn.origin}/acme/api/issues/9`), title: "Mine", site: "acme/web" };
  expect((await outcome(github.linkBack(PAT, crossed, { url: md("https://review.example/?critiqs=t1"), title: "Department is wrong" }))).ok).toBe(false);
  expect((await outcome(github.comment(PAT, crossed, md("> Summary\n")))).ok).toBe(false);
  expect(standIn.comments.filter((comment) => comment.issueNodeId === other.nodeId)).toEqual([]);
  expect(sent).toEqual([]);
  // Held consistently: the comment lands on issue 7, as its repository and number say.
  await github.comment(PAT, { ...crossed, url: md<string>(`${standIn.origin}/acme/web/issues/7`) }, md("> Summary\n"));
  expect(standIn.comments.map((comment) => comment.issueNodeId)).toEqual([mine.nodeId]);
});

test("GitHub attack: an answer about another issue than the one asked for, or whose address isn't GitHub's page for it, is refused", async () => {
  const { standIn, github } = recorded();
  const mine = addGithubIssue(standIn, "acme/web", { number: 7, title: "Mine" });
  const node = (overrides: Record<string, unknown>) =>
    Response.json({
      data: {
        node: { __typename: "Issue", id: mine.nodeId, number: 7, title: "Mine", url: `${standIn.origin}/acme/web/issues/7`, state: "OPEN", stateReason: null, updatedAt: "2026-01-01T00:00:00Z", repository: { name: "web", nameWithOwner: "acme/web" }, ...overrides },
      },
    });
  let answer = node({ id: "I_someone_else", repository: { name: "secret", nameWithOwner: "acme/secret" }, number: 9, url: `${standIn.origin}/acme/secret/issues/9` });
  standIn.intercept = (method, path) => (method === "POST" && path === "/graphql" ? answer : undefined);
  expect((await outcome(github.get(PAT, mine.nodeId))).ok).toBe(false);
  const held = { tracker: "github" as const, externalId: mine.nodeId, key: "web#7", url: `${standIn.origin}/acme/web/issues/7`, title: "Mine", site: "acme/web" };
  answer = node({ id: "I_someone_else" });
  expect((await outcome(github.status(PAT, held))).ok).toBe(false);
  // The right node, but an address on another repository, another number, or another host.
  for (const url of [`${standIn.origin}/acme/secret/issues/7`, `${standIn.origin}/acme/web/issues/8`, "https://evil.example/acme/web/issues/7"]) {
    answer = node({ url });
    expect((await outcome(github.get(PAT, mine.nodeId))).ok).toBe(false);
  }
  answer = node({});
  expect((await github.get(PAT, mine.nodeId)).url).toBe(`${standIn.origin}/acme/web/issues/7`);
  // A created issue whose page is in another repository isn't kept as the one created.
  standIn.intercept = (method, path) =>
    method === "POST" && path === "/repos/acme/web/issues" ? Response.json(issueJson({ number: 1, html_url: `${standIn.origin}/acme/secret/issues/1` }), { status: 201 }) : undefined;
  expect((await create(github)).status).toBe("unknown");
  // A search result whose page doesn't match its repository and number is left out.
  standIn.intercept = (method, path) =>
    method === "GET" && path === "/search/issues"
      ? Response.json({ items: [issueJson({ number: 3, html_url: `${standIn.origin}/acme/secret/issues/3`, repository_url: `${standIn.origin}/repos/acme/web` })] })
      : undefined;
  expect(await github.search(PAT, "label")).toEqual([]);
});

test("GitHub attack: a redirect isn't followed, so the person's token never reaches another address", async () => {
  reached.length = 0;
  reply = () => new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${elsewhere.port}/user` } });
  const read = await outcome(hostileGithub().verify(PAT));
  expect(read.ok).toBe(false);
  expect(reached).toHaveLength(0);
});

test("GitHub attack: an answer larger than Critiqs reads is refused, not read whole", async () => {
  reply = () => Response.json({ id: 1, login: "dana", padding: "a".repeat(3 * 1024 * 1024) });
  const read = await outcome(hostileGithub().verify(PAT));
  expect(read.ok).toBe(false);
});

test("GitHub attack: a GitHub that doesn't answer is given up on", async () => {
  reply = () => new Promise<Response>(() => undefined);
  const started = Date.now();
  const read = await Promise.race([outcome(hostileGithub({ timeoutMs: 200 }).verify(PAT)), new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3_000))]);
  expect(read === "hung" ? "hung" : read.ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(3_000);
});

test("GitHub attack: an over-long login is cut, and only a few verified emails are compared", async () => {
  reply = (request) =>
    new URL(request.url).pathname === "/user/emails"
      ? Response.json(Array.from({ length: 500 }, (_, index) => ({ email: `a${index}@example.com`, verified: true, primary: index === 0 })))
      : Response.json({ id: 1, login: "L".repeat(1_000) });
  const identity = await hostileGithub().verify({ method: "oauth", value: "ghu_x" });
  expect(identity.accountName.length).toBeLessThanOrEqual(200);
  expect(identity.emails.length).toBeLessThanOrEqual(20);
});

test("GitHub attack: a template file's text past what a ticket holds is refused, and its name is cut", async () => {
  const { standIn, github } = recorded();
  const big = `---\nname: ${"N".repeat(5_000)}\n---\n${"x".repeat(60_000)}`;
  standIn.intercept = (method, path) => (method === "GET" && path === "/repos/acme/web/contents/.github/ISSUE_TEMPLATE/big.md" ? new Response(big, { headers: { "Content-Type": "text/plain" } }) : undefined);
  const read = await outcome(github.template!(PAT, "acme/web:big.md"));
  expect(read.ok && read.value !== null && read.value.body.length > 50_000).toBe(false);
  standIn.intercept = (method, path) =>
    method === "GET" && path === "/repos/acme/web/contents/.github/ISSUE_TEMPLATE"
      ? Response.json([{ type: "file", name: "long.md" }])
      : method === "GET" && path === "/repos/acme/web/contents/.github/ISSUE_TEMPLATE/long.md"
        ? new Response(`---\nname: ${"N".repeat(5_000)}\n---\nbody`)
        : undefined;
  const groups = await github.templates!(PAT, "acme/web");
  for (const group of groups) for (const template of group.templates) expect(template.name.length).toBeLessThanOrEqual(200);
});

test("GitHub attack: a creation ID can't end the creation's mark and put HTML or links in the issue", async () => {
  const { standIn, github } = recorded();
  const made = await outcome(create(github, { creationId: "x --> <img src=x onerror=alert(1)> [Admin](https://evil.example) <!-- y" }));
  const body = standIn.issues[0]?.body ?? "";
  const rendered = Bun.markdown.html(body);
  expect({ img: rendered.includes("<img"), link: rendered.includes("evil.example") }).toEqual({ img: false, link: false });
  expect(made.ok).toBe(true);
});

test("GitHub attack: a repository a person names can't add search qualifiers", async () => {
  const { sent, github } = recorded();
  await outcome(github.search(PAT, "label", "acme/web is:pr repo:other/secret"));
  const q = sent.map((request) => new URL(request.url).searchParams.get("q")).filter((value) => value !== null);
  expect(q.filter((value) => value!.includes("other/secret") || value!.includes("is:pr"))).toEqual([]);
});

test("GitHub attack: search words can't become qualifiers or operators", async () => {
  const { sent, github } = recorded();
  await github.search(PAT, 'label repo:other/secret OR "x" is:pr \\');
  const [q] = sent.map((request) => new URL(request.url).searchParams.get("q")).filter((value) => value !== null);
  expect(q).toContain('"repo:other/secret"');
  expect(q).not.toMatch(/(^|\s)repo:other/);
  expect(q).not.toMatch(/(^|\s)is:pr/);
});

test("GitHub attack: a signed delivery about another repository names that repository, so it reaches no link in this one", async () => {
  const secret = "s";
  const other = await githubIssueWebhook(secret, { action: "closed", issue: { nodeId: "I_1", state: "closed", updatedAt: "2026-03-01T10:00:00Z" }, repository: "other/web" } as never);
  const read = await readGithubWebhook(secret, new Uint8Array(new TextEncoder().encode(other.body)), other.headers["X-Hub-Signature-256"]!, "issues");
  expect(read.status === "update" ? read.update.site : "ignored").not.toBeNull();
  expect(read.status === "update" ? read.update.site : "ignored").not.toBe("acme/web");
});
