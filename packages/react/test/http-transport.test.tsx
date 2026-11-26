import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Deployment } from "../src/deployment.ts";
import { CookieSession } from "../src/http/session.ts";
import { httpTransport } from "../src/http/transport.tsx";
import { CritiqsRequestError, type CritiqsTransport } from "../src/transport.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const deployment: Deployment = {
  backendUrl: "http://localhost/critiqs",
  siteUrl: "http://localhost/critiqs",
  signInUrl: "http://localhost/critiqs",
  transport: "http",
  signIn: "email",
};

/** A fake server in the host app: counts changes and keeps threads. */
function fakeServer() {
  const calls: { url: string; init?: RequestInit }[] = [];
  let version = 1;
  const threads: { _id: string }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/me")) return Response.json({ reviewer: { id: "u1", name: "Dana", email: "d@example.com", pictureUrl: null } });
    if (url.endsWith("/changes")) return Response.json({ version });
    if (url.endsWith("/api/threads")) return Response.json({ value: [...threads] });
    if (url.endsWith("/api/remove")) return Response.json({ error: { code: "not-found", message: "This thread does not exist." } }, { status: 404 });
    if (url.endsWith("/api/createThread")) {
      threads.push({ _id: `t${threads.length + 1}` });
      version++;
      return Response.json({ value: `t${threads.length}` });
    }
    return Response.json({ error: { code: "not-found", message: "Unknown request." } }, { status: 404 });
  };
  return { calls, fetchFn, addElsewhere: () => (threads.push({ _id: `t${threads.length + 1}` }), version++) };
}

function Threads({ transport, onState }: { transport: CritiqsTransport; onState: (count: number | null) => void }) {
  const state = transport.useThreads("p1");
  onState(state.status === "ready" ? state.data.length : null);
  return null;
}

test("calls carry the request header, report Critiqs's errors, and reload what's shown after a change", async () => {
  const server = fakeServer();
  const session = new CookieSession(deployment.backendUrl, "email", server.fetchFn);
  const transport = httpTransport(deployment, session, server.fetchFn);
  const shown = { count: null as number | null };
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Threads transport={transport} onState={(value) => (shown.count = value)} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(shown.count).toBe(0);
  await act(async () => void (await transport.createThread({} as never)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(shown.count).toBe(1);
  const call = server.calls.find((entry) => entry.url.endsWith("/api/createThread"))!;
  expect(new Headers(call.init?.headers).get("X-Critiqs-Request")).toBe("1");
  expect(call.init?.credentials).toBe("same-origin");
  const failure = await transport.remove("t9").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CritiqsRequestError);
  expect((failure as CritiqsRequestError).code).toBe("not-found");
  await act(async () => root.unmount());
});

test("someone else's change shows on the next check", async () => {
  const server = fakeServer();
  const session = new CookieSession(deployment.backendUrl, "email", server.fetchFn);
  const transport = httpTransport(deployment, session, server.fetchFn);
  const shown = { count: null as number | null };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Threads transport={transport} onState={(value) => (shown.count = value)} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  server.addElsewhere();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 3300)));
  expect(shown.count).toBe(1);
  expect(session.getSnapshot().reviewer?.name).toBe("Dana");
  await act(async () => root.unmount());
});

function Suggestions({ transport, threadId }: { transport: CritiqsTransport; threadId: string | null }) {
  transport.useParticipants("p1", "", threadId);
  return null;
}

test("mention suggestions name the thread being replied in, only to a backend that takes it", async () => {
  for (const threadMentions of [true, false]) {
    const server = fakeServer();
    const session = new CookieSession(deployment.backendUrl, "email", server.fetchFn);
    const transport = httpTransport({ ...deployment, threadMentions }, session, server.fetchFn);
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<><Suggestions transport={transport} threadId="t1" /><Suggestions transport={transport} threadId={null} /></>));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const asked = server.calls.filter((call) => call.url.endsWith("/api/participants")).map((call) => JSON.parse(String(call.init?.body)));
    expect(asked).toContainEqual({ projectId: "p1", query: "" });
    expect(asked.some((args) => args.threadId === "t1")).toBe(threadMentions);
    await act(async () => root.unmount());
  }
});

test("with the app's own sign-in, Critiqs's sign-in explains where to sign in", async () => {
  const session = new CookieSession(deployment.backendUrl, "host", fakeServer().fetchFn);
  await expect(session.signIn()).rejects.toThrow("Sign in to this app to comment.");
});

test("a query that failed loads again once the server answers, even if nothing changed", async () => {
  const server = fakeServer();
  let down = true;
  const flaky = async (url: string, init?: RequestInit) =>
    down && url.endsWith("/api/threads") ? Response.json({ error: { code: "error", message: "Offline" } }, { status: 503 }) : server.fetchFn(url, init);
  const session = new CookieSession(deployment.backendUrl, "email", flaky);
  const transport = httpTransport(deployment, session, flaky);
  const shown = { count: null as number | null };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Threads transport={transport} onState={(value) => (shown.count = value)} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(shown.count).toBeNull();
  down = false;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 3300)));
  expect(shown.count).toBe(0);
  await act(async () => root.unmount());
});

