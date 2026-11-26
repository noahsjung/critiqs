import {
  type ElementRef,
  type NewThread,
  type PageEvent,
  type PageEvents,
  PageLayerError,
  type PageMethod,
  type PagePanelEndpoint,
  type PageParams,
  type PageResult,
  type PageState,
} from "@critiqs/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { PageLink } from "../src/page-layer/link.ts";
import { Session } from "../src/session.ts";
import { type CritiqsTransport, TransportContext } from "../src/transport.ts";
import { commentField, typeInto } from "./comment-field.ts";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// The panel with a page layer in another document, scripted so a test can
// hold its answers and replace it mid-request, as when the prototype's frame
// loads another page.

const SIGN_IN = "https://auth.example";
const backend: FakeBackend = {
  project: { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true },
  threads: [],
  thread: undefined,
};

export const pageState = (document: string, version: number): PageState => ({
  document,
  version,
  url: "https://prototype.example/pilot",
  context: { screen: "pilot", viewState: {}, persona: null },
  viewport: { width: 1280, height: 800 },
  restores: false,
  located: {},
});

type Answers = Partial<{ [M in PageMethod]: (params: PageParams<M>, signal: AbortSignal) => Promise<PageResult<M>> }>;

/** A page layer that answers as the test says (null where it says nothing), and can send events. Deadlines apply as on a real one. */
export function scriptedPage(answers: Answers) {
  const listeners = new Map<PageEvent, Set<(data: never) => void>>();
  const endpoint: PagePanelEndpoint = {
    request(method, params, options = {}) {
      const answer = answers[method] as ((params: unknown, signal: AbortSignal) => Promise<never>) | undefined;
      const signal = options.signal ?? new AbortController().signal;
      if (answer === undefined) return Promise.resolve(null as never);
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new PageLayerError("cancelled", `${method} was cancelled.`)));
        if (options.timeoutMs !== undefined) setTimeout(() => reject(new PageLayerError("timeout", `The page layer didn't answer ${method} in time.`)), options.timeoutMs);
        answer(params, signal).then(resolve, reject);
      });
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(handler as (data: never) => void);
      return () => set.delete(handler as (data: never) => void);
    },
    close() {},
  };
  const emit = <E extends PageEvent>(event: E, data: PageEvents[E]) => {
    for (const handler of [...(listeners.get(event) ?? [])]) (handler as (data: PageEvents[E]) => void)(data);
  };
  return { endpoint, emit };
}

export const measured = async () => ({
  context: pageState("page-a", 1).context,
  url: "https://prototype.example/pilot",
  viewport: { width: 1280, height: 800 },
  marker: { x: 1, y: 2, width: 3, height: 4 },
  userAgent: "Browser",
});

let root: Root | null = null;
let host: HTMLElement | null = null;

export async function unmountPanel() {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
}

/**
 * Shows the signed-in panel over a scripted page layer on document `page-a`,
 * picks an element, writes a comment, and saves it. Returns the panel's shadow
 * root, the comments the backend created, and `navigate`, which makes another
 * document's page layer take over.
 */
export async function saveCommentOnScriptedPage(answers: Answers, transportChanges: Partial<CritiqsTransport> = {}) {
  let shown = pageState("page-a", 1);
  const page = scriptedPage({ display: async () => shown, ...answers });
  const link = new PageLink(page.endpoint, { initial: shown });
  const created: NewThread[] = [];
  const payload = btoa(JSON.stringify({ sub: "dana", name: "Dana", email: "dana@example.com" }));
  localStorage.setItem(`critiqs:session:${SIGN_IN}`, JSON.stringify({ accessToken: `header.${payload}.signature`, refreshToken: "fixture", expiresAt: Date.now() + 900_000 }));
  host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);
  root = createRoot(container);
  const transport = {
    ...fakeTransport(backend),
    createThread: async (thread: NewThread) => (created.push(thread), "thread"),
    ...transportChanges,
  };
  const deployment = { backendUrl: "https://backend.convex.cloud", siteUrl: "https://backend.convex.site", signInUrl: SIGN_IN, transport: "convex", signIn: null } as const;
  const session = new Session(SIGN_IN, localStorage, async () => new Response(null, { status: 204 }));
  await act(async () =>
    root!.render(
      <TransportContext.Provider value={transport}>
        <App props={{ projectId: "project" }} deployment={deployment} session={session} host={host!} page={link} />
      </TransportContext.Provider>,
    ),
  );
  await act(async () => shadow.querySelector<HTMLButtonElement>('button[aria-label="Comment mode"]')!.click());
  await act(async () =>
    page.emit("picked", {
      occurrence: { ref: "e1" as ElementRef, recordKey: null },
      target: { purposeId: "review", recordKey: null, clues: { tagName: "button", role: null, label: "Review", path: "main:1/button:1" } },
      context: pageState("page-a", 1).context,
    }),
  );
  const form = shadow.querySelector<HTMLFormElement>('form[aria-label="New comment"]')!;
  await typeInto(commentField(form)!, "Align the review button");
  await act(async () => form.requestSubmit());
  const navigate = async () => {
    shown = pageState("page-b", 1);
    await act(async () => page.emit("state", shown));
  };
  return { shadow, created, navigate, page };
}
