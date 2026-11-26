import {
  type Anchor,
  type NewCapture,
  buildLink,
  recordKeyOf,
  DEFAULT_FILTERS,
  type LocateResult,
  parseLink,
  removeLink,
  type SearchScope,
  type SidebarFilters,
  type TargetLocation,
  type ViewState,
  waitForTarget,
} from "@critiqs/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { captureView } from "./capture.ts";
import { waitForViewMotion } from "./motion.ts";
import type { Deployment } from "./deployment.ts";
import { type CritiqsProps, readContext, type ResolvedContext } from "./host.ts";
import { errorMessage, useTransport } from "./transport.ts";
import { isHideShortcut, isTyping, usePageVersion, useStoredState } from "./hooks.ts";
import { isShown, type LiveThread, locateShown, locationOf, type ThreadSummary } from "./model.ts";
import { type ReviewerSession, SignInError } from "./session.ts";
import { openLayer, Toasts, useToasts } from "./ui/common.tsx";
import { ExportDialog } from "./ui/ExportDialog.tsx";
import { HiddenContext } from "./ui/hidden.ts";
import { CloseIcon, SelectIcon, TagsIcon } from "./ui/icons.tsx";
import { describeViewState } from "./ui/format.ts";
import { EMPTY_MENTION_TEXT, mentionsInText } from "./ui/MentionInput.tsx";
import { NameDialog } from "./ui/NameDialog.tsx";
import { NotificationsDialog } from "./ui/NotificationsDialog.tsx";
import { Composer, emptyComment, type NewComment, type PickedTarget, Picker } from "./ui/Picker.tsx";
import { Highlight, type PinTarget, Pins } from "./ui/Pins.tsx";
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
import { followOccurrence, ThreadWindow } from "./ui/ThreadWindow.tsx";
import { SidebarResizer, sidebarWidth, useSidebarWidth, useWindowWidth } from "./ui/sidebar-width.tsx";
import { type Mode, Toolbar } from "./ui/Toolbar.tsx";
import { type MockupRequest, MockupMode, pageRecordKey, type ShowPage } from "./ui/mockup/MockupMode.tsx";

interface Selected {
  /** Distinguishes each opening, including reopening the same thread from another pin. */
  id: number;
  threadId: string;
  messageId: string | null;
  /** Reveal the target in the prototype once the thread is known. */
  reveal: boolean;
  /** The occurrence the thread window sits beside: the clicked pin's, or the one revealed. */
  anchor: { element: Element; recordKey: string | null } | null;
  /** The control that opened the thread, which gets focus back when it closes. */
  returnFocus: HTMLElement | null;
}

type Panel = "comments" | "setup" | "docs";

