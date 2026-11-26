import { panelSignIn } from "@critiqs/core";
import { type Deployment, resolveDeployment } from "../../react/src/deployment.ts";
import { type AutoPins, pinsDisplay } from "./auto-pins.ts";
import { backendProblem, convexProjects } from "./backend.ts";
import type { ChromeApi, MessageSender, Tab } from "./chrome.ts";
import { BACKEND_URL, isPageMessage, panelPath, type TabState, tabKey } from "./config.ts";
import { Choices, findProject, pageOrigin } from "./lookup.ts";
import { ExtensionSession } from "./session.ts";
import { PAGE_SCRIPT, showsAutomatically } from "./site-access.ts";

/**
 * The extension's background worker. Clicking the Critiqs icon opens the side
 * panel for that tab and adds the page layer to the page: Chrome grants the
 * page to the extension for that click (`activeTab`), which it doesn't when
 * the icon opens the panel by itself, so the panel opens from here. It also
 * answers the page layer on sites whose comments show automatically.
 */
export function startWorker(chrome: ChromeApi, backendUrl: string = BACKEND_URL) {
  // The icon runs `action.onClicked` instead of opening the panel itself.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);

  // One change at a time, in the order they happened, so an answer about a tab's last page can
  // neither overwrite another answer nor land after the tab started loading its next page.
  let writes: Promise<void> = Promise.resolve();
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
  const forgetTab = (tabId: number): Promise<void> => queue(() => chrome.storage.session.remove(tabKey(tabId)));

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

  /** Adds the page layer to the page. Refused on pages Chrome protects, or once the click's access has ended. */
  const addPageLayer = async (tabId: number): Promise<boolean> => {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [PAGE_SCRIPT] });
      await setTab(tabId, { refused: undefined });
      return true;
    } catch (error) {
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

  let deployment: Promise<Deployment> | null = null;
  const signedIn = async () => {
    deployment ??= resolveDeployment(backendUrl).catch((error) => {
      deployment = null;
      throw error;
    });
    const resolved = await deployment;
    // A backend the panel refuses gets no calls from here either.
    const problem = backendProblem(resolved);
    if (problem !== null) throw new Error(problem);
    const { backendUrl: url, signInUrl } = resolved;
    const session = new ExtensionSession(signInUrl, panelSignIn(signInUrl), chrome.storage.local, null);
    await session.ready;
    return { url, signInUrl, session };
  };

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

/** Set by the build: true only in test builds (`CRITIQS_TEST=1`), so real builds leave the hook out entirely. */
declare const CRITIQS_TEST_HOOKS: boolean;

const chrome = (globalThis as unknown as { chrome?: ChromeApi }).chrome;
if (chrome?.runtime?.id !== undefined) {
  const worker = startWorker(chrome);
  // Automated runs can't click the toolbar icon; test builds let them add the page layer as the click does.
  if (CRITIQS_TEST_HOOKS) Object.assign(globalThis, { critiqsTest: worker });
}
