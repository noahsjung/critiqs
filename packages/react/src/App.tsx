import {
  type Anchor,
  type CaptureOutcome,
  type NewCapture,
  buildLink,
  DEFAULT_FILTERS,
  type Occurrence,
  type PageDisplay,
  type PageEvents,
  parseLink,
  type Rect,
  removeLink,
  type SearchScope,
  threadPageLink,
  type SidebarFilters,
  type Target,
  type TargetLocation,
} from "@critiqs/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Deployment } from "./deployment.ts";
import type { CritiqsProps } from "./host.ts";
import { errorMessage, useTransport } from "./transport.ts";
import { isHideShortcut, isTyping, useStoredState } from "./hooks.ts";
import { type LiveThread, locationOf, type ThreadSummary } from "./model.ts";
import { inDocumentPage } from "./page-layer/in-document.ts";
import type { PageLink } from "./page-layer/link.ts";
import { PAGE_ANSWER_MS, PAGE_CAPTURE_MS } from "./page-layer/deadlines.ts";
import { sameViewState } from "./page-layer/view.ts";
import { type ReviewerSession, SignInError } from "./session.ts";
import { openLayer, Toasts, useToasts } from "./ui/common.tsx";
import { ExportDialog } from "./ui/ExportDialog.tsx";
import { HiddenContext } from "./ui/hidden.ts";
import { CloseIcon, SelectIcon, TagsIcon } from "./ui/icons.tsx";
import { EMPTY_MENTION_TEXT, mentionsInText } from "./ui/MentionInput.tsx";
import { NameDialog } from "./ui/NameDialog.tsx";
import { NotificationsDialog } from "./ui/NotificationsDialog.tsx";
import { Composer, emptyComment, type NewComment } from "./ui/Picker.tsx";
import { DocsPanel } from "./ui/DocsPanel.tsx";
import { ProjectPanel } from "./ui/ProjectPanel.tsx";
import { Setup } from "./ui/Setup.tsx";
import { SearchBox, SearchResults, type SearchState } from "./ui/Search.tsx";
import { TagsAiDialog } from "./ui/TagsAiDialog.tsx";
import { OrganizationDialog } from "./ui/OrganizationDialog.tsx";
import { YourAiDialog } from "./ui/YourAiDialog.tsx";
import { type Awaiting, BillingDialog, type OpenBilling, OpenBillingContext, parseBillingReturn, removeBillingReturn } from "./ui/BillingDialog.tsx";
import { FilterButton, groupMembers, ThreadList } from "./ui/ThreadList.tsx";
import { type ReplyState, type RevealState, ThreadView } from "./ui/ThreadView.tsx";
import { ThreadWindow } from "./ui/ThreadWindow.tsx";
import { SidebarResizer, sidebarWidth, useSidebarWidth, useWindowWidth } from "./ui/sidebar-width.tsx";
import { type Mode, Toolbar } from "./ui/Toolbar.tsx";
import { type MockupRequest, MockupMode, type ShowPage } from "./ui/mockup/MockupMode.tsx";

interface Selected {
  /** Distinguishes each opening, including reopening the same thread from another pin. */
  id: number;
  threadId: string;
  messageId: string | null;
  /** Reveal the target in the prototype once the thread is known. */
  reveal: boolean;
  /** The occurrence the thread window sits beside: the clicked pin's, or the one revealed. */
  anchor: Occurrence | null;
  /** The control that opened the thread, which gets focus back when it closes. */
  returnFocus: HTMLElement | null;
}

type Panel = "comments" | "setup" | "docs";

/** The element a new comment is about, as the page layer reported it. */
interface Picked {
  occurrence: Occurrence;
  target: Target;
}

/**
 * Takes a screenshot of the view from outside the page, such as an
 * extension's `captureVisibleTab`, while Critiqs's pins are hidden. Null
 * leaves the capture to the page layer's own, from the page's structure.
 */
export type SupplyCapture = () => Promise<Blob | null>;

interface AppProps {
  props: CritiqsProps;
  deployment: Deployment;
  session: ReviewerSession;
  /** The element holding the panel's shadow root. */
  host: HTMLElement;
  /**
   * The page layer, where it runs elsewhere, such as in a frame or a tab.
   * Without it, the page layer runs in this document, drawing into `host`,
   * as when Critiqs is installed.
   */
  page?: PageLink;
  supplyCapture?: SupplyCapture;
  /** A comment to open as a link to it would, such as the one whose pin opened the extension's side panel. */
  openThread?: string;
}

/**
 * Critiqs's interface: the panel, connected to a page layer. Installed, both
 * run here and the host's `getContext` and `restoreContext` go to the page
 * layer.
 */
export function App({ page, ...args }: AppProps) {
  const own = useInDocumentPage(page === undefined ? args.host : null, args.props);
  const link = page ?? own;
  return link === null ? null : <PanelApp {...args} page={link} />;
}

/** Runs the page layer in this document for as long as the panel is shown. */
function useInDocumentPage(host: HTMLElement | null, props: CritiqsProps): PageLink | null {
  const [made, setMade] = useState<ReturnType<typeof inDocumentPage> | null>(null);
  const { getContext, restoreContext } = props;
  const pageHost = useRef({ getContext, restoreContext });
  pageHost.current = { getContext, restoreContext };
  useLayoutEffect(() => {
    if (host === null) return;
    const created = inDocumentPage(host, pageHost.current);
    setMade(created);
    return () => {
      created.destroy();
      setMade((current) => (current === created ? null : current));
    };
  }, [host]);
  // The host's functions as of its latest render: a restore changes the app's
  // state, and the context Critiqs checks afterwards must be the new one.
  useLayoutEffect(() => {
    made?.layer.setHost({ getContext, restoreContext });
  }, [made, getContext, restoreContext]);
  return made?.link ?? null;
}

