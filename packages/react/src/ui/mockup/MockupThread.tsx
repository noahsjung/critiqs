import type { MessageView, MockupVersionView } from "@critiqs/core";
import { useEffect, useRef, useState } from "react";
import type { TurnStatus } from "../../mockup/ai-turn.ts";
import { useTransport } from "../../transport.ts";
import { Avatar } from "../common.tsx";
import { fullTime, relativeTime } from "../format.ts";
import { MessageBody } from "../MentionInput.tsx";

/** Critiqs AI's name wherever it is an author. */
export const AI_NAME = "Critiqs AI";

/**
 * A mockup thread opened in the Mockup panel: its chat with Critiqs AI, each
 * reply with the version it made, versions no message carries (restores) as
 * events at their time, and what Critiqs AI is doing now. Mockup threads have
 * no capture or prototype target, so none is shown.
 */
export function MockupThread({
  threadId,
  versions,
  head,
  shown: shownVersion,
  turn,
  onView,
  onRestore,
  onRetry,
  retryDisabled,
  onOpenAiSettings,
  onSetUpAi,
}: {
  threadId: string;
  /** Every version of the thread's mockup, oldest first. */
  versions: readonly MockupVersionView[];
  /** The mockup's latest version, which needs no restoring. */
  head: number;
  /** The version on the copy. */
  shown: number;
  turn: TurnStatus | undefined;
  onView: (version: number) => void;
  onRestore: (version: number) => void;
  onRetry: () => void;
  /** While another Critiqs AI turn runs. */
  retryDisabled: boolean;
  onOpenAiSettings: (() => void) | null;
  onSetUpAi: (() => void) | null;
}) {
  const { useThread, markRead } = useTransport();
  const result = useThread(threadId);
  const thread = result.status === "ready" ? result.data : null;

  // Reading the thread here marks it read through its latest message.
  useEffect(() => {
    if (thread === null) return;
    const state = thread.readState;
    if (state !== null && !state.manualUnread && state.lastReadAt >= thread.lastMessageAt) return;
    markRead({ threadId, seenThrough: thread.lastMessageAt }).catch(() => undefined);
  }, [thread?.lastMessageAt, thread?.readState?.lastReadAt, threadId, markRead]);

  // New messages and Critiqs AI's progress show at the bottom.
  const end = useRef<HTMLDivElement>(null);
  const shown = `${thread?.messages.length ?? 0}:${versions.length}:${turn?.status ?? ""}:${turn?.status === "working" ? `${turn.round}${turn.step}` : ""}`;
  useEffect(() => {
    const container = end.current?.closest(".sidebar-body");
    if (container instanceof HTMLElement) container.scrollTop = container.scrollHeight;
  }, [shown]);

  return (
    <div className="mockup-thread">
      {thread?.status === "resolved" && <div className="note pad">This thread is resolved.</div>}
      {result.status === "loading" && <div className="empty">Loading…</div>}
      {result.status === "error" && <div className="empty">{result.message}</div>}
      {thread !== null && (
        <div className="messages">
          {conversation(thread.messages, versions).map((item) =>
            item.kind === "message" ? (
              <ChatMessage key={item.message._id} message={item.message} head={head} shown={shownVersion} onView={onView} onRestore={onRestore} />
            ) : (
              <VersionEvent key={`version:${item.version.number}`} version={item.version} head={head} shown={shownVersion} onView={onView} onRestore={onRestore} />
            ),
          )}
        </div>
      )}
      {turn !== undefined && <TurnNote turn={turn} onRetry={onRetry} retryDisabled={retryDisabled} onOpenAiSettings={onOpenAiSettings} onSetUpAi={onSetUpAi} />}
      <div ref={end} />
    </div>
  );
}

function ChatMessage({
  message,
  head,
  shown,
  onView,
  onRestore,
}: {
  message: MessageView;
  head: number;
  shown: number;
  onView: (version: number) => void;
  onRestore: (version: number) => void;
}) {
  const byAi = message.via === "ai";
  const author = byAi ? AI_NAME : message.author.name;
  const version = message.mockupVersion;
  // A chat: what people write sits on the right, Critiqs AI and coding agents on the left.
  if (message.via !== "ai" && message.via !== "agent") {
    return (
      <div className="message from-person" data-created={message.createdAt}>
        <div className="said">
          <div className="meta">
            <span className="time" title={fullTime(message.createdAt)}>
              {relativeTime(message.createdAt)}
            </span>
            <span className="author">{author}</span>
          </div>
          <div className="bubble">
            <MessageBody body={message.body} mentions={message.mentions} />
          </div>
          {version !== undefined && <VersionCard version={version} head={head} shown={shown} onView={onView} onRestore={onRestore} />}
        </div>
        <Avatar name={author} imageUrl={message.author.imageUrl} large />
      </div>
    );
  }
  return (
    <div className={`message${byAi ? " from-ai" : ""}`} data-created={message.createdAt}>
      <Avatar name={author} imageUrl={byAi ? null : message.author.imageUrl} large />
      <div className="grow">
        <div className="meta">
          <span className="author">{author}</span>
          {byAi && (
            <span className="badge ai" title="Written by Critiqs AI">
              AI
            </span>
          )}
          {message.via === "agent" && <span className="via">via coding agent</span>}
          <span className="time" title={fullTime(message.createdAt)}>
            {relativeTime(message.createdAt)}
          </span>
        </div>
        <div className="body">
          <MessageBody body={message.body} mentions={message.mentions} />
        </div>
        {version !== undefined && <VersionCard version={version} head={head} shown={shown} onView={onView} onRestore={onRestore} />}
      </div>
    </div>
  );
}

