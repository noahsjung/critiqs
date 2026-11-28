import { panelSignIn } from "@critiqs/core";
import { type Deployment, resolveDeployment } from "../../react/src/deployment.ts";
import { type AutoPins, pinsDisplay } from "./auto-pins.ts";
import { backendProblem, convexProjects } from "./backend.ts";
import type { ChromeApi, MessageSender, StorageChange, Tab } from "./chrome.ts";
import { BACKEND_URL, isPageMessage, panelPath, type TabState, tabKey } from "./config.ts";
import { Choices, findProject, pageOrigin } from "./lookup.ts";
import { parseOverlayRequest, SESSION_CHANGED } from "./overlay-protocol.ts";
import { type Connection, openKey, overlayRouter, tabOrigin } from "./overlay-router.ts";
import { ExtensionSession } from "./session.ts";
import { PAGE_SCRIPT, SITES_CHANGED, showsAutomatically } from "./site-access.ts";

/**
 * The extension's background worker. Clicking the Critiqs icon opens the side
 * panel for that tab and adds the page layer to the page: Chrome grants the
 * page to the extension for that click (`activeTab`), which it doesn't when
 * the icon opens the panel by itself, so the panel opens from here. It also
 * answers the page layer on sites whose comments show automatically.
 *
 * It is the only part of the extension a page's content script talks to
 * about the sign-in: extension storage, which holds the refresh token, is
 * closed to content scripts at every start, before anything else, and the
 * worker answers their requests (`overlay-protocol.ts`) without ever handing
 * them a refresh token or a sign-in attempt key.
 */
