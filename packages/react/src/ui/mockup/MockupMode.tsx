import { type Anchor, type MockupDetail, type MockupSource, type PageCopy, removeLink, type ThreadMockup, type ViewState } from "@critiqs/core";
import { type MutableRefObject, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { isTyping, useStoredState } from "../../hooks.ts";
import type { ResolvedContext } from "../../host.ts";
import { type DescribeCopy, runAiTurn, type TurnStatus, turnFailure } from "../../mockup/ai-turn.ts";
import { describeHidden, describeShown } from "../../mockup/describe.ts";
import { type FrozenPage, pageRecordKey } from "../../mockup/freeze.ts";
import {
  closestCopy,
  copyHint,
  editsAt,
  type ElementChoice,
  escapeTarget,
  headVersion,
  INITIAL_STATE,
  mockupReducer,
  mockupThreads,
  shownVersion,
  type ThreadRow,
  titleFrom,
} from "../../mockup/state.ts";
import type { LiveThread } from "../../model.ts";
import { errorMessage, type MockupTransport, useTransport } from "../../transport.ts";
import { openLayer } from "../common.tsx";
import { useSidebarWidth } from "../sidebar-width.tsx";
import { Canvas, type CanvasContent, type CanvasHandle, type CanvasPin } from "./Canvas.tsx";
import {
  AddComment,
  AskComposer,
  BackToThreads,
  CommentChips,
  CopyHint,
  CopyTabs,
  HoldToCompare,
  CloseButton,
  ModelChoice,
  OldVersionBanner,
  PanelFrame,
  pageLabel,
  ReplyBox,
  ThreadList,
  VisitDialog,
} from "./MockupPanel.tsx";
import { MockupThread } from "./MockupThread.tsx";

/** A mockup to open on entering Mockup mode, such as from a thread's "Open mockup" or a link to a mockup thread. */
export interface MockupRequest {
  /** Changes for each request, so asking again opens it again. */
  id: number;
  mockupId: string;
  /** Null opens the mockup's own thread. */
  threadId: string | null;
}

/** Asks the prototype to show the page a mockup was made on; resolves to whether it shows it. */
export type ShowPage = (request: { threadId: string; screen: string; viewState: ViewState; recordKey: string | null; signal: AbortSignal }) => Promise<boolean>;

/**
 * Mockup mode: the page frozen into a copy that covers the prototype, and a
 * panel where the right-hand sidebar is. The panel lists every page's mockup
 * threads; each is its own mockup, with its own copies and versions. Asking
 * for a change, below the list or on an element of the copy, starts one.
 * Opening one shows its conversation, with Critiqs AI's replies and the
 * versions they made, over the thread's own copy.
 */
/** What a message says when only comments were added, so Critiqs AI acts on them. */
export const COMMENTS_ONLY = "Make the changes these comments ask for.";

export function MockupMode(props: {
  host: HTMLElement;
  projectId: string;
  context: ResolvedContext;
  /** Freezes the page as it is now, with the page's details (the page layer's page copy). */
  copyPage: () => Promise<PageCopy>;
  /** The prototype's version, recorded with each message. */
  version: string | null;
  /** The project's normal threads, which "+ Add existing comment" offers. */
  pageThreads: LiveThread[];
  request: MockupRequest | null;
  panelOpen: boolean;
  /** Set to what Escape does here: true when it closed something, false when Mockup mode itself should end. */
  escapeRef: MutableRefObject<(() => boolean) | null>;
  /** Null when the prototype can't restore views, so a thread from another page opens on its copy alone. */
  showPage: ShowPage | null;
  /** Closes the panel; Mockup mode stays on. */
  onClose: () => void;
  /** Opens the project's AI settings; null unless the reviewer owns the project. */
  onOpenAiSettings: (() => void) | null;
  /** Opens Your AI, when a request needs the reviewer's own AI; null where the backend has none. */
  onSetUpAi: (() => void) | null;
  /** The backend reports which models the reviewer's requests may choose among. */
  modelLists?: boolean;
  /**
   * Whether the live page is beneath the copy, as when installed. False in a
   * window of its own, such as the browser extension's Mockup tab: holding O
   * would show nothing there, so comparing isn't offered, nor a copy at this
   * window's width, which the page elsewhere doesn't have.
   */
  livePage?: boolean;
  notify: (message: string) => void;
}) {
  const { host, projectId, context, notify } = props;
  const transport = useTransport();
  const mockups = transport.mockups as MockupTransport;
  const [state, dispatch] = useReducer(mockupReducer, props.request, (request) =>
    request?.threadId == null ? INITIAL_STATE : mockupReducer(INITIAL_STATE, { type: "open", mockupId: request.mockupId, threadId: request.threadId }),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const [original, setOriginal] = useState(false);
  const [turns, setTurns] = useState<Record<string, TurnStatus>>({});
  // One Critiqs AI turn at a time: each builds on the latest version, so a second one would be refused as stale.
  const aiBusy = Object.values(turns).some((turn) => turn.status === "working");
  const aiBusyRef = useRef(aiBusy);
  aiBusyRef.current = aiBusy;
  const turnTokens = useRef(new Map<string, symbol>());
  const [ask, setAsk] = useState("");
  /** Comments added before the new thread's mockup exists; linked when it's made. */
  const [newComments, setNewComments] = useState<string[]>([]);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [taking, setTaking] = useState(false);
  const [width, setWidth] = useState(() => window.innerWidth);
  const panelWidth = useSidebarWidth();
  const canvas = useRef<CanvasHandle>(null);
  // The models the reviewer's connection offers here; a choice shows only when there are several.
  const choiceQuery = transport.useAiChoice(props.modelLists === true ? projectId : null);
  const offered = choiceQuery.status === "ready" && choiceQuery.data.models.length > 1 ? choiceQuery.data.models : [];
  const [rememberedModel, rememberModel] = useStoredState<string | null>(`critiqs:mockup-model:${projectId}`, null);
  const model =
    offered.length === 0
      ? undefined
      : offered.some((entry) => entry.id === rememberedModel)
        ? rememberedModel!
        : (choiceQuery.status === "ready" ? choiceQuery.data.defaultModel : null) ?? offered[0]!.id;
  /** Read when each turn starts, so trying again uses the model chosen now. */
  const modelRef = useRef(model);
  modelRef.current = model;
  const modelChoice = model === undefined ? undefined : <ModelChoice models={offered} value={model} onChange={rememberModel} />;
  /** Where each copy was scrolled when it was taken here, so it opens there. */
  const scrollOf = useRef(new Map<string, number>());
  const unmounted = useRef(false);
  const visiting = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      unmounted.current = true;
      visiting.current?.abort();
    },
    [],
  );

  const open = state.view === "thread" ? state : null;
  const detailQuery = mockups.useMockup(open?.mockupId ?? null);
  const detail = detailQuery.status === "ready" && detailQuery.data._id === open?.mockupId ? detailQuery.data : null;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const snapshotId = open?.snapshotId ?? null;
  const shownCopy = detail?.snapshots.find((snapshot) => snapshot._id === snapshotId) ?? null;
  const head = detail === null ? 0 : headVersion(detail);
  const shown = detail === null || open === null ? 0 : shownVersion(detail, open.viewing);
  /** Critiqs AI is changing the copy shown: the open thread's turn includes it, and its latest version is the one shown. */
  const openTurn = open === null ? undefined : turns[open.threadId];
  const editing = openTurn?.status === "working" && snapshotId !== null && openTurn.snapshotIds.includes(snapshotId) && shown === head;
  const openThread = (detail === null ? [] : mockupThreads(detail)).find((thread) => thread._id === open?.threadId) ?? null;
  // The live page beneath the copy is the thread's own page only when the prototype shows it.
  const onPage = detail !== null && showsMockupPage(detail.source, context.screen);
  const compares = props.livePage !== false;
  const canCompare = compares && (open === null || onPage);
  const canCompareRef = useRef(canCompare);
  canCompareRef.current = canCompare;

  // Entering the mode, or going back to the list, freezes the page as it is now, with the page's details.
  const freezing = state.view === "list" && state.frozen === null;
  const versionRef = useRef(props.version);
  versionRef.current = props.version;
  const { copyPage } = props;
  useEffect(() => {
    if (!freezing) return;
    let cancelled = false;
    copyPage()
      .then(({ url, context: current, recordKey, ...page }) => {
        if (cancelled) return;
        const source: MockupSource = {
          url: removeLink(url),
          screen: current.screen,
          viewState: current.viewState,
          revision: versionRef.current,
          persona: current.persona,
          recordKey,
        };
        dispatch({ type: "frozen", frozen: { page, source } });
      })
      .catch((error) => !cancelled && notify(`The page couldn't be frozen: ${errorMessage(error)}`));
    return () => {
      cancelled = true;
    };
  }, [freezing, copyPage, notify]);

  // "Open mockup" names only the mockup: open its thread.
  const requestedMockup = useRef(props.request?.threadId === null ? props.request.mockupId : null);
  useEffect(() => {
    const mockupId = requestedMockup.current;
    if (mockupId === null) return;
    requestedMockup.current = null;
    mockups
      .getMockup(mockupId)
      .then((found) => {
        const thread = mockupThreads(found)[0];
        if (unmounted.current) return;
        if (thread === undefined) notify("This mockup has no thread yet.");
        else dispatch({ type: "open", mockupId, threadId: thread._id });
      })
      .catch((error) => notify(errorMessage(error)));
  }, [mockups, notify]);

  // An opened thread shows its own copy, or the copy closest to the window's width.
  useEffect(() => {
    // Only when none is chosen: a copy just added isn't in the mockup as last read.
    if (detail === null || detail.snapshots.length === 0 || snapshotId !== null) return;
    const own = detail.snapshots.find((snapshot) => snapshot._id === openThread?.mockup?.snapshotId);
    dispatch({ type: "show-copy", snapshotId: (own ?? closestCopy(detail.snapshots, window.innerWidth)!)._id });
  }, [detail, snapshotId, openThread]);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const html = useCopyHtml(mockups, snapshotId, notify);

  const content: CanvasContent | null = useMemo(() => {
    if (state.view === "list") {
      if (state.frozen === null) return null;
      const { page } = state.frozen;
      const key = `draft:${page.capturedAt}`;
      return { key, copyKey: key, html: page.html, edits: [], scrollY: page.scrollY };
    }
    if (detail === null || snapshotId === null || html?.snapshotId !== snapshotId) return null;
    return {
      key: `${snapshotId}:${shown}`,
      copyKey: snapshotId,
      html: html.html,
      edits: editsAt(detail, snapshotId, shown),
      scrollY: scrollOf.current.get(snapshotId) ?? 0,
    };
  }, [state, detail, snapshotId, html, shown]);

  const pins: CanvasPin[] = useMemo(() => {
    const mockup = openThread?.mockup;
    if (openThread === null || mockup?.node == null || mockup.snapshotId !== snapshotId) return [];
    return [{
      threadId: openThread._id,
      node: mockup.node,
      authorName: openThread.preview?.authorName ?? "Unknown",
      unread: openThread.unread,
      resolved: openThread.status === "resolved",
    }];
  }, [openThread, snapshotId]);

  // ---------------------------------------------------------------------------
  // Critiqs AI

  const retries = useRef(new Map<string, () => void>());
  const startTurn = useCallback(
    (threadId: string, mockupId: string, snapshotIds: string[]) => {
      const describe: DescribeCopy = async ({ snapshotId, top, round }) => {
        // Leaving Mockup mode stops a turn before its next request.
        if (unmounted.current) throw new Error("Mockup was closed.");
        // Later requests build on the version the previous one made.
        const latest: MockupDetail = round === 0 && detailRef.current?._id === mockupId ? detailRef.current : await mockups.getMockup(mockupId);
        const version = headVersion(latest);
        const visible = canvas.current?.documentFor(`${snapshotId}:${version}`) ?? null;
        if (visible !== null) return describeShown(visible, top);
        const copy = latest.snapshots.find((snapshot) => snapshot._id === snapshotId);
        return await describeHidden(
          host.shadowRoot ?? document.body,
          { html: await mockups.loadSnapshot(snapshotId), edits: editsAt(latest, snapshotId, version), width: copy?.width ?? window.innerWidth },
          top ?? scrollOf.current.get(snapshotId) ?? 0,
        );
      };
      const run = () => {
        const token = Symbol(threadId);
        turnTokens.current.set(threadId, token);
        const update = (status: TurnStatus | null) => {
          if (unmounted.current || turnTokens.current.get(threadId) !== token) return;
          setTurns((current) => {
            const { [threadId]: _previous, ...rest } = current;
            return status === null ? rest : { ...rest, [threadId]: status };
          });
        };
        // Set now, not on the next render, so nothing can start a second turn in between.
        aiBusyRef.current = true;
        runAiTurn({ threadId, snapshotIds, describe, reply: mockups.mockupReply, model: modelRef.current, onProgress: update })
          .then(() => update(null))
          .catch((error) => update(turnFailure(error)));
      };
      retries.current.set(threadId, run);
      run();
    },
    [mockups, host],
  );

  /** Every copy of the thread's mockup: the thread is the whole proposal. */
  const copiesOf = (mockup: MockupDetail) => mockup.snapshots.map((snapshot) => snapshot._id);

  // ---------------------------------------------------------------------------
  // Asking for changes

  /**
   * Starts a mockup thread, on an element or the whole page: saves the frozen
   * page, with the details of the page it was frozen on, as a new mockup named
   * after the message, with the comments added linked in the same step, then
   * asks Critiqs AI to answer.
   */
  const startThread = async (typed: string, element: ElementChoice | null): Promise<boolean> => {
    const current = stateRef.current;
    // Comments alone are enough to ask with: the message says to act on them, and the thread is named after the first.
    const firstComment = props.pageThreads.find((thread) => thread.summary._id === newComments[0])?.summary.preview?.body;
    const body = typed.trim() === "" && newComments.length > 0 ? COMMENTS_ONLY : typed;
    if (body.trim() === "" || sending || aiBusyRef.current || current.view !== "list" || !current.drafting || current.frozen === null) return false;
    const { page, source } = current.frozen;
    setSending(true);
    try {
      const storageId = await mockups.uploadSnapshot(projectId, page.html);
      // Linked as the mockup is made, before the thread, so Critiqs AI reads them with the first request.
      const created = await mockups.create({ projectId, title: titleFrom(typed.trim() === "" && firstComment !== undefined ? firstComment : body), source, snapshot: { storageId, ...snapshotLayout(page) }, linkedThreadIds: newComments });
      scrollOf.current.set(created.snapshotId, page.scrollY);
      const threadMockup: ThreadMockup = { mockupId: created.mockupId, snapshotId: element === null ? null : created.snapshotId, node: element?.node ?? null };
      const threadId = await transport.createThread({
        projectId,
        anchor: mockupAnchor(source, element?.label ?? null, props.version),
        body,
        tags: [],
        capture: { status: "failed", failureReason: "Mockup threads have no capture." },
        mentions: [],
        mockup: threadMockup,
      });
      if (unmounted.current) return true;
      setNewComments([]);
      dispatch({ type: "open", mockupId: created.mockupId, threadId, snapshotId: created.snapshotId });
      startTurn(threadId, created.mockupId, [created.snapshotId]);
      return true;
    } catch (error) {
      notify(errorMessage(error));
      return false;
    } finally {
      if (!unmounted.current) setSending(false);
    }
  };

  const sendReply = async (threadId: string) => {
    const typed = replies[threadId] ?? "";
    const mockup = detailRef.current;
    const body = typed.trim() === "" && (mockup?.linkedThreadIds.length ?? 0) > 0 ? COMMENTS_ONLY : typed;
    if (body.trim() === "" || sending || aiBusyRef.current || mockup === null) return;
    setSending(true);
    try {
      await transport.reply({ threadId, body, revision: props.version, mentions: [] });
      setReplies((current) => ({ ...current, [threadId]: current[threadId] === typed ? "" : (current[threadId] ?? "") }));
      startTurn(threadId, mockup._id, copiesOf(mockup));
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      if (!unmounted.current) setSending(false);
    }
  };

  const restore = async (number: number) => {
    const mockup = detailRef.current;
    if (mockup === null) return;
    try {
      const saved = await mockups.restore({ mockupId: mockup._id, number, expectedHead: headVersion(mockup) });
      dispatch({ type: "view", version: "head" });
      notify(number === 0 ? `Original copy restored as Version ${saved}` : `Version ${number} restored as Version ${saved}`);
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const takeCopy = async () => {
    const mockup = detailRef.current;
    if (mockup === null || taking) return;
    setTaking(true);
    try {
      // The live page is still there beneath the copy, at the window's width.
      const frozen = await copyPage();
      const storageId = await mockups.uploadSnapshot(projectId, frozen.html);
      const layout = snapshotLayout(frozen);
      const snapshotId = await mockups.addSnapshot({ mockupId: mockup._id, snapshot: { storageId, ...layout } });
      scrollOf.current.set(snapshotId, frozen.scrollY);
      if (!unmounted.current) dispatch({ type: "show-copy", snapshotId });
      notify(
        headVersion(mockup) > 0
          ? `Copy taken at ${layout.width} px. It starts without this mockup's changes; ask in the thread to bring them to it.`
          : `Copy taken at ${layout.width} px.`,
      );
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      if (!unmounted.current) setTaking(false);
    }
  };

  const link = (threadId: string, add: boolean) => {
    if (open === null) return;
    (add ? mockups.link : mockups.unlink)({ mockupId: open.mockupId, threadId }).catch((error) => notify(errorMessage(error)));
  };

  // ---------------------------------------------------------------------------
  // Opening threads: one from another page first takes the prototype there.

  const chooseThread = ({ mockup, thread }: ThreadRow) => {
    const target = { mockupId: mockup._id, threadId: thread._id };
    if (showsMockupPage(mockup.source, context.screen)) return dispatch({ type: "open", ...target });
    // The thread still opens on its own copy; its header says comparing isn't available.
    if (props.showPage === null) return dispatch({ type: "open", ...target });
    dispatch({ type: "ask-visit", visit: { ...target, screen: mockup.source.screen, viewState: mockup.source.viewState, recordKey: mockup.source.recordKey ?? null } });
  };

  const goToVisit = async () => {
    const current = stateRef.current;
    if (current.view !== "list" || current.visit === null || current.visit.status === "going" || props.showPage === null) return;
    const { visit } = current;
    dispatch({ type: "visit-going" });
    const controller = new AbortController();
    visiting.current = controller;
    const shown = await props
      .showPage({ threadId: visit.threadId, screen: visit.screen, viewState: visit.viewState, recordKey: visit.recordKey, signal: controller.signal })
      .catch(() => false);
    if (controller.signal.aborted || unmounted.current) return;
    visiting.current = null;
    if (!shown) notify(`The prototype couldn't open ${visit.screen}, so comparing with the live page isn't available.`);
    dispatch({ type: "open", mockupId: visit.mockupId, threadId: visit.threadId });
  };

  const cancelVisit = () => {
    visiting.current?.abort();
    visiting.current = null;
    dispatch({ type: "cancel-visit" });
  };

  // ---------------------------------------------------------------------------
  // Keys: Escape closes the innermost thing; holding O shows the live page.

  useLayoutEffect(() => {
    props.escapeRef.current = () => {
      if (escapeTarget(stateRef.current) === "panel") return false;
      dispatch({ type: "escape" });
      return true;
    };
    return () => {
      props.escapeRef.current = null;
    };
  }, [props.escapeRef]);

  useEffect(() => {
    const isO = (event: KeyboardEvent) => event.key === "o" || event.key === "O";
    const onDown = (event: KeyboardEvent) => {
      if (!isO(event) || event.metaKey || event.ctrlKey || event.altKey || isTyping(event) || !canCompareRef.current) return;
      if (openLayer(host.shadowRoot)) return;
      event.preventDefault();
      setOriginal(true);
    };
    const onUp = (event: KeyboardEvent) => {
      if (isO(event)) setOriginal(false);
    };
    const release = () => setOriginal(false);
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", release);
    };
  }, [host]);

  // ---------------------------------------------------------------------------
  // Rendering

  const exposedRight = props.panelOpen ? width - panelWidth : width;
  const selection = state.view === "list" ? state.selection : null;
  // A copy is taken at the live page's width, which is this window's only where the page is beneath it.
  const hint = !compares || shownCopy === null || detail === null || !onPage ? null : copyHint(detail.snapshots, shownCopy, width);

  /** Asks Critiqs AI again: as before in this visit, or for the thread's latest message after a reload. */
  const retry = (id: string) => {
    if (sending || aiBusyRef.current) return;
    const again = retries.current.get(id);
    if (again !== undefined) return again();
    if (detail === null) return;
    startTurn(id, detail._id, copiesOf(detail));
  };

  // The list stays mounted, hidden, while a thread is open, so its loaded
  // pages and scroll position are still there on going back.
  const listing = state.view === "list" && !state.drafting;
  const drafting = state.view === "list" && state.drafting;
  const added = new Set(newComments);
  const list = (
    <PanelFrame
      hidden={!listing}
      header={
        <>
          <h2 className="grow">Mockup</h2>
          <button type="button" className="btn small primary" onClick={() => dispatch({ type: "new-thread" })}>
            New thread
          </button>
          <CloseButton onClose={props.onClose} />
        </>
      }
    >
      <ThreadList mockups={mockups} projectId={projectId} screen={context.screen} turns={turns} onOpen={chooseThread} />
    </PanelFrame>
  );

  // Nothing is saved until the first message: going back leaves no thread, and
  // what was typed or added waits for the next new thread in this visit.
  const draft = drafting && (
    <PanelFrame
      header={
        <>
          {/* Not while the first message is sending: the thread it saves opens next, and would replace a newer draft. */}
          <BackToThreads onBack={() => dispatch({ type: "end-draft" })} disabled={sending} />
          <h2 className="grow">New thread</h2>
          <CloseButton onClose={props.onClose} />
        </>
      }
      footer={
        <AskComposer
          draft={ask}
          onDraft={setAsk}
          sending={sending}
          disabled={state.frozen === null || aiBusy}
          onSend={() => void startThread(ask, null).then((sent) => sent && setAsk(""))}
          addComment={<AddComment comments={props.pageThreads} screen={context.screen} added={added} onAdd={(id) => setNewComments((ids) => [...ids, id])} />}
          comments={<CommentChips ids={newComments} comments={props.pageThreads} onRemove={(id) => setNewComments((ids) => ids.filter((other) => other !== id))} />}
          hasComments={newComments.length > 0}
          modelChoice={modelChoice}
        />
      }
    >
      <div className="empty">
        <strong>Start a new thread</strong>
        <span>
          Ask Critiqs AI for a change to this page below, or select an element on the copy to ask about it. Add comments for
          Critiqs AI to read. The thread is saved when you send its first message.
        </span>
      </div>
    </PanelFrame>
  );

  const panel = (() => {
    if (state.view === "list") return draft;
    const { threadId } = state;
    const back = <BackToThreads onBack={() => dispatch({ type: "list" })} />;
    if (detailQuery.status === "error" || detail === null) {
      return (
        <PanelFrame header={<>{back}<h2>Mockup</h2><CloseButton onClose={props.onClose} /></>}>
          {detailQuery.status === "error" ? (
            <div className="empty">
              <strong>Can't open this mockup thread</strong>
              <span>{detailQuery.message}</span>
            </div>
          ) : (
            <div className="empty">Loading…</div>
          )}
        </PanelFrame>
      );
    }
    const linked = detail.linkedThreadIds;
    return (
      <PanelFrame
        header={
          <>
            {back}
            <div className="grow thread-heading">
              <h2 title={detail.title}>{detail.title}</h2>
              <span className="note">{pageLabel(detail.source)}</span>
            </div>
            {compares && <HoldToCompare onHold={setOriginal} disabled={!onPage} />}
            <CloseButton onClose={props.onClose} />
          </>
        }
        tools={
          <>
            <CopyTabs snapshots={detail.snapshots} snapshotId={snapshotId} onCopy={(id) => dispatch({ type: "show-copy", snapshotId: id })} />
            {!onPage && (
              <div className="mockup-banner hint" role="status">
                {detail.source.screen === context.screen
                  ? `This mockup thread is on another record of ${detail.source.screen}.`
                  : `This mockup thread is on ${detail.source.screen}.`}{" "}
                Comparing with the live page isn't available here.
              </div>
            )}
            {shown !== head && <OldVersionBanner version={shown} onLatest={() => dispatch({ type: "view", version: "head" })} />}
            {shown === head && shownCopy !== null && missingChanges(detail, shownCopy._id, head) && (
              <div className="mockup-banner" role="status">
                Earlier changes were made on other copies. Ask in this thread to bring them to this one.
              </div>
            )}
            {hint !== null && shownCopy !== null && (
              <CopyHint hint={hint} shownWidth={shownCopy.width} busy={taking} onTake={() => void takeCopy()} onSwitch={(id) => dispatch({ type: "show-copy", snapshotId: id })} />
            )}
          </>
        }
        footer={
          <ReplyBox
            value={replies[threadId] ?? ""}
            onChange={(text) => setReplies((current) => ({ ...current, [threadId]: text }))}
            sending={sending}
            disabled={aiBusy}
            onSend={() => void sendReply(threadId)}
            addComment={<AddComment comments={props.pageThreads} screen={detail.source.screen} added={new Set(linked)} onAdd={(id) => link(id, true)} />}
            comments={<CommentChips ids={linked} comments={props.pageThreads} onRemove={(id) => link(id, false)} />}
            hasComments={linked.length > 0}
            modelChoice={modelChoice}
          />
        }
      >
        <MockupThread
          threadId={threadId}
          versions={detail.versions}
          head={head}
          shown={shown}
          turn={turns[threadId]}
          onView={(version) => dispatch({ type: "view", version: version === head ? "head" : version })}
          onRestore={(version) => void restore(version)}
          onRetry={() => retry(threadId)}
          retryDisabled={aiBusy || sending}
          onOpenAiSettings={props.onOpenAiSettings}
          onSetUpAi={props.onSetUpAi}
        />
      </PanelFrame>
    );
  })();

  const modeHint =
    state.view === "list"
      ? drafting
        ? props.panelOpen
          ? "Mockup mode: select an element to ask about it · V to leave"
          : "Mockup mode · V to leave"
        : "Mockup mode: open a thread or start a new one · V to leave"
      : onPage && compares
        ? "Mockup mode: hold O to compare with the live page · V to leave"
        : "Mockup mode · V to leave";

  return (
    <>
      <Canvas
        handle={canvas}
        content={content}
        hidden={original}
        choosing={drafting && props.panelOpen && selection === null && !sending}
        onChoose={(choice) => dispatch({ type: "select", choice })}
        pins={pins}
        selectedThreadId={open?.threadId ?? null}
        onPin={() => undefined}
        exposedRight={exposedRight}
        working={editing}
      />
      {selection === null && !original && content !== null && (
        <div className="mode-hint" style={{ left: exposedRight / 2, maxWidth: Math.max(0, exposedRight - 24) }}>
          {modeHint}
        </div>
      )}
      {freezing && <div className="mode-hint" style={{ left: exposedRight / 2, maxWidth: Math.max(0, exposedRight - 24) }}>Freezing the page…</div>}
      {selection !== null && props.panelOpen && !original && (
        <ElementComposer
          choice={selection}
          rightEdge={exposedRight}
          sending={sending}
          disabled={aiBusy}
          modelChoice={modelChoice}
          onCancel={() => dispatch({ type: "deselect" })}
          onSend={async (body) => {
            if (await startThread(body, selection)) dispatch({ type: "deselect" });
          }}
        />
      )}
      {props.panelOpen && panel}
      {props.panelOpen && list}
      {state.view === "list" && state.visit !== null && <VisitDialog visit={state.visit} onGo={() => void goToVisit()} onCancel={cancelVisit} />}
    </>
  );
}

/** A frozen page's layout as a mockup stores it: its width is the window's, whose layout the copy shows. */
function snapshotLayout(frozen: FrozenPage) {
  return {
    width: frozen.viewportWidth,
    height: frozen.height,
    scrollY: frozen.scrollY,
    viewportHeight: frozen.viewportHeight,
    capturedAt: frozen.capturedAt,
  };
}

/** A copy's HTML, loaded through the transport; null until the shown copy's has loaded. */
function useCopyHtml(mockups: MockupTransport, snapshotId: string | null, notify: (message: string) => void) {
  const [loaded, setLoaded] = useState<{ snapshotId: string; html: string } | null>(null);
  useEffect(() => {
    if (snapshotId === null) return;
    let cancelled = false;
    mockups
      .loadSnapshot(snapshotId)
      .then((html) => !cancelled && setLoaded({ snapshotId, html }))
      .catch((error) => !cancelled && notify(errorMessage(error)));
    return () => {
      cancelled = true;
    };
  }, [mockups, snapshotId, notify]);
  return loaded;
}

/**
 * Where a mockup thread's anchor says it was left: the page the mockup was
 * made from. Mockup threads aren't on the prototype's elements, so the target
 * only names the element by its label.
 */
function mockupAnchor(source: MockupSource, label: string | null, revision: string | null): Anchor {
  return {
    screen: source.screen,
    viewState: source.viewState,
    scope: "shared",
    target: { purposeId: null, recordKey: null, clues: { tagName: "body", role: null, label, path: "" } },
    evidence: {
      url: source.url,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      marker: null,
      capturedAt: Date.now(),
      revision,
      persona: source.persona,
      userAgent: navigator.userAgent,
    },
  };
}

const COMPOSER_WIDTH = 320;

/** Asking about one element of the copy, beside it. */
function ElementComposer({
  choice,
  rightEdge,
  sending,
  disabled,
  modelChoice,
  onCancel,
  onSend,
}: {
  choice: ElementChoice;
  rightEdge: number;
  sending: boolean;
  /** While Critiqs AI is still answering the previous request. */
  disabled: boolean;
  /** The model select, when the connection offers more than one. */
  modelChoice: ReactNode;
  onCancel: () => void;
  onSend: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), [choice.node]);
  const { rect } = choice;
  // Right of the element when there's room, else below it, kept inside the uncovered window.
  const fitsRight = rect.x + rect.width + 12 + COMPOSER_WIDTH <= rightEdge - 8;
  const left = fitsRight ? rect.x + rect.width + 12 : Math.max(8, Math.min(rect.x, rightEdge - COMPOSER_WIDTH - 8));
  const top = fitsRight ? Math.max(8, rect.y) : rect.y + rect.height + 8;
  const send = () => {
    if (body.trim() !== "" && !sending && !disabled) onSend(body);
  };
  return (
    <>
      <div className="target-box chosen" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />
      <form
        className="popover"
        aria-label="Ask about this element"
        style={{ left, top: Math.min(top, window.innerHeight - 180) }}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="context-line" title={choice.label}>
          {choice.label}
        </div>
        <textarea
          ref={field}
          className="field"
          aria-label="Ask for a change to this element"
          placeholder="Ask for a change to this element…"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
            if (event.key === "Escape") {
              event.stopPropagation();
              onCancel();
            }
          }}
        />
        <div className="row end">
          {modelChoice}
          <span className="grow" />
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={body.trim() === "" || sending || disabled}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </>
  );
}

/** Whether other copies have changes at this version but the shown one has none, as a newly taken copy does. */
function missingChanges(detail: MockupDetail, snapshotId: string, version: number): boolean {
  if (detail.snapshots.length < 2 || editsAt(detail, snapshotId, version).length > 0) return false;
  return detail.snapshots.some((snapshot) => snapshot._id !== snapshotId && editsAt(detail, snapshot._id, version).length > 0);
}

/** Whether the prototype shows a mockup's page: its screen, and the record it was made on, if any. */
function showsMockupPage(source: Pick<MockupSource, "screen" | "recordKey">, screen: string): boolean {
  const recordKey = source.recordKey ?? null;
  return source.screen === screen && (recordKey === null || recordKey === pageRecordKey(document.body));
}