type ConversationItem = { kind: "message"; message: MessageView } | { kind: "version"; version: MockupVersionView };

/**
 * The thread's messages with the versions none of them carries, such as
 * restores, in time order; at the same time, the message comes first.
 */
function conversation(messages: readonly MessageView[], versions: readonly MockupVersionView[]): ConversationItem[] {
  const carried = new Set(messages.flatMap((message) => (message.mockupVersion === undefined ? [] : [message.mockupVersion])));
  const items: ConversationItem[] = messages.map((message) => ({ kind: "message", message }));
  for (const version of versions) {
    if (carried.has(version.number)) continue;
    const at = items.findIndex((item) => (item.kind === "message" ? item.message.createdAt : item.version.createdAt) > version.createdAt);
    items.splice(at === -1 ? items.length : at, 0, { kind: "version", version });
  }
  return items;
}

/** A version no message carries, as a line in the conversation: a restore, or one saved from another thread of an older mockup. */
function VersionEvent({
  version,
  head,
  shown,
  onView,
  onRestore,
}: {
  version: MockupVersionView;
  head: number;
  shown: number;
  onView: (version: number) => void;
  onRestore: (version: number) => void;
}) {
  const author = version.byAi ? AI_NAME : version.authorName;
  const what =
    version.restoredFrom === null
      ? `${author} saved Version ${version.number}${version.summary === "" ? "" : `: ${version.summary}`}`
      : `${author} restored ${version.restoredFrom === 0 ? "the original copy" : `Version ${version.restoredFrom}`} as Version ${version.number}`;
  return (
    <div className="version-event" data-created={version.createdAt}>
      <div className="meta">
        <span>{what}</span>
        <span className="time" title={fullTime(version.createdAt)}>
          {relativeTime(version.createdAt)}
        </span>
      </div>
      <VersionCard version={version.number} head={head} shown={shown} onView={onView} onRestore={onRestore} />
    </div>
  );
}

/** A version to view or restore, marked when it is the latest or on the copy. */
function VersionCard({
  version,
  head,
  shown,
  onView,
  onRestore,
}: {
  version: number;
  head: number;
  shown: number;
  onView: (version: number) => void;
  onRestore: (version: number) => void;
}) {
  return (
    <div className={`version-card${version === shown ? " shown" : ""}`} role="group" aria-label={`Version ${version}`}>
      <span>
        Version {version}
        {version === head ? " · latest" : ""}
      </span>
      {version === shown ? (
        <span className="note">On the copy</span>
      ) : (
        <button type="button" className="link-btn" onClick={() => onView(version)}>
          View
        </button>
      )}
      {version !== head && (
        <button type="button" className="link-btn" onClick={() => onRestore(version)}>
          Restore
        </button>
      )}
    </div>
  );
}

function TurnNote({
  turn,
  onRetry,
  retryDisabled,
  onOpenAiSettings,
  onSetUpAi,
}: {
  turn: TurnStatus;
  onRetry: () => void;
  /** While another Critiqs AI turn runs. */
  retryDisabled: boolean;
  onOpenAiSettings: (() => void) | null;
  onSetUpAi: (() => void) | null;
}) {
  if (turn.status === "failed") {
    return (
      <div className="ai-status failed" role="status">
        <div className="warning">{turn.message}</div>
        <div className="row wrap">
          {turn.kind === "setup-ai" && onSetUpAi !== null && (
            <button type="button" className="btn small" onClick={onSetUpAi}>
              Set up your AI
            </button>
          )}
          {turn.kind === "unavailable" && onOpenAiSettings !== null && (
            <button type="button" className="btn small" onClick={onOpenAiSettings}>
              Open AI settings
            </button>
          )}
          {turn.kind === "unavailable" && onOpenAiSettings === null && (
            <span className="note">The project's owner can set up AI in its settings.</span>
          )}
          <button type="button" className="btn small" disabled={retryDisabled} onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  return <TurnProgress turn={turn} />;
}

/**
 * Critiqs AI at work, where its answer will appear: the steps of the turn so
 * far, the one running now, and how long the turn has taken.
 */
function TurnProgress({ turn }: { turn: Extract<TurnStatus, { status: "working" }> }) {
  const seconds = useSecondsSince(turn.since);
  const steps: { label: string; state: "done" | "now" }[] = [{ label: "Read the page", state: turn.step === "reading" && turn.round === 0 ? "now" : "done" }];
  if (turn.round > 0 || turn.step === "editing") steps.push({ label: "Change the HTML and CSS", state: turn.round === 0 ? "now" : "done" });
  if (turn.round > 0) steps.push({ label: `Continue further down the page${turn.round > 1 ? ` (part ${turn.round + 1})` : ""}`, state: "now" });
  return (
    // The steps are the live region's content, so each new step is announced; the seconds are not.
    <div className="message from-ai ai-working" role="status">
      <Avatar name={AI_NAME} imageUrl={null} large />
      <div className="grow">
        <div className="meta">
          <span className="author">{AI_NAME}</span>
          <span className="badge ai">AI</span>
          <span className="time" aria-hidden="true">
            {seconds}s
          </span>
        </div>
        <ol className="ai-steps">
          {steps.map((step) => (
            <li key={step.label} className={step.state}>
              {step.state === "now" ? <span className="spinner" aria-hidden="true" /> : <span className="step-done" aria-hidden="true">✓</span>}
              <span>
                {step.label}
                {step.state === "now" && <span className="ai-dots" aria-hidden="true" />}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Whole seconds since `since`, updated every second. */
function useSecondsSince(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return Math.max(0, Math.floor((now - since) / 1000));
}