export function App({
  props,
  deployment,
  session,
  host,
}: {
  props: CritiqsProps;
  deployment: Deployment;
  session: ReviewerSession;
  host: HTMLElement;
}) {
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
  const [picked, setPicked] = useState<PickedTarget | null>(null);
  const [comment, setComment] = useState<NewComment | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reattaching, setReattaching] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealState>({ status: "idle" });
  const [highlight, setHighlight] = useState<TargetLocation | null>(null);
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
  const [pendingLink, setPendingLink] = useState(() => parseLink(window.location.href));
  // Mockup mode: a mockup to open on entering it, its panel (in the sidebar's place), and what Escape closes there.
  const [mockupRequest, setMockupRequest] = useState<MockupRequest | null>(null);
  const mockupRequests = useRef(0);
  const [mockupPanelOpen, setMockupPanelOpen] = useState(true);
  const mockupEscape = useRef<(() => boolean) | null>(null);

  const pageVersion = usePageVersion();
  const context = useMemo(() => readContext(props.getContext), [pageVersion, props.getContext]);
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

  // Where every thread's target is now. Recomputed as the prototype's page changes.
  // Mockup threads belong to Mockup mode's panel only; backends leave them out of the list too.
  const threads: LiveThread[] = useMemo(
    () =>
      summaries.filter((summary) => summary.mockup === undefined).map((summary) => {
        const location = locationOf(summary);
        const located = location.screen === context.screen ? locateShown(location) : null;
        const sameView = sameViewState(location.viewState, context.viewState);
        return { summary, location, located, sameView };
      }),
    [summaries, context, pageVersion],
  );
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.summary._id as string, thread])), [threads]);
  // Mockup is offered where the backend stores mockups and the project is set up; signed out, it asks to sign in, as Comment does.
  const mockupsOffered = transport.mockups !== undefined && deployment.mockups === true && !needsSetup && !backendRejected && !projectError;
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

  const signOut = useCallback(() => {
    revealController.current?.abort();
    setSelected(null);
    setMode("browse");
    void session.signOut();
  }, [session]);

  // ---------------------------------------------------------------------------
  // Selecting and revealing threads

  // The host's functions as of its latest render: a restore changes the app's
  // state, and the context Critiqs checks afterwards must be the new one.
  const hostProps = useRef(props);
  hostProps.current = props;

  /**
   * Shows a thread's target where it was left: its saved screen and view state,
   * then the target itself. A matching element in another view doesn't count,
   * so the host restores the view unless it is already shown.
   */
  const revealThread = useCallback(async (thread: { _id: string; location: TargetLocation }) => {
    revealController.current?.abort();
    const controller = new AbortController();
    revealController.current = controller;
    const { location } = thread;
    const inSavedView = ({ restored = false }: { restored?: boolean } = {}) => {
      const current = readContext(hostProps.current.getContext);
      return current.screen === location.screen && sameViewState(location.viewState, current.viewState, { restored });
    };
    const inRestoredView = () => inSavedView({ restored: true });
    const fail = (reason: string, { keepOccurrence }: { keepOccurrence: boolean }) => {
      // After the prototype changed views, the chosen occurrence may be an unrelated
      // element, so the window docks beside the sidebar with the saved context.
      if (!keepOccurrence) {
        setSelected((current) => (current?.threadId === thread._id ? { ...current, anchor: null } : current));
      }
      setReveal({ status: "failed", reason });
    };

    let located: LocateResult = inSavedView() ? locateShown(location) : { status: "not-found" };
    if (located.status !== "found") {
      const { restoreContext } = hostProps.current;
      if (restoreContext === undefined) {
        fail(notRestoredReason(location, readContext(hostProps.current.getContext)), { keepOccurrence: true });
        return;
      }
      setReveal({ status: "restoring" });
      try {
        const shown = await restoreContext({
          threadId: thread._id,
          screen: location.screen,
          viewState: location.viewState,
          recordKey: location.target.recordKey,
          scope: location.scope,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (shown === false) {
          fail("The prototype couldn't show this view right now.", { keepOccurrence: true });
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        fail(`The prototype couldn't show this view${error instanceof Error ? `: ${error.message}` : "."}`, {
          keepOccurrence: true,
        });
        return;
      }
      // Wait for the app to report the saved view and for its content to render.
      located = await waitForTarget(location.target, location.scope, document.body, {
        timeoutMs: RESTORE_TIMEOUT_MS,
        signal: controller.signal,
        isCandidate: isShown,
        ready: inRestoredView,
      });
      if (controller.signal.aborted) return;
      if (!inRestoredView()) {
        fail(wrongViewReason(location, readContext(hostProps.current.getContext)), { keepOccurrence: false });
        return;
      }
    }

    if (located.status === "found") {
      // Keep the occurrence the reviewer chose, such as a clicked pin, while it still matches.
      const chosen = selectedRef.current?.threadId === thread._id ? selectedRef.current.anchor : null;
      const getCurrent = () => {
        const current = locateShown(location);
        return current.status === "found" ? followOccurrence(chosen, current.elements) ?? current.elements[0]! : null;
      };
      const element = await waitForViewMotion(getCurrent, controller.signal, RESTORE_TIMEOUT_MS);
      if (controller.signal.aborted) return;
      if (element === null || !inRestoredView() || getCurrent() !== element) {
        fail("The prototype is still changing its view. Try showing this comment again once it has settled.", { keepOccurrence: false });
        return;
      }
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      // A target entirely behind the open sidebar would have no visible pin, so the sidebar makes way.
      if (sidebarState.current.open && element.getBoundingClientRect().left >= window.innerWidth - sidebarWidth()) {
        sidebarState.current.setOpen(false);
      }
      const anchor = { element, recordKey: recordKeyOf(element) };
      setSelected((current) => (current?.threadId === thread._id ? { ...current, anchor } : current));
      setHighlight({ ...location });
      setReveal({ status: "shown" });
      return;
    }
    fail(
      {
        "not-found": "The element couldn't be found after restoring the view. It may have changed or been removed.",
        "wrong-record": `This comment is about record ${location.target.recordKey}, which isn't shown.`,
        ambiguous: "Several elements match, so Critiqs won't guess which one.",
      }[located.status],
      { keepOccurrence: false },
    );
  }, []);

  const select = useCallback(
    (threadId: string, options: { messageId?: string | null; reveal?: boolean; anchor?: Element | null } = {}) => {
      revealController.current?.abort();
      setReveal({ status: "idle" });
      setHighlight(null);
      const active = host.shadowRoot?.activeElement;
      const element = options.anchor ?? null;
      setSelected({
        id: ++selections.current,
        threadId,
        messageId: options.messageId ?? null,
        reveal: options.reveal ?? true,
        anchor: element === null ? null : { element, recordKey: recordKeyOf(element) },
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
  useEffect(() => {
    const link = parseLink(window.location.href);
    if (link === null) return;
    setPendingLink((current) =>
      current?.threadId === link.threadId && current.messageId === link.messageId ? current : link,
    );
  }, [pageVersion]);

  useEffect(() => {
    if (!billingOffered) return;
    const returned = parseBillingReturn(window.location.href);
    if (returned === null) return;
    setBilling(returned);
    window.history.replaceState(window.history.state, "", removeBillingReturn(window.location.href));
  }, [pageVersion, billingOffered]);

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
    window.history.replaceState(window.history.state, "", removeLink(window.location.href));
  }, [pendingLink, signedIn, projectId, select, setSidebarOpen]);

  const linkFor = useCallback(
    (pageUrl: string, threadId: string, messageId: string | null) =>
      buildLink(window.location.origin, pageUrl, { threadId, messageId }),
    [],
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
    (target: PickedTarget) => {
      if (reattaching !== null) {
        const access = accessEpoch.current;
        const threadId = reattaching;
        const current = readContext(props.getContext);
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
            select(threadId, { anchor: target.element });
          })
          .catch((error) => notify(errorMessage(error)));
        return;
      }
      closeThread();
      setPicked(target);
      setComment(emptyComment(target));
      setSaveError(null);
    },
    [reattaching, props.getContext, byId, transport, notify, select, closeThread],
  );

  const cancelComment = useCallback(() => {
    setPicked(null);
    setComment(null);
    setSaveError(null);
  }, []);

  const submitComment = useCallback(async () => {
    const access = accessEpoch.current;
    if (!signedIn || access.reviewerId === null || picked === null || comment === null || projectId === null) return;
    const stillCurrent = () => accessEpoch.current === access;
    setSaving(true);
    setSaveError(null);
    const current = readContext(props.getContext);
    const rect = picked.element.getBoundingClientRect();
    const marker = { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
    const anchor: Anchor = {
      screen: current.screen,
      viewState: current.viewState,
      target: picked.target,
      scope: comment.scope,
      evidence: {
        url: removeLink(window.location.href),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        marker,
        capturedAt: Date.now(),
        revision: props.version ?? null,
        persona: current.persona,
        userAgent: navigator.userAgent,
      },
    };
    try {
      let captured = await captureView(host, marker);
      if (!stillCurrent()) return;
      // The page keeps running while it is copied; a capture of another view
      // than the one the comment names would mislead, so it is not kept.
      const after = readContext(props.getContext);
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
      const threadId = await transport.createThread({
        projectId,
        anchor,
        body: comment.body.text,
        tags: comment.tags,
        capture,
        mentions: mentionsInText(comment.body),
      });
      if (!stillCurrent()) return;
      cancelComment();
      select(threadId, { reveal: false, anchor: picked.element });
      if (capture.status === "failed") {
        notify("Comment saved. Automatic capture failed; you can attach a screenshot in the thread.");
      }
    } catch (error) {
      if (stillCurrent()) setSaveError(errorMessage(error));
    } finally {
      if (stillCurrent()) setSaving(false);
    }
  }, [picked, comment, projectId, props.getContext, props.version, host, transport, cancelComment, select, notify]);

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

  /** The host's context as it is now, for reading it at the moment something happens. */
  const readHostContext = useCallback(() => readContext(hostProps.current.getContext), []);

  /** Shows the page a mockup thread was made on, as showing a thread's view does, and waits for the app to report it and show its record. */
  const showMockupPage: ShowPage = useCallback(async ({ threadId, screen, viewState, recordKey, signal }) => {
    const { restoreContext } = hostProps.current;
    if (restoreContext === undefined) return false;
    const shown = await restoreContext({ threadId, screen, viewState, recordKey, scope: recordKey === null ? "shared" : "record", signal });
    if (shown === false) return false;
    const deadline = Date.now() + RESTORE_TIMEOUT_MS;
    for (;;) {
      const current = readContext(hostProps.current.getContext);
      const shownRecord = recordKey === null || pageRecordKey(document.body) === recordKey;
      if (current.screen === screen && sameViewState(viewState, current.viewState, { restored: true }) && shownRecord) return true;
      if (signal.aborted || Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, []);

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

  const pinTargets: PinTarget[] = useMemo(
    () =>
      threads.flatMap((thread) => {
        const { summary, located } = thread;
        if (located?.status !== "found") return [];
        // The open thread keeps its pin, such as a resolved thread opened from a link or search.
        const open = summary._id === selected?.threadId;
        if (filters.status !== "all" && summary.status !== filters.status && !open) return [];
        return [
          {
            threadId: summary._id,
            elements: located.elements,
            authorName: summary.preview?.authorName ?? "Unknown",
            unread: summary.unread,
            resolved: summary.status === "resolved",
          },
        ];
      }),
    [threads, filters.status, selected?.threadId],
  );

  // ---------------------------------------------------------------------------
  // Rendering

  const showSetup = panel === "setup" || needsSetup;
  const clearHighlight = useCallback(() => setHighlight(null), []);

  // The thread window stays beside the chosen occurrence, or its replacement on
  // the same record. A thread opened from the list or a link has none until its
  // target is shown in its saved view; until then the window docks.
  const windowAnchor = (() => {
    if (selected === null || selected.anchor === null) return null;
    const located = byId.get(selected.threadId)?.located;
    return followOccurrence(selected.anchor, located?.status === "found" ? located.elements : []);
  })();
  const picking = (mode === "comment" && !needsSetup) || reattaching !== null;
  /** The new comment's popover shows in Comment mode; in Browse mode a draft waits for C. */
  const composing = picked !== null && comment !== null && mode === "comment";
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
          readContext={readHostContext}
          version={props.version ?? null}
          pageThreads={threads}
          request={mockupRequest}
          panelOpen={mockupPanelOpen}
          escapeRef={mockupEscape}
          showPage={props.restoreContext === undefined ? null : showMockupPage}
          onClose={() => setMockupPanelOpen(false)}
          onOpenAiSettings={isOwner ? () => setTagsDialog("ai") : null}
          onSetUpAi={openYourAi}
          modelLists={deployment.modelLists === true}
          notify={notify}
        />
      )}
      {signedIn && !showSetup && !inMockup && (
        <Pins
          targets={pinTargets}
          selectedThreadId={selected?.threadId ?? null}
          selectedElement={windowAnchor}
          exposedRight={sidebarOpen ? windowWidth - sideWidth : windowWidth}
          onSelect={(id, element) => select(id, { anchor: element, reveal: false })}
        />
      )}
      {signedIn && highlight !== null && !inMockup && <Highlight location={highlight} onDone={clearHighlight} />}
      {signedIn && picking && !hidden && (
        <Picker
          host={host}
          exposedRight={sidebarOpen ? windowWidth - sideWidth : undefined}
          hint={
            picked !== null
              ? null
              : reattaching !== null
                ? "Select the replacement element · Esc to cancel"
                : "Comment mode: select an element · V to leave"
          }
          paused={picked !== null}
          onPick={pick}
          onOutsideClick={() => {
            if (comment?.body.text.trim() === "") cancelComment();
          }}
        />
      )}
      {sidebarOpen && !inMockup && sidebar}
      {signedIn && !showSetup && !backendRejected && !inMockup && selected !== null && projectId !== null && projectQuery.status === "ready" && (
        <ThreadWindow
          key={selected.threadId}
          selectionId={selected.id}
          anchor={windowAnchor}
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
          picked={picked!}
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
        avoid={composing ? picked!.element.getBoundingClientRect() : null}
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
        <TagsAiDialog projectId={projectId} initialTab={tagsDialog} onClose={() => setTagsDialog(null)} notify={notify} modelLists={deployment.modelLists === true} />
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

/**
 * Whether the app reports a thread's saved view state. A key either side lacks
 * counts as null, so state the thread doesn't name, such as an open dialog,
 * means another view. Once `restoreContext` has run, keys the thread lacks
 * entirely are left to the host: the thread was saved before the host reported
 * them, and the host restored its own reading of them. Keys the thread has,
 * null included, must still match.
 */
function sameViewState(saved: ViewState, current: ViewState, { restored = false }: { restored?: boolean } = {}): boolean {
  const keys = restored ? Object.keys(saved) : new Set([...Object.keys(saved), ...Object.keys(current)]);
  return [...keys].every((key) => (saved[key] ?? null) === (current[key] ?? null));
}

/** How long Critiqs waits, after the host restores a view, for the app to report it and show the target. */
const RESTORE_TIMEOUT_MS = 3000;

/** Why a thread's target can't be shown in a prototype that doesn't restore views. */
function notRestoredReason(location: TargetLocation, current: ResolvedContext): string {
  if (location.screen !== current.screen) {
    return `This comment is on ${location.screen}, and this prototype doesn't restore views automatically.`;
  }
  if (!sameViewState(location.viewState, current.viewState)) {
    return `This comment was left in another view (${describeViewState(location.viewState) || "default view"}), and this prototype doesn't restore views automatically.`;
  }
  return "This element isn't in the current view, and this prototype doesn't restore views automatically.";
}

/** Why a restore the host reported as done didn't reach the thread's saved view. */
function wrongViewReason(location: TargetLocation, current: ResolvedContext): string {
  if (location.screen !== current.screen) return `The prototype didn't open ${location.screen}.`;
  return `The prototype didn't open the saved view (${describeViewState(location.viewState) || "default view"}).`;
}

const EMPTY: ThreadSummary[] = [];
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