function PanelApp({
  props,
  deployment,
  session,
  host,
  page,
  supplyCapture,
  openThread,
}: Omit<AppProps, "page"> & { page: PageLink }) {
  const transport = useTransport();
  const { reviewer } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { isAuthenticated, rejected } = transport.useAuth();
  const { toasts, show: notify, dismiss } = useToasts();

  const [rememberedProject, setBrowserProject] = useStoredState<string | null>(`critiqs:project:${deployment.backendUrl}`, null);
  const required = props.requireProjectId === true;
  // A project configured for this deployment is never replaced by one another app on this site remembered.
  const browserProject = required ? null : rememberedProject;
  const configuredProject = props.projectId ?? null;
  const projectId = configuredProject ?? browserProject;

  const [mode, setMode] = useState<Mode>("browse");
  const [sidebarOpen, setSidebarOpen] = useStoredState("critiqs:sidebar-open", false);
  // Pins and the composer stay left of the sidebar, as wide as it is now.
  const sideWidth = useSidebarWidth();
  // Placing beside the sidebar follows the window as it resizes, even when the sidebar's width doesn't change.
  const windowWidth = useWindowWidth();
  // For revealing a thread, which reads the sidebar as of the latest render.
  const sidebarState = useRef({ open: sidebarOpen, setOpen: setSidebarOpen });
  sidebarState.current = { open: sidebarOpen, setOpen: setSidebarOpen };
  const [panel, setPanel] = useState<Panel>("comments");
  const [filters, setFilters] = useState<SidebarFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<Selected | null>(null);
  const selectedRef = useRef(selected);
  const selections = useRef(0);
  selectedRef.current = selected;
  // Reply boxes by thread, so closing or reopening a thread window keeps an
  // unsent reply and never repeats one that is still sending.
  const [replies, setReplies] = useState<Record<string, ReplyState>>({});
  const repliesRef = useRef(replies);
  repliesRef.current = replies;
  const [picked, setPicked] = useState<Picked | null>(null);
  const [comment, setComment] = useState<NewComment | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reattaching, setReattaching] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealState>({ status: "idle" });
  const [highlight, setHighlight] = useState<{ id: number; location: TargetLocation } | null>(null);
  const highlights = useRef(0);
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [yourAiOpen, setYourAiOpen] = useState(false);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [billing, setBilling] = useState<{ organizationId: string | null; awaiting: Awaiting } | null>(null);
  const [tagsDialog, setTagsDialog] = useState<"groups" | "ai" | null>(null);
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  /** Everything of Critiqs hidden (Ctrl or Cmd + \), keeping its state for when it returns. Not kept across reloads. */
  const [hidden, setHidden] = useState(false);
  const [pendingLink, setPendingLink] = useState(() => parseLink(page.getState().url) ?? (openThread === undefined ? null : { threadId: openThread, messageId: null }));
  // Mockup mode: a mockup to open on entering it, its panel (in the sidebar's place), and what Escape closes there.
  const [mockupRequest, setMockupRequest] = useState<MockupRequest | null>(null);
  const mockupRequests = useRef(0);
  const [mockupPanelOpen, setMockupPanelOpen] = useState(true);
  const mockupEscape = useRef<(() => boolean) | null>(null);

  const pageState = useSyncExternalStore(page.subscribe, page.getState);
  const { context } = pageState;
  const signedIn = reviewer !== null && isAuthenticated;
  const needsSetup = projectId === null;
  // Which reviewer the interface is showing. Work in progress belongs to them:
  // it is cleared when they sign out or another reviewer signs in, but not when
  // the backend briefly re-authenticates the same reviewer, such as after a rename.
  const reviewerId = reviewer?.id ?? null;
  // A backend that checked the token and refused it is a loss of access too,
  // unlike the brief re-check after a rename or a token that couldn't be fetched.
  const backendRejected = reviewer !== null && rejected;
  const accessKey = backendRejected ? null : reviewerId;
  const accessEpoch = useRef({ reviewerId: accessKey });
  if (accessEpoch.current.reviewerId !== accessKey) accessEpoch.current = { reviewerId: accessKey };

  const projectQuery = transport.useProject(signedIn ? projectId : null);
  const projectError = projectQuery.status === "error";
  // A project limited to its organization still shows its refusal to someone outside it, even with `requireProjectId`.
  const projectMissing = projectError && projectQuery.code !== "forbidden";
  useEffect(() => {
    if (required && projectMissing) {
      console.warn(`Critiqs: the project ${configuredProject} isn't available on the Critiqs backend at ${deployment.backendUrl}. Check this app's project ID setting, or run npx critiqs doctor.`);
    }
  }, [required, projectMissing, configuredProject, deployment.backendUrl]);
  const threadsQuery = transport.useThreads(signedIn && projectQuery.status === "ready" ? projectId : null);
  const summaries = threadsQuery.status === "ready" ? threadsQuery.data : EMPTY;
  const projectTags = projectQuery.status === "ready" ? projectQuery.data.tags : EMPTY_TAGS;
  const tagsQuery = transport.useTags(signedIn && projectQuery.status === "ready" ? projectId : null);
  const tagInfo = tagsQuery.status === "ready" ? tagsQuery.data : null;

  // Mockup threads belong to Mockup mode's panel only; backends leave them out of the list too.
  const pageSummaries = useMemo(() => summaries.filter((summary) => summary.mockup === undefined), [summaries]);
  // Where every thread's target is now, as the page layer last located it.
  const threads: LiveThread[] = useMemo(
    () =>
      pageSummaries.map((summary) => {
        const location = locationOf(summary);
        const located = location.screen === context.screen ? (pageState.located[summary._id] ?? null) : null;
        const sameView = sameViewState(location.viewState, context.viewState);
        return { summary, location, located, sameView };
      }),
    [pageSummaries, pageState],
  );
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.summary._id as string, thread])), [threads]);
  // Mockup is offered where the backend stores mockups and the project is set up; signed out, it asks to sign in, as Comment does.
  // Mockup mode draws its page copy over the page itself, so it needs the panel there too.
  const mockupsOffered = transport.mockups !== undefined && deployment.mockups === true && page.overPage && !needsSetup && !backendRejected && !projectError;
  const mockupsAvailable = mockupsOffered && signedIn && projectQuery.status === "ready";
  const inMockup = mode === "mockup" && mockupsAvailable;
  // Your AI is offered where the backend keeps each person's own AI settings.
  const openYourAi = signedIn && deployment.personalAi === true ? () => setYourAiOpen(true) : null;
  const organizationMembers = deployment.organizationMembers === true;
  const openOrganization = signedIn && organizationMembers ? () => setOrganizationOpen(true) : null;
  const billingOffered = signedIn && deployment.billing === true && transport.billing !== undefined;
  const projectOrganizationId = projectQuery.status === "ready" ? (projectQuery.data.organization?.id ?? null) : null;
  const openBilling = useMemo<OpenBilling | null>(
    () =>
      billingOffered
        ? {
            open: (organizationId?: string) => {
              setYourAiOpen(false);
              setTagsDialog(null);
              setOrganizationOpen(false);
              setBilling({ organizationId: organizationId ?? projectOrganizationId, awaiting: null });
            },
            organizationId: projectOrganizationId,
          }
        : null,
    [billingOffered, projectOrganizationId],
  );
  const unreadCount = threads.filter((thread) => thread.summary.unread && thread.summary.status === "open").length;

  // ---------------------------------------------------------------------------
  // Sign-in

  const signIn = useCallback(() => {
    session.signIn().catch((error) => {
      if (error instanceof SignInError && error.reason === "closed") return;
      notify(error instanceof Error ? error.message : "Sign-in failed.");
    });
  }, [session, notify]);

  /** Switches modes as the toolbar and its keys do: entering Comment or Mockup mode signed out asks to sign in. */
  const chooseMode = useCallback(
    (next: Mode) => {
      if (next === "mockup") setMockupRequest(null);
      setMode(next);
      if ((next === "comment" || next === "mockup") && !signedIn) signIn();
    },
    [signedIn, signIn],
  );

  const revealController = useRef<AbortController | null>(null);
  useEffect(() => () => revealController.current?.abort(), []);

  // Auth changes can come from another tab or another component's Session.
  // Remove reviewer-only state whenever the reviewer changes, not only on a toolbar click.
  const shownReviewer = useRef(accessKey);
  useEffect(() => {
    if (accessKey !== null && shownReviewer.current === accessKey) return;
    shownReviewer.current = accessKey;
    revealController.current?.abort();
    setSelected(null);
    setReplies({});
    setExporting(false);
    setRenaming(false);
    setNotificationsOpen(false);
    setYourAiOpen(false);
    setOrganizationOpen(false);
    setBilling(null);
    setTagsDialog(null);
    setSearch({ status: "idle" });
    setSelecting(false);
    setChecked(new Set());
    setPicked(null);
    setComment(null);
    setSaveError(null);
    setSaving(false);
    setReattaching(null);
    setReveal({ status: "idle" });
    setHighlight(null);
    setMode("browse");
  }, [accessKey]);

  // Another document's page layer took over, such as after the prototype's
  // frame loaded another page: a new comment, a replacement being chosen, and
  // the occurrence a thread sits beside were all about the page that went away.
  // Its requests, such as a comment's capture, already failed as cancelled.
  const pageDocument = pageState.document;
  const shownDocument = useRef(pageDocument);
  /** Whether a new comment's thread is being created on the backend, which a page change no longer stops. */
  const creating = useRef(false);
  useEffect(() => {
    if (shownDocument.current === pageDocument) return;
    shownDocument.current = pageDocument;
    revealController.current?.abort();
    setReveal({ status: "idle" });
    setHighlight(null);
    setReattaching(null);
    setSelected((current) => (current === null ? null : { ...current, anchor: null }));
    // A comment already being created is saved anyway; its save says so.
    if (creating.current) return;
    const draft = commentRef.current;
    setPicked(null);
    setComment(null);
    setSaveError(null);
    setSaving(false);
    if (draft !== null && draft.body.text.trim() !== "") {
      notify("The prototype showed another page, so the new comment was discarded. Select the element again to comment on it.");
    }
  }, [pageDocument, notify]);

  // Keep the backend's record of the reviewer's name in step with their sign-in,
  // so a changed name shows on their existing comments. The backend may still
  // hold the previous token briefly after a change, so retry until it matches.
  const reviewerName = reviewer?.name ?? null;
  useEffect(() => {
    if (!signedIn || reviewerName === null) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
        const stored = await transport.syncReviewer().catch(() => null);
        if (cancelled || stored === reviewerName) return;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, reviewerName, transport]);

  // Opening a project through this install lets the browser extension find it
  // for this reviewer by the page's address. Once per page load, reviewer, and project.
  const projectReady = projectQuery.status === "ready";
  const recordsOpens = deployment.addressLists === true;
  useEffect(() => {
    if (!signedIn || !recordsOpens || !projectReady || projectId === null || reviewerId === null) return;
    const key = JSON.stringify([deployment.backendUrl, reviewerId, projectId]);
    if (recordedOpens.has(key)) return;
    recordedOpens.add(key);
    // A failure is retried the next time this reviewer opens the project.
    transport.recordProjectOpened(projectId).catch(() => recordedOpens.delete(key));
  }, [signedIn, recordsOpens, projectReady, projectId, reviewerId, deployment.backendUrl, transport]);

  const signOut = useCallback(() => {
    revealController.current?.abort();
    setSelected(null);
    setMode("browse");
    void session.signOut();
  }, [session]);

  // ---------------------------------------------------------------------------
  // Selecting and revealing threads

  /**
   * Shows a thread's target where it was left: the page layer restores its
   * saved screen and view state if needed, then finds and scrolls to the target.
   */
  const revealThread = useCallback(async (thread: { _id: string; location: TargetLocation }) => {
    revealController.current?.abort();
    const controller = new AbortController();
    revealController.current = controller;
    const { location } = thread;
    const fail = (reason: string, { keepOccurrence }: { keepOccurrence: boolean }) => {
      // After the prototype changed views, the chosen occurrence may be an unrelated
      // element, so the window docks beside the sidebar with the saved context.
      if (!keepOccurrence) {
        setSelected((current) => (current?.threadId === thread._id ? { ...current, anchor: null } : current));
      }
      setReveal({ status: "failed", reason });
    };
    // The view needs restoring unless the target is already shown in its saved view.
    const now = page.getState();
    const located = now.located[thread._id];
    const shown = located?.status === "found" && now.context.screen === location.screen && sameViewState(location.viewState, now.context.viewState);
    if (!shown && now.restores) setReveal({ status: "restoring" });
    // Keep the occurrence the reviewer chose, such as a clicked pin, while it still matches.
    const chosen = selectedRef.current?.threadId === thread._id ? selectedRef.current.anchor : null;
    let result;
    try {
      result = await page.request("reveal", { threadId: thread._id, location, chosen }, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      fail(errorMessage(error), { keepOccurrence: true });
      return;
    }
    if (controller.signal.aborted) return;
    if (result.status === "failed") {
      fail(result.reason, { keepOccurrence: result.keepOccurrence });
      return;
    }
    // A target entirely behind the open sidebar would have no visible pin, so the sidebar makes way.
    if (page.overPage && sidebarState.current.open && result.rect.x >= window.innerWidth - sidebarWidth()) {
      sidebarState.current.setOpen(false);
    }
    const anchor = result.occurrence;
    setSelected((current) => (current?.threadId === thread._id ? { ...current, anchor } : current));
    setHighlight({ id: ++highlights.current, location: { ...location } });
    setReveal({ status: "shown" });
  }, [page]);

  const select = useCallback(
    (threadId: string, options: { messageId?: string | null; reveal?: boolean; anchor?: Occurrence | null } = {}) => {
      revealController.current?.abort();
      setReveal({ status: "idle" });
      setHighlight(null);
      const active = host.shadowRoot?.activeElement;
      setSelected({
        id: ++selections.current,
        threadId,
        messageId: options.messageId ?? null,
        reveal: options.reveal ?? true,
        anchor: options.anchor ?? null,
        returnFocus: active instanceof HTMLElement ? active : null,
      });
      setPanel("comments");
    },
    [host],
  );

  const closeThread = useCallback(() => {
    revealController.current?.abort();
    setSelected(null);
    setReveal({ status: "idle" });
  }, []);

  // Reveal once the selected thread's location is known.
  useEffect(() => {
    if (selected === null || !selected.reveal) return;
    const thread = byId.get(selected.threadId);
    if (thread === undefined) return;
    setSelected({ ...selected, reveal: false });
    void revealThread({ _id: selected.threadId, location: thread.location });
  }, [selected, byId, revealThread]);

  // A link can also arrive through the app's own navigation while Critiqs stays mounted.
  const pageUrl = pageState.url;
  useEffect(() => {
    const link = parseLink(pageUrl);
    if (link === null) return;
    setPendingLink((current) =>
      current?.threadId === link.threadId && current.messageId === link.messageId ? current : link,
    );
  }, [pageUrl]);

  // Checkout returns to the panel's own address, which installed is the page's; checked again as the page changes.
  useEffect(() => {
    if (!billingOffered) return;
    const returned = parseBillingReturn(window.location.href);
    if (returned === null) return;
    setBilling(returned);
    window.history.replaceState(window.history.state, "", removeBillingReturn(window.location.href));
  }, [pageState.version, billingOffered]);

  // Shareable links open their message once the reviewer is signed in (F10).
  useEffect(() => {
    if (pendingLink === null) return;
    if (!signedIn || projectId === null) {
      setSidebarOpen(true);
      return;
    }
    select(pendingLink.threadId, { messageId: pendingLink.messageId });
    // Show resolved threads too, so the linked one is visible in context.
    setFilters((current) => ({ ...current, status: "all" }));
    setPendingLink(null);
    // Only a link in the page's address is taken out of it; a comment the panel was asked to open never touched it.
    if (parseLink(page.getState().url) !== null) void page.request("removeLink", {}).catch((error) => console.warn("Critiqs: the link couldn't be taken out of the page's address", error));
  }, [pendingLink, signedIn, projectId, select, setSidebarOpen, page]);

  const linkFor = useCallback(
    (pageUrl: string, threadId: string, messageId: string | null) =>
      buildLink(new URL(page.getState().url).origin, pageUrl, { threadId, messageId }),
    [page],
  );
  // A thread's shared link: its page on the Critiqs website, where the backend reports one, so it opens on phones and
  // for people without Critiqs installed; otherwise the prototype's link, as before thread pages.
  const website = deployment.website;
  const shareLink = useCallback(
    async (pageUrl: string, threadId: string) =>
      website === undefined ? linkFor(pageUrl, threadId, null) : threadPageLink(website, await transport.threadPageKey(threadId)),
    [website, transport, linkFor],
  );

  // ---------------------------------------------------------------------------
  // Commenting


  const updateReply = useCallback((threadId: string, change: (reply: ReplyState) => ReplyState) => {
    setReplies((current) => ({ ...current, [threadId]: change(current[threadId] ?? EMPTY_REPLY) }));
  }, []);

  const sendReply = useCallback(
    async (threadId: string) => {
      const { draft, sending } = repliesRef.current[threadId] ?? EMPTY_REPLY;
      if (draft.text.trim() === "" || sending) return;
      const access = accessEpoch.current;
      updateReply(threadId, (reply) => ({ ...reply, sending: true, error: null }));
      try {
        const mentions = mentionsInText(draft);
        await transport.reply({ threadId, body: draft.text, revision: props.version ?? null, mentions });
        if (accessEpoch.current !== access) return;
        // Clear only the text that was sent; anything typed since stays.
        updateReply(threadId, (reply) => ({
          draft: reply.draft.text === draft.text ? EMPTY_MENTION_TEXT : reply.draft,
          sending: false,
          error: null,
        }));
      } catch (error) {
        if (accessEpoch.current !== access) return;
        updateReply(threadId, (reply) => ({ ...reply, sending: false, error: errorMessage(error) }));
      }
    },
    [transport, props.version, updateReply],
  );

  const pick = useCallback(
    (target: PageEvents["picked"]) => {
      if (reattaching !== null) {
        const access = accessEpoch.current;
        const threadId = reattaching;
        const current = target.context;
        const scope = target.target.recordKey === null ? "shared" : (byId.get(threadId)?.location.scope ?? "record");
        setReattaching(null);
        setMode("browse");
        transport
          .reattach({
          threadId,
          location: { screen: current.screen, viewState: current.viewState, target: target.target, scope },
        })
          .then(() => {
            if (accessEpoch.current !== access || access.reviewerId === null) return;
            notify("Thread reattached. Its original capture and context are kept.");
            select(threadId, { anchor: target.occurrence });
          })
          .catch((error) => notify(errorMessage(error)));
        return;
      }
      closeThread();
      setPicked({ occurrence: target.occurrence, target: target.target });
      setComment(emptyComment(target));
      setSaveError(null);
    },
    [reattaching, byId, transport, notify, select, closeThread],
  );

  const cancelComment = useCallback(() => {
    setPicked(null);
    setComment(null);
    setSaveError(null);
  }, []);

  /**
   * Captures the view for a new comment: from a screenshot supplied from
   * outside the page, with Critiqs's pins hidden while it is taken, or else
   * from the page's structure.
   */
  const captureForComment = useCallback(
    async (marker: Rect | null): Promise<CaptureOutcome> => {
      if (supplyCapture === undefined) return await page.request("capture", { marker, image: null }, { timeoutMs: PAGE_CAPTURE_MS });
      await page.request("conceal", { concealed: true }, { timeoutMs: PAGE_ANSWER_MS });
      let image: Blob | null;
      try {
        image = await supplyCapture();
      } catch {
        image = null;
      } finally {
        await page.request("conceal", { concealed: false }, { timeoutMs: PAGE_ANSWER_MS }).catch(() => undefined);
      }
      return await page.request("capture", { marker, image }, { timeoutMs: PAGE_CAPTURE_MS });
    },
    [page, supplyCapture],
  );

  const submitComment = useCallback(async () => {
    const access = accessEpoch.current;
    if (!signedIn || access.reviewerId === null || picked === null || comment === null || projectId === null) return;
    // The comment belongs to this reviewer and to the page it was written on:
    // if the prototype showed another page meanwhile, the draft was discarded
    // there, and nothing of it is saved.
    const pageDocument = page.getState().document;
    const stillCurrent = () => accessEpoch.current === access && page.getState().document === pageDocument;
    setSaving(true);
    setSaveError(null);
    try {
      const measured = await page.request("measure", { ref: picked.occurrence.ref }, { timeoutMs: PAGE_ANSWER_MS });
      if (!stillCurrent()) return;
      const current = measured.context;
      const { marker } = measured;
      const anchor: Anchor = {
        screen: current.screen,
        viewState: current.viewState,
        target: picked.target,
        scope: comment.scope,
        evidence: {
          url: removeLink(measured.url),
          viewport: measured.viewport,
          marker,
          capturedAt: Date.now(),
          revision: props.version ?? null,
          persona: current.persona,
          userAgent: measured.userAgent,
        },
      };
      let captured = await captureForComment(marker);
      if (!stillCurrent()) return;
      // The page keeps running while it is copied; a capture of another view
      // than the one the comment names would mislead, so it is not kept.
      const after = (await page.request("measure", { ref: null }, { timeoutMs: PAGE_ANSWER_MS })).context;
      if (after.screen !== current.screen || !sameViewState(current.viewState, after.viewState)) {
        captured = { status: "failed", reason: "The view changed while it was being captured." };
      }
      let capture: NewCapture;
      if (captured.status === "captured") {
        try {
          capture = { status: "captured", fileId: await transport.uploadImage(projectId, captured.image) };
        } catch {
          capture = { status: "failed", failureReason: "The capture could not be uploaded." };
        }
      } else {
        capture = { status: "failed", failureReason: captured.reason };
      }
      if (!stillCurrent()) return;
      // From here the comment is being created: a page change no longer
      // discards it, and the reviewer hears that it was saved.
      creating.current = true;
      let threadId: string;
      try {
        threadId = await transport.createThread({
          projectId,
          anchor,
          body: comment.body.text,
          tags: comment.tags,
          capture,
          mentions: mentionsInText(comment.body),
        });
      } finally {
        creating.current = false;
      }
      if (accessEpoch.current !== access) return;
      cancelComment();
      if (page.getState().document !== pageDocument) {
        notify("Comment saved. The prototype showed another page meanwhile, so it isn't open here.");
        return;
      }
      select(threadId, { reveal: false, anchor: picked.occurrence });
      if (capture.status === "failed") {
        notify("Comment saved. Automatic capture failed; you can attach a screenshot in the thread.");
      }
    } catch (error) {
      if (accessEpoch.current === access && (creating.current || page.getState().document === pageDocument)) setSaveError(errorMessage(error));
    } finally {
      if (accessEpoch.current === access) setSaving(false);
    }
  }, [picked, comment, projectId, props.version, page, captureForComment, transport, cancelComment, select, notify]);

  // Keyboard: C toggles Comment mode; M toggles Mockup mode; V returns to
  // Browse mode; Escape closes what is innermost, ending with the side panel,
  // and never changes the mode; Ctrl or Cmd + \ hides or shows all of Critiqs, even
  // while typing. Registered once, at mount and in the capture phase, so it
  // runs before Comment mode's listener stops keys from reaching the
  // prototype; it reads current state from a ref.
  const dismissScopeHelp = useRef<(() => void) | null>(null);
  const keys = useRef({ mode, reattaching, picked, needsSetup, cancelComment, closeThread, hidden, unavailable: required && projectMissing, inMockup, mockupsOffered, chooseMode });
  keys.current = { mode, reattaching, picked, needsSetup, cancelComment, closeThread, hidden, unavailable: required && projectMissing, inMockup, mockupsOffered, chooseMode };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (keys.current.unavailable) return;
      if (isHideShortcut(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setHidden((value) => !value);
        return;
      }
      // Hidden, every other key belongs to the host page.
      if (keys.current.hidden) return;
      // Hovered help may be open while focus is elsewhere, including search.
      if (event.key === "Escape" && dismissScopeHelp.current !== null) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismissScopeHelp.current();
        return;
      }
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event)) return;
      const current = keys.current;
      const picking = current.mode === "comment" || current.reattaching !== null;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      // An open Critiqs menu or dialog handles its own Escape first; while
      // picking, C and V are still kept from the prototype but change nothing.
      if (openLayer(host.shadowRoot)) {
        if (picking && (key === "c" || key === "v")) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      // While picking, the prototype gets no keys, including the ones that end picking.
      if (picking && (key === "Escape" || key === "c" || key === "v")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (key === "v" && (picking || current.inMockup)) {
        // Browse mode, cancelling any reattachment; a comment draft is kept for C.
        setReattaching(null);
        setMode("browse");
      } else if (key === "Escape" && current.inMockup) {
        // A chosen element closes first, then the Mockup panel; Mockup mode stays on.
        event.preventDefault();
        if (mockupEscape.current?.() !== true) setMockupPanelOpen(false);
      } else if (key === "Escape") {
        // The innermost thing closes first: a new comment, a replacement being
        // chosen, an open thread, then the side panel. The mode stays as it is.
        // A new comment's composer shows only in Comment mode; in Browse mode
        // its text is kept for C, so Escape leaves it alone.
        if (current.mode === "comment" && current.picked !== null) return current.cancelComment();
        if (current.reattaching !== null) return setReattaching(null);
        if (selectedRef.current !== null) return current.closeThread();
        sidebarState.current.setOpen(false);
      } else if (key === "c" && !current.needsSetup) {
        // Handled, so the key types nothing: C can open a kept draft's comment
        // field, which takes focus before the key's text would arrive.
        event.preventDefault();
        setMode((mode) => (mode === "comment" ? "browse" : "comment"));
      } else if (key === "m" && current.mockupsOffered) {
        event.preventDefault();
        current.chooseMode(current.mode === "mockup" ? "browse" : "mockup");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [host]);

  // Leaving Comment mode discards an empty new comment, but keeps one with
  // text: Comment mode (C) brings it back beside its element.
  const commentRef = useRef(comment);
  commentRef.current = comment;
  useEffect(() => {
    if (mode !== "browse") return;
    const draft = commentRef.current;
    if (draft !== null && draft.body.text.trim() !== "") {
      notify("Comment draft kept. Press C to go back to it.");
      return;
    }
    cancelComment();
  }, [mode, cancelComment, notify]);

  // Hiding keeps everything mounted, so drafts, the open thread, and dialogs
  // return as they were. Focus leaves Critiqs while hidden and comes back after.
  const focusBeforeHide = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (hidden) {
      const active = host.shadowRoot?.activeElement;
      focusBeforeHide.current = active instanceof HTMLElement ? active : null;
      focusBeforeHide.current?.blur();
      host.style.setProperty("display", "none", "important");
      return;
    }
    host.style.removeProperty("display");
    const previous = focusBeforeHide.current;
    focusBeforeHide.current = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }, [hidden, host]);

  // Mockup mode covers the prototype with its copy, so a thread open beside the prototype closes.
  useEffect(() => {
    if (!inMockup) return;
    closeThread();
    setReattaching(null);
  }, [inMockup, closeThread]);
  useEffect(() => {
    if (mode !== "mockup") setMockupRequest(null);
  }, [mode]);

  /** A frozen copy of the page, with where it came from, for Mockup mode. */
  const copyPage = useCallback(() => page.request("copyPage", {}), [page]);

  /** Shows the page a mockup thread was made on, as showing a thread's view does, and waits for the app to report it and show its record. */
  const showMockupPage: ShowPage = useCallback(
    async ({ threadId, screen, viewState, recordKey, signal }) =>
      (await page.request("showPage", { threadId, screen, viewState, recordKey }, { signal }).catch(() => ({ shown: false }))).shown,
    [page],
  );

  /** Enters Mockup mode on a mockup, such as from a thread linked to it or a link to one of its threads. */
  const openMockup = useCallback((mockupId: string, threadId: string | null) => {
    setMockupRequest({ id: ++mockupRequests.current, mockupId, threadId });
    setMockupPanelOpen(true);
    setMode("mockup");
  }, []);

  const filterByTag = useCallback(
    (tag: string) => {
      setFilters((current) => ({ ...current, tags: [tag], groups: [], screens: "all" }));
      setSearch({ status: "idle" });
      // The comments list lives in Comment mode; Browse mode's panel shows the project.
      setMode("comment");
      setSidebarOpen(true);
    },
    [setSidebarOpen],
  );

  // ---------------------------------------------------------------------------
  // Pins

  // Every thread whose pin can show; the page layer draws the ones it finds on the page.
  const pins = useMemo(
    () =>
      pageSummaries.flatMap((summary) => {
        // The open thread keeps its pin, such as a resolved thread opened from a link or search.
        const open = summary._id === selected?.threadId;
        if (filters.status !== "all" && summary.status !== filters.status && !open) return [];
        return [{ threadId: summary._id, authorName: summary.preview?.authorName ?? "Unknown", unread: summary.unread, resolved: summary.status === "resolved" }];
      }),
    [pageSummaries, filters.status, selected?.threadId],
  );
  const watch = useMemo(() => pageSummaries.map((summary) => ({ threadId: summary._id, location: locationOf(summary) })), [pageSummaries]);

  // ---------------------------------------------------------------------------
  // Rendering

  const showSetup = panel === "setup" || needsSetup;

  // The thread window stays beside the chosen occurrence, or its replacement on
  // the same record. A thread opened from the list or a link has none until its
  // target is shown in its saved view; until then the window docks.
  const windowAnchor = (() => {
    if (selected === null || selected.anchor === null) return null;
    const located = byId.get(selected.threadId)?.located;
    return followOccurrence(selected.anchor, located?.status === "found" ? located.occurrences : []);
  })();
  const picking = (mode === "comment" && !needsSetup) || reattaching !== null;
  /** The new comment's popover shows in Comment mode; in Browse mode a draft waits for C. */
  const composing = picked !== null && comment !== null && mode === "comment";
  /** The element itself, where the panel shares the page's document and is drawn beside it. */
  const elementOf = (occurrence: Occurrence | null) => (occurrence === null || page.element === null ? null : page.element(occurrence.ref));
  const pickedElement = composing ? elementOf(picked.occurrence) : null;

  // What the page layer draws: pins, the revealed target's outline, and Comment mode's selection.
  const windowAnchorRef = windowAnchor?.ref ?? null;
  const coveredFrom = page.overPage && sidebarOpen ? windowWidth - sideWidth : null;
  const showPins = signedIn && !showSetup && !inMockup;
  const pickingShown = signedIn && picking && !hidden;
  const pickingHint = picked !== null ? null : reattaching !== null ? "Select the replacement element · Esc to cancel" : "Comment mode: select an element · V to leave";
  const pickedRef = !page.overPage && composing ? picked.occurrence.ref : null;
  const display: PageDisplay = useMemo(
    () => ({
      hidden,
      exposedRight: coveredFrom,
      watch,
      pins: showPins ? pins : [],
      selected: selected === null ? null : { threadId: selected.threadId, ref: windowAnchorRef },
      highlight: signedIn && !inMockup ? highlight : null,
      picking: pickingShown ? { hint: pickingHint, paused: picked !== null } : null,
      picked: pickedRef,
    }),
    [hidden, coveredFrom, watch, showPins, pins, selected?.threadId, windowAnchorRef, signedIn, inMockup, highlight, pickingShown, pickingHint, picked, pickedRef],
  );
  useLayoutEffect(() => page.display(display), [page, display]);

  // What the reviewer does on the page: pick an element, click beside the composer, or click a pin.
  const pageHandlers = useRef({ pick, select, outsideClick: () => {} });
  pageHandlers.current = {
    pick,
    select,
    outsideClick: () => {
      if (comment?.body.text.trim() === "") cancelComment();
    },
  };
  useEffect(() => {
    const stops = [
      page.on("picked", (event) => pageHandlers.current.pick(event)),
      page.on("outsideClick", () => pageHandlers.current.outsideClick()),
      page.on("pin", ({ threadId, occurrence }) => pageHandlers.current.select(threadId, { anchor: occurrence, reveal: false })),
    ];
    return () => stops.forEach((stop) => stop());
  }, [page]);
  const searchScope: SearchScope = { status: filters.status, screen: filters.screens === "current" ? context.screen : null };
  const isOwner = projectQuery.status === "ready" && projectQuery.data.isOwner;

  /** Browse mode's panel shows the project; Comment mode's shows its comments. */
  const projectView = mode === "browse";
  const panelTitle = projectView ? "Project" : "Comments";
  const panelLabel = projectView ? "Critiqs project" : "Critiqs comments";
  const sidebar = (() => {
    if (backendRejected) {
      return (
        <SidebarFrame title={panelTitle} label={panelLabel} onClose={() => setSidebarOpen(false)}>
          <div className="empty">
            <strong>Sign-in not accepted</strong>
            <span>This Critiqs backend did not accept your sign-in. It may trust a different sign-in service.</span>
            <button type="button" className="btn" onClick={signOut}>
              Sign out
            </button>
          </div>
        </SidebarFrame>
      );
    }
    if (showSetup) {
      return (
        <SidebarFrame title="Project setup" onClose={() => setSidebarOpen(false)}>
          <Setup
            reviewer={reviewer}
            signedIn={signedIn}
            organizations={organizationMembers}
            onSignIn={signIn}
            configuredProjectId={configuredProject}
            browserProjectId={browserProject}
            onUseProject={(id) => {
              setBrowserProject(id);
              // Stay in setup to show the snippet for the new project.
              setPanel("setup");
            }}
            onDone={() => {
              setPanel("comments");
              // "Start commenting" for a project not yet in the code; otherwise back to this mode's panel.
              if (configuredProject === null) setMode("comment");
            }}
            backLabel={projectView ? "Back to project" : "Back to comments"}
            notify={notify}
          />
        </SidebarFrame>
      );
    }
    if (panel === "docs") {
      return (
        <SidebarFrame
          title="Documentation"
          label="Critiqs documentation"
          onClose={() => setSidebarOpen(false)}
          actions={
            <button type="button" className="btn small" onClick={() => setPanel("comments")}>
              {projectView ? "Back to project" : "Back to comments"}
            </button>
          }
        >
          <DocsPanel onClose={() => setSidebarOpen(false)} />
        </SidebarFrame>
      );
    }
    if (!signedIn) {
      return (
        <SidebarFrame title={panelTitle} label={panelLabel} onClose={() => setSidebarOpen(false)}>
          <div className="empty">
            <strong>
              {pendingLink !== null ? "Sign in to open the linked comment" : projectView ? "Sign in to see this project" : "Sign in to see feedback"}
            </strong>
            <span>Reviewers sign in with a verified email so everyone knows who wrote what.</span>
            <button type="button" className="btn primary" onClick={signIn} disabled={reviewer !== null}>
              {reviewer !== null ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </SidebarFrame>
      );
    }
    if (projectQuery.status === "error" && projectQuery.code === "forbidden") {
      return (
        <SidebarFrame title={panelTitle} label={panelLabel} onClose={() => setSidebarOpen(false)}>
          <div className="empty">
            <strong>No access to this project</strong>
            <span>{projectQuery.message}</span>
          </div>
        </SidebarFrame>
      );
    }
    if (projectQuery.status === "error") {
      return (
        <SidebarFrame title={panelTitle} label={panelLabel} onClose={() => setSidebarOpen(false)}>
          <div className="empty">
            <strong>Project not found</strong>
            <span>
              {configuredProject !== null
                ? "The project ID in this prototype's code isn't known to this Critiqs backend."
                : "The project remembered in this browser no longer exists."}
            </span>
            {!required && (
              <button type="button" className="btn" onClick={() => setPanel("setup")}>
                Open project setup
              </button>
            )}
          </div>
        </SidebarFrame>
      );
    }
    if (projectView) {
      return (
        <SidebarFrame title={projectQuery.status === "ready" ? projectQuery.data.name : "Project"} label="Critiqs project" onClose={() => setSidebarOpen(false)}>
          {projectQuery.status !== "ready" || reviewer === null ? (
            <div className="empty">Loading…</div>
          ) : (
            <ProjectPanel
              project={projectQuery.data}
              reviewer={reviewer}
              openCount={threads.filter((thread) => thread.summary.status === "open").length}
              unreadCount={unreadCount}
              onShowComments={() => setMode("comment")}
              onNotifications={() => setNotificationsOpen(true)}
              onSetup={() => setPanel("setup")}
              onDocs={() => setPanel("docs")}
              notify={notify}
            />
          )}
        </SidebarFrame>
      );
    }
    return (
      <SidebarFrame
        title="Comments"
        onClose={() => setSidebarOpen(false)}
        actions={
          <>
            {isOwner && (
              <button type="button" className="icon-btn" title="Tags and AI" aria-label="Tags and AI settings" onClick={() => setTagsDialog("groups")}>
                <TagsIcon />
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-pressed={selecting}
              title="Select threads to export"
              aria-label="Select threads to export"
              onClick={() => {
                setSelecting(!selecting);
                setChecked(new Set());
              }}
            >
              <SelectIcon />
            </button>
            <FilterButton
              filters={filters}
              tags={tagInfo === null ? projectTags : tagInfo.tags.map((tag) => tag.label)}
              groups={(tagInfo?.groups ?? []).map((group) => ({ ...group, members: groupMembers(tagInfo, group._id) }))}
              onFilters={setFilters}
            />
          </>
        }
        footer={
          selecting ? (
            <div className="row between">
              <span className="note">{checked.size} selected</span>
              <div className="row">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setChecked(new Set(threads.map((thread) => thread.summary._id as string)))}
                >
                  Select all
                </button>
                <button type="button" className="link-btn" onClick={() => setChecked(new Set())}>
                  Clear
                </button>
                <button type="button" className="btn primary small" disabled={checked.size === 0} onClick={() => setExporting(true)}>
                  Export…
                </button>
              </div>
            </div>
          ) : null
        }
      >
        {configuredProject === null && (
          <p className="banner">
            This project is remembered only in this browser until its ID is in the prototype's code.{" "}
            <button type="button" className="link-btn" onClick={() => setPanel("setup")}>
              Finish setup
            </button>
          </p>
        )}
        {projectId !== null && <SearchBox projectId={projectId} scope={searchScope} state={search} onState={setSearch} />}
        {search.status !== "idle" ? (
          <SearchResults
            state={search}
            tags={tagInfo}
            onOpen={(threadId, messageId) => select(threadId, { messageId })}
            onTag={filterByTag}
            onSetUpAi={openYourAi}
          />
        ) : threadsQuery.status === "loading" ? (
          <div className="empty">Loading…</div>
        ) : threadsQuery.status === "error" ? (
          <div className="empty">{threadsQuery.message}</div>
        ) : (
          <ThreadList
            tags={tagInfo}
            onTag={filterByTag}
            threads={threads}
            currentScreen={context.screen}
            filters={filters}
            defaultFilters={DEFAULT_FILTERS}
            onFilters={setFilters}
            selectedId={selected?.threadId ?? null}
            onSelect={(threadId) => select(threadId)}
            selecting={selecting}
            checked={checked}
            onCheck={(threadId, value) =>
              setChecked((current) => {
                const next = new Set(current);
                if (value) next.add(threadId);
                else next.delete(threadId);
                return next;
              })
            }
            onStartCommenting={() => setMode("comment")}
            commenting={mode === "comment"}
          />
        )}
      </SidebarFrame>
    );
  })();

  // Configured deployments keep project failures in the developer console, including failures after health succeeds.
  if (required && projectMissing) return null;

  return (
    <HiddenContext.Provider value={hidden}>
    <OpenBillingContext.Provider value={openBilling}>
    <div className="layer" aria-hidden={hidden || undefined}>
      {inMockup && projectId !== null && (
        <MockupMode
          key={mockupRequest?.id ?? 0}
          host={host}
          projectId={projectId}
          context={context}
          copyPage={copyPage}
          version={props.version ?? null}
          pageThreads={threads}
          request={mockupRequest}
          panelOpen={mockupPanelOpen}
          escapeRef={mockupEscape}
          showPage={pageState.restores ? showMockupPage : null}
          onClose={() => setMockupPanelOpen(false)}
          onOpenAiSettings={isOwner ? () => setTagsDialog("ai") : null}
          onSetUpAi={openYourAi}
          modelLists={deployment.modelLists === true}
          notify={notify}
        />
      )}
      {sidebarOpen && !inMockup && sidebar}
      {signedIn && !showSetup && !backendRejected && !inMockup && selected !== null && projectId !== null && projectQuery.status === "ready" && (
        <ThreadWindow
          key={selected.threadId}
          selectionId={selected.id}
          anchor={elementOf(windowAnchor)}
          sidebarOpen={sidebarOpen}
          host={host}
          returnFocus={selected.returnFocus}
          onClose={closeThread}
        >
          {(targetShown) => (
            <ThreadView
              threadId={selected.threadId}
              focusMessageId={selected.messageId}
              selectionId={selected.id}
              projectId={projectId}
              live={byId.get(selected.threadId)}
              version={props.version ?? null}
              reveal={reveal}
              linkFor={(pageUrl, messageId) => linkFor(pageUrl, selected.threadId, messageId)}
              shareLink={(pageUrl) => shareLink(pageUrl, selected.threadId)}
              targetShown={targetShown}
              reply={replies[selected.threadId] ?? EMPTY_REPLY}
              onDraft={(draft) => updateReply(selected.threadId, (reply) => ({ ...reply, draft }))}
              onSend={() => void sendReply(selected.threadId)}
              onClose={closeThread}
              onShow={() => {
                const thread = byId.get(selected.threadId);
                if (thread !== undefined) void revealThread({ _id: selected.threadId, location: thread.location });
              }}
              onReattach={() => {
                setReattaching(selected.threadId);
                notify("Select the element this comment should point to. Press Escape to cancel.");
              }}
              notify={notify}
              onTag={filterByTag}
              onOpenMockup={mockupsAvailable ? openMockup : undefined}
            />
          )}
        </ThreadWindow>
      )}
      {signedIn && composing && (
        <Composer
          dismissHelpRef={dismissScopeHelp}
          picked={{ element: pickedElement, target: picked!.target }}
          comment={comment!}
          onChange={setComment}
          context={context}
          projectId={projectId ?? ""}
          reviewer={signedIn ? reviewer : null}
          saving={saving}
          error={saveError}
          onSignIn={signIn}
          onSubmit={() => void submitComment()}
          onCancel={cancelComment}
          rightEdge={sidebarOpen ? windowWidth - sideWidth : windowWidth}
        />
      )}
      <Toolbar
        mode={mode === "mockup" && !mockupsOffered ? "browse" : mode}
        onMode={chooseMode}
        mockupAvailable={mockupsOffered}
        sidebarOpen={inMockup ? mockupPanelOpen : sidebarOpen}
        onToggleSidebar={() => (inMockup ? setMockupPanelOpen(!mockupPanelOpen) : setSidebarOpen(!sidebarOpen))}
        unreadCount={unreadCount}
        reviewer={reviewer}
        onSignIn={signIn}
        onSignOut={signOut}
        onRename={() => setRenaming(true)}
        onYourAi={openYourAi}
        onOrganization={openOrganization}
        onBilling={openBilling === null ? null : () => openBilling.open()}
        onNotifications={signedIn && projectQuery.status === "ready" ? () => setNotificationsOpen(true) : null}
        needsSetup={needsSetup}
        onSetup={() => {
          setPanel("setup");
          setSidebarOpen(true);
        }}
        avoid={pickedElement?.getBoundingClientRect() ?? null}
        sidebarLeft={(inMockup ? mockupPanelOpen : sidebarOpen) ? windowWidth - sideWidth : undefined}
      />
      {signedIn && exporting && projectId !== null && (
        <ExportDialog
          projectId={projectId}
          threadIds={[...checked]}
          linkFor={linkFor}
          onClose={() => setExporting(false)}
          notify={notify}
        />
      )}
      {reviewer !== null && renaming && (
        <NameDialog
          current={reviewer.name}
          onSave={async (name) => {
            const applied = await session.setDisplayName(name);
            notify(applied ? "Display name changed" : "Name saved. It will show once Critiqs reconnects.");
          }}
          onClose={() => setRenaming(false)}
        />
      )}
      {signedIn && notificationsOpen && projectId !== null && projectQuery.status === "ready" && (
        <NotificationsDialog projectId={projectId} projectName={projectQuery.data.name} onClose={() => setNotificationsOpen(false)} />
      )}
      {organizationOpen && openOrganization !== null && (
        <OrganizationDialog
          projectOrganizationId={projectQuery.status === "ready" ? (projectQuery.data.organization?.id ?? null) : null}
          projectId={projectId}
          onClose={() => setOrganizationOpen(false)}
          notify={notify}
        />
      )}
      {yourAiOpen && openYourAi !== null && <YourAiDialog onClose={() => setYourAiOpen(false)} notify={notify} modelLists={deployment.modelLists === true} />}
      {signedIn && tagsDialog !== null && isOwner && projectId !== null && (
        <TagsAiDialog
          projectId={projectId}
          initialTab={tagsDialog}
          onClose={() => setTagsDialog(null)}
          notify={notify}
          modelLists={deployment.modelLists === true}
          presetTags={deployment.presetTags === true}
        />
      )}
      {billing !== null && openBilling !== null && transport.billing !== undefined && (
        <BillingDialog billing={transport.billing} organizationId={billing.organizationId} awaiting={billing.awaiting} onClose={() => setBilling(null)} notify={notify} />
      )}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
    </OpenBillingContext.Provider>
    </HiddenContext.Provider>
  );
}

/** The occurrence to stay beside after the page changes: the chosen one while it still matches, else the one on the same record. */
function followOccurrence(chosen: Occurrence, occurrences: Occurrence[]): Occurrence | null {
  return occurrences.find((occurrence) => occurrence.ref === chosen.ref) ?? occurrences.find((occurrence) => occurrence.recordKey === chosen.recordKey) ?? null;
}

const EMPTY: ThreadSummary[] = [];
/** Projects recorded as opened during this page load, by backend, reviewer, and project. */
const recordedOpens = new Set<string>();
const EMPTY_TAGS: string[] = [];
const EMPTY_REPLY: ReplyState = { draft: EMPTY_MENTION_TEXT, sending: false, error: null };

function SidebarFrame({
  title,
  label = "Critiqs comments",
  onClose,
  actions,
  footer,
  children,
}: {
  title: string;
  /** The panel's accessible name: Browse mode's panel is the project's. */
  label?: string;
  onClose: () => void;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const width = useSidebarWidth();
  return (
    <aside className="sidebar" aria-label={label} style={{ width }}>
      <SidebarResizer />
      <div className="sidebar-header">
        <h2>{title}</h2>
        {actions}
        <button type="button" className="icon-btn" aria-label="Close sidebar" title="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="sidebar-body">{children}</div>
      {footer && <div className="sidebar-footer">{footer}</div>}
    </aside>
  );
}
