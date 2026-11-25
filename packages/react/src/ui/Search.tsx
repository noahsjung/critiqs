import type { ProjectTags, SearchResponse, SearchScope } from "@critiqs/core";
import { type FormEvent, useRef, useState } from "react";
import { errorMessage, useTransport } from "../transport.ts";
import { relativeTime } from "./format.ts";
import { tagDisplay } from "./MentionInput.tsx";
import { CloseIcon, SearchIcon } from "./icons.tsx";

/** A search in progress or done, kept by the sidebar so closing a thread keeps the results. */
export type SearchState =
  | { status: "idle" }
  | { status: "searching"; question: string }
  | { status: "done"; question: string; response: SearchResponse }
  | { status: "failed"; question: string; message: string };

/** The search field at the top of the thread list. Questions in plain language work when the project has AI. */
export function SearchBox({
  projectId,
  scope,
  state,
  onState,
}: {
  projectId: string;
  scope: SearchScope;
  state: SearchState;
  onState: (state: SearchState) => void;
}) {
  const transport = useTransport();
  const [question, setQuestion] = useState(state.status === "idle" ? "" : state.question);
  const latest = useRef(0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const asked = question.trim();
    if (asked === "") return;
    const request = ++latest.current;
    onState({ status: "searching", question: asked });
    try {
      const response = await transport.search({ projectId, question: asked, scope });
      if (request === latest.current) onState({ status: "done", question: asked, response });
    } catch (error) {
      if (request === latest.current) onState({ status: "failed", question: asked, message: errorMessage(error) });
    }
  };
  const clear = () => {
    latest.current++;
    setQuestion("");
    onState({ status: "idle" });
  };
  return (
    <form className="search-box" role="search" onSubmit={(event) => void submit(event)}>
      <SearchIcon />
      <input
        type="search"
        className="field"
        aria-label="Search feedback"
        placeholder="Search, or ask about the feedback"
        value={question}
        maxLength={500}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && state.status !== "idle") {
            event.stopPropagation();
            clear();
          }
        }}
      />
      {state.status !== "idle" && (
        <button type="button" className="icon-btn" aria-label="Clear search" title="Clear search" onClick={clear}>
          <CloseIcon />
        </button>
      )}
    </form>
  );
}

/** Search results, with any insights and the threads each one cites. Every source opens its thread. */
export function SearchResults({
  state,
  tags,
  onOpen,
  onTag,
  onSetUpAi = null,
}: {
  state: Exclude<SearchState, { status: "idle" }>;
  tags: ProjectTags | null;
  onOpen: (threadId: string, messageId: string | null) => void;
  onTag: (tag: string) => void;
  /** Opens Your AI, offered when AI search needs the searcher's own AI; null where the backend has none. */
  onSetUpAi?: (() => void) | null;
}) {
  if (state.status === "searching") return <div className="empty" role="status">Searching…</div>;
  if (state.status === "failed") {
    return (
      <div className="empty" role="alert">
        <strong>Search failed</strong>
        <span>{state.message}</span>
      </div>
    );
  }
  const { response } = state;
  const byId = new Map(response.results.map((result) => [result.threadId, result]));
  const groupName = (id: string) => tags?.groups.find((group) => group._id === id)?.name ?? "a group";
  const filters = [
    ...response.query.terms.map((term) => `“${term}”`),
    ...response.query.tags.map((tag) => `#${tag}`),
    ...response.query.groupIds.map((id) => `group ${groupName(id)}`),
    response.query.status === "all" ? "open and resolved" : response.query.status,
    response.query.screen === null ? "all screens" : `screen ${response.query.screen}`,
    response.query.since !== null && `since ${new Date(response.query.since).toISOString().slice(0, 10)}`,
    response.query.until !== null && `until ${new Date(response.query.until).toISOString().slice(0, 10)}`,
  ].filter(Boolean);
  return (
    <div className="search-results" aria-label="Search results">
      <div className="search-summary">
        <span className={`badge ${response.mode}`}>{response.mode === "ai" ? "AI search" : "Basic search"}</span>
        <span>
          {response.results.length === 1 ? "1 thread" : `${response.results.length} threads`}
          {response.truncated ? " (more matched; refine the search to see them)" : ""}
        </span>
      </div>
      {response.notice !== null &&
        (response.noticeCode === "setup-ai" && onSetUpAi !== null ? (
          <div className="search-notice row between">
            <span>{response.notice}</span>
            <button type="button" className="btn small" onClick={onSetUpAi}>
              Set up your AI
            </button>
          </div>
        ) : (
          <p className="search-notice">{response.notice}</p>
        ))}
      <div className="search-filters note" title="What was searched">
        Searched {filters.join(" · ")}
      </div>
      {response.insights.length > 0 && (
        <section className="insights" aria-label="Insights">
          <div className="group-title">Insights</div>
          {response.insights.map((insight, index) => (
            <article key={index} className="insight">
              <strong>{insight.title}</strong>
              <p>{insight.detail}</p>
              <div className="sources" aria-label="Sources">
                {insight.threadIds.map((id) => {
                  const source = byId.get(id);
                  if (source === undefined) return null;
                  return (
                    <button key={id} type="button" className="source" onClick={() => onOpen(id, null)} title="Open this thread">
                      {source.preview?.authorName ?? "Thread"}: {excerpt(source.preview?.body ?? "")}
                    </button>
                  );
                })}
              </div>
            </article>
          ))}
        </section>
      )}
      {response.insightNotice !== null && response.results.length > 0 && <p className="note search-insight-note">{response.insightNotice}</p>}
      {response.results.length === 0 ? (
        <div className="empty">
          <strong>No threads match</strong>
          <span>Try other words, or clear the search to see every thread.</span>
        </div>
      ) : (
        <section aria-label="Matching threads">
          <div className="group-title">Threads</div>
          {response.results.map((result) => (
            <button key={result.threadId} type="button" className="entry" onClick={() => onOpen(result.threadId, result.matches[0]?.messageId ?? null)}>
              <span className="grow">
                <span className="meta">
                  <span className="author">{result.preview?.authorName ?? "Unknown"}</span>
                  <span className="time">{relativeTime(result.lastMessageAt)}</span>
                </span>
                <span className="excerpt">{result.preview?.body ?? ""}</span>
                {result.matches
                  .filter((match) => match.excerpt !== "")
                  .slice(0, 2)
                  .map((match) => (
                    <span key={match.messageId} className="match">
                      {match.excerpt}
                    </span>
                  ))}
                <span className="details">
                  {result.messageCount > 1 && <span>{result.messageCount - 1 === 1 ? "1 reply" : `${result.messageCount - 1} replies`}</span>}
                  {result.status === "resolved" && <span className="resolved-tag">Resolved</span>}
                  <span>{result.screen}</span>
                  {result.tags.map((tag) => (
                    <span
                      key={tag}
                      className="tag-chip clickable"
                      title={`Show threads tagged ${tag}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onTag(tag);
                      }}
                    >
                      {tagDisplay(tag)}
                    </span>
                  ))}
                </span>
              </span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