test("the first change check reloads what loaded before it", async () => {
  const server = fakeServer();
  // Someone adds a thread after the list loaded but before the first check answers.
  let listed!: () => void;
  const listLoaded = new Promise<void>((resolve) => (listed = resolve));
  let checks = 0;
  const racing = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/changes") && checks++ === 0) {
      await listLoaded;
      server.addElsewhere();
    }
    const response = await server.fetchFn(url, init);
    if (url.endsWith("/api/threads")) listed();
    return response;
  };
  const session = new CookieSession(deployment.backendUrl, "email", racing);
  // Already signed in, as when the component loads the session first.
  await session.refresh();
  const transport = httpTransport(deployment, session, racing);
  const shown = { count: null as number | null };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Threads transport={transport} onState={(value) => (shown.count = value)} />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(shown.count).toBe(1);
  await act(async () => root.unmount());
});

test("Your AI's calls use the server's names and arguments", async () => {
  const sent: { name: string; body: unknown }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/changes")) return Response.json({ version: 1 });
    const name = url.slice(url.lastIndexOf("/") + 1);
    sent.push({ name, body: JSON.parse(String(init?.body ?? "null")) });
    return Response.json({ value: { ok: true, message: "Connected" } });
  };
  const transport = httpTransport(deployment, new CookieSession(deployment.backendUrl, "email", fetchFn), fetchFn);
  await transport.savePersonalAiSettings({ enabled: true, mode: "managed", managedModel: "fast" });
  await transport.testPersonalAiConnection({ enabled: true, mode: "own", provider: "openai", model: "gpt-test" });
  await transport.testPersonalAiConnection();
  await transport.removePersonalAiSettings();
  expect(sent).toEqual([
    { name: "savePersonalAiSettings", body: { enabled: true, mode: "managed", managedModel: "fast" } },
    { name: "testPersonalAiConnection", body: { draft: { enabled: true, mode: "own", provider: "openai", model: "gpt-test" } } },
    { name: "testPersonalAiConnection", body: {} },
    { name: "removePersonalAiSettings", body: {} },
  ]);
});

test("model lists and the model choice use the server's names and arguments", async () => {
  const sent: { name: string; body: unknown }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/changes")) return Response.json({ version: 1 });
    const name = url.slice(url.lastIndexOf("/") + 1);
    sent.push({ name, body: JSON.parse(String(init?.body ?? "null")) });
    return Response.json({ value: { ok: true, models: [], truncated: false } });
  };
  const transport = httpTransport(deployment, new CookieSession(deployment.backendUrl, "email", fetchFn), fetchFn);
  await transport.listAiModels("p1", { provider: "openrouter", apiKey: "sk-typed" });
  await transport.listAiModels("p1");
  await transport.listPersonalAiModels({ provider: "openai", baseUrl: null });
  await transport.listPersonalAiModels();
  expect(sent).toEqual([
    { name: "listAiModels", body: { projectId: "p1", draft: { provider: "openrouter", apiKey: "sk-typed" } } },
    { name: "listAiModels", body: { projectId: "p1" } },
    { name: "listPersonalAiModels", body: { draft: { provider: "openai", baseUrl: null } } },
    { name: "listPersonalAiModels", body: {} },
  ]);
});

test("a person's own Critiqs AI usage asks the server for today's, and an older server's missing call is an error, not a crash", async () => {
  const sent: { name: string; body: unknown }[] = [];
  let older = false;
  const fetchFn = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/changes")) return Response.json({ version: 1 });
    if (url.endsWith("/me")) return Response.json({ reviewer: { id: "u1", name: "Dana", email: "d@example.com", pictureUrl: null } });
    const name = url.slice(url.lastIndexOf("/") + 1);
    sent.push({ name, body: JSON.parse(String(init?.body ?? "null")) });
    if (older) return Response.json({ error: { code: "not-found", message: "Unknown request." } }, { status: 404 });
    return Response.json({ value: { plan: "Team", rows: [{ period: "day", used: 12, max: 500 }] } });
  };
  const states: unknown[] = [];
  function Usage({ transport }: { transport: CritiqsTransport }) {
    states.push(transport.usePersonalAiUsage(true));
    return null;
  }
  for (const answer of ["current", "older"]) {
    older = answer === "older";
    const transport = httpTransport(deployment, new CookieSession(deployment.backendUrl, "email", fetchFn), fetchFn);
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Usage transport={transport} />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    await act(async () => root.unmount());
  }
  expect(sent[0]).toEqual({ name: "personalAiUsage", body: { day: new Date().toISOString().slice(0, 10) } });
  expect(states).toContainEqual({ status: "ready", data: { plan: "Team", rows: [{ period: "day", used: 12, max: 500 }] } });
  expect(states.at(-1)).toMatchObject({ status: "error" });
});

test("project usage asks for aiCredits only from a server that reports the overage cap, which came with it", async () => {
  const sent: unknown[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/changes")) return Response.json({ version: 1 });
    if (url.endsWith("/me")) return Response.json({ reviewer: { id: "u1", name: "Dana", email: "d@example.com", pictureUrl: null } });
    sent.push(JSON.parse(String(init?.body ?? "null")));
    return Response.json({ value: null });
  };
  function Usage({ transport }: { transport: CritiqsTransport }) {
    transport.useUsage("p1");
    return null;
  }
  for (const overageCap of [false, true]) {
    const current = { ...deployment, overageCap };
    const transport = httpTransport(current, new CookieSession(current.backendUrl, "email", fetchFn), fetchFn);
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Usage transport={transport} />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    await act(async () => root.unmount());
  }
  const day = new Date().toISOString().slice(0, 10);
  expect([...new Set(sent.map((body) => JSON.stringify(body)))].map((body) => JSON.parse(body))).toEqual([
    { projectId: "p1", day },
    { projectId: "p1", day, aiCredits: true },
  ]);
});