export function startWorker(chrome: ChromeApi, backendUrl: string = BACKEND_URL, options: { now?: () => number } = {}) {
  // First of all: content scripts lose access to extension storage. Chrome doesn't keep this
  // across restarts of the browser, so every start of the worker asks again.
  let storageClosed = true;
  const locked: Promise<void> = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch((error) => {
    storageClosed = false;
    console.warn("Critiqs: extension storage couldn't be closed to pages", error);
  });

  // The icon runs `action.onClicked` instead of opening the panel itself.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);

  // One change at a time, in the order they happened, so an answer about a tab's last page can
  // neither overwrite another answer nor land after the tab started loading its next page.
  // Nothing touches storage before it is closed to content scripts.
  let writes: Promise<void> = locked;
  const queue = (write: () => Promise<void>): Promise<void> => {
    writes = writes.then(write).catch(() => undefined);
    return writes;
  };
  /** Changes what the panel reads about a tab; a field set to undefined is removed. */
  const setTab = (tabId: number, change: TabState): Promise<void> =>
    queue(async () => {
      const key = tabKey(tabId);
      const next: Record<string, unknown> = { ...((await chrome.storage.session.get(key))[key] ?? {}), ...change };
      for (const field of Object.keys(next)) if (next[field] === undefined) delete next[field];
      await chrome.storage.session.set({ [key]: next });
    });
  const forgetTab = (tabId: number): Promise<void> => queue(() => chrome.storage.session.remove([tabKey(tabId), ...router.forgetKeys(tabId)]));

  /**
   * Opens the side panel for one tab, on a comment when a pin asked. Chrome
   * allows it only during the person's click, so nothing is awaited first.
   * The comment travels in the panel's own address, set in the same go.
   */
  const openPanel = (tabId: number, threadId?: string): Promise<void> => {
    const options = chrome.sidePanel.setOptions({ tabId, path: panelPath(tabId, threadId), enabled: true });
    const opened = chrome.sidePanel.open({ tabId });
    return Promise.all([options, opened]).then(() => undefined);
  };

  /**
   * Adds the page layer to the page. The tab is marked as one Critiqs is open
   * in, for the site of its page, before the script starts, so the script's
   * first request finds the mark; a refusal takes the mark back. Refused on
   * pages Chrome protects, or once the click's access has ended.
   */
  const addPageLayer = async (tabId: number): Promise<boolean> => {
    const mark = openKey(tabId);
    try {
      // Chrome hides the address of a page it won't give the extension; Chrome's own refusal below says why.
      const origin = tabOrigin((await chrome.tabs.get(tabId).catch(() => undefined))?.url);
      if (origin !== null) await queue(() => chrome.storage.session.set({ [mark]: { origin } }));
      await chrome.scripting.executeScript({ target: { tabId }, files: [PAGE_SCRIPT] });
      await setTab(tabId, { refused: undefined });
      return true;
    } catch (error) {
      await queue(() => chrome.storage.session.remove(mark));
      await setTab(tabId, { refused: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  chrome.action.onClicked.addListener((tab: Tab) => {
    if (tab.id === undefined) return;
    const tabId = tab.id;
    openPanel(tabId).catch((error) => console.warn("Critiqs: the side panel didn't open", error));
    void addPageLayer(tabId);
  });

  // One session for this run of the worker, kept up to date with storage, so renewals asked for at
  // once share one request and every part of the extension sees the same reviewer.
  let connection: Promise<Connection> | null = null;
  const signedIn = (): Promise<Connection> =>
    (connection ??= (async () => {
      await locked;
      const resolved: Deployment = await resolveDeployment(backendUrl);
      // A backend the panel refuses gets no calls from here either.
      const problem = backendProblem(resolved);
      if (problem !== null) throw new Error(problem);
      const { backendUrl: url, signInUrl } = resolved;
      const client = panelSignIn(signInUrl);
      const session = new ExtensionSession(signInUrl, client, chrome.storage.local, chrome.storage.onChanged);
      await session.ready;
      return { url, signInUrl, client, session };
    })().catch((error) => {
      connection = null;
      throw error;
    }));
  const router = overlayRouter(chrome, signedIn, options);

  // Tabs hear when the reviewer signs in or out or changes name, anywhere in the extension (here or in
  // the side panel), and when a site's automatic comments are turned on or off, so what they show
  // follows. A renewal alone changes nothing they show, so it isn't told.
  chrome.storage.onChanged.addListener((changes: Record<string, StorageChange>, area: string) => {
    if (area !== "local" || !Object.entries(changes).some(([key, change]) => tellsTabs(key, change))) return;
    void chrome.tabs.query({}).then(
      (tabs) => tabs.forEach((tab) => tab.id !== undefined && void chrome.tabs.sendMessage(tab.id, SESSION_CHANGED).catch(() => undefined)),
      () => undefined,
    );
  });

  /** Pins for a page on a site whose comments show automatically, with no side panel open. */
  const autoPins = async (tab: Tab | undefined): Promise<AutoPins> => {
    const origin = pageOrigin(tab?.url);
    if (origin === null || !(await showsAutomatically(chrome, origin))) return { display: null };
    const { url, signInUrl, session } = await signedIn();
    const reviewer = session.reviewer;
    if (reviewer === null) return { display: null };
    const projects = convexProjects(url, session);
    const choice = await findProject(projects, new Choices(chrome.storage.local, signInUrl), reviewer.id, origin);
    if (choice.kind !== "show") return { display: null };
    return { display: pinsDisplay(await projects.threads(choice.project._id)) };
  };

  chrome.runtime.onMessage.addListener((message: unknown, sender: MessageSender, respond: (answer: unknown) => void) => {
    const request = parseOverlayRequest(message);
    if (request !== null) {
      locked.then(() => (storageClosed ? router.handle(request, sender) : { refused: "Critiqs couldn't keep its sign-in from pages in this browser." })).then(respond, () => respond({ failed: "Critiqs couldn't answer. Try again." }));
      return true;
    }
    const tabId = sender.tab?.id;
    // Only the content script in a tab's own page sends these.
    if (!isPageMessage(message) || tabId === undefined || sender.frameId !== 0) return;
    switch (message.type) {
      case "critiqs:built-in":
        void setTab(tabId, { builtIn: true });
        void chrome.action.setTitle({ tabId, title: "Critiqs: Built in. This site has Critiqs installed." });
        void chrome.action.setBadgeText({ tabId, text: "✓" });
        return;
      case "critiqs:auto-pins":
        autoPins(sender.tab).then(respond, (error) => {
          console.warn("Critiqs: pins for this page couldn't be read", error);
          respond({ display: null } satisfies AutoPins);
        });
        return true;
      case "critiqs:open-panel":
        // A pin clicked with no side panel open: Chrome may allow opening it for that click.
        openPanel(tabId, message.threadId).then(
          () => respond({ opened: true }),
          () => respond({ opened: false }),
        );
        return true;
      case "critiqs:page-ready":
        // The extension's page layer runs here, so this page hasn't Critiqs installed, whatever the last one had.
        void setTab(tabId, { builtIn: undefined });
        return;
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));
  // A new page in the tab starts with no answers about the last one.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading") {
      void forgetTab(tabId);
      void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
    }
  });

  return { openPanel, addPageLayer };
}

/** Whether a change to extension storage changes what tabs show: the reviewer, a sign-out, or a site's automatic comments. */
function tellsTabs(key: string, change: StorageChange): boolean {
  if (key === SITES_CHANGED || key.startsWith("signed-out:")) return true;
  if (!key.startsWith("session:")) return false;
  const reviewer = (value: unknown) => JSON.stringify((value as { reviewer?: unknown } | undefined)?.reviewer ?? null);
  return reviewer(change.oldValue) !== reviewer(change.newValue);
}

/** Set by the build: true only in test builds (`CRITIQS_TEST=1`), so real builds leave the hook out entirely. */
declare const CRITIQS_TEST_HOOKS: boolean;

const chrome = (globalThis as unknown as { chrome?: ChromeApi }).chrome;
if (chrome?.runtime?.id !== undefined) {
  const worker = startWorker(chrome);
  // Automated runs can't click the toolbar icon; test builds let them add the page layer as the click does.
  if (CRITIQS_TEST_HOOKS) Object.assign(globalThis, { critiqsTest: worker });
}
