import { type ExportThread, exportJson, exportMarkdown, type FeedbackCollection } from "@critiqs/core";
import type { ExportData } from "@critiqs/core";
import { useEffect, useState } from "react";
import { locationOf } from "../model.ts";
import { describeError, type QueryState, useTransport } from "../transport.ts";
import { copyText, Dialog } from "./common.tsx";

type Format = "markdown" | "json";

/**
 * Exports a feedback collection for a handoff (F11): the selected threads,
 * each with its whole discussion, as readable Markdown or structured JSON.
 */
export function ExportDialog({
  projectId,
  threadIds,
  linkFor,
  onClose,
  notify,
}: {
  projectId: string;
  threadIds: string[];
  linkFor: (pageUrl: string, threadId: string, messageId: string | null) => string;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [format, setFormat] = useState<Format>("markdown");
  const [title, setTitle] = useState(`Feedback handoff, ${new Date().toLocaleDateString()}`);
  const transport = useTransport();
  const [result, setResult] = useState<QueryState<ExportData>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setResult({ status: "loading" });
    transport.exportThreads(projectId, threadIds, () => cancelled).then(
      data => { if (!cancelled) setResult({ status: "ready", data }); },
      error => { if (!cancelled) setResult(describeError(error)); },
    );
    return () => { cancelled = true; };
  }, [transport, projectId, JSON.stringify(threadIds)]);

  const text = (() => {
    if (result.status !== "ready") return null;
    const collection: FeedbackCollection = {
      title,
      projectName: result.data.projectName,
      exportedAt: Date.now(),
      threads: result.data.threads.map((thread): ExportThread => {
        const location = locationOf(thread);
        const { evidence } = thread.anchor;
        return {
          id: thread._id,
          link: linkFor(evidence.url, thread._id, null),
          status: thread.status === "resolved" ? "resolved" : "open",
          tags: thread.tags,
          screen: location.screen,
          viewState: location.viewState,
          scope: location.scope,
          target: {
            purposeId: location.target.purposeId,
            recordKey: location.target.recordKey,
            label: location.target.clues.label,
          },
          revision: evidence.revision,
          pageUrl: evidence.url,
          viewport: evidence.viewport,
          persona: evidence.persona,
          reattached: thread.location !== null,
          hasCapture: thread.hasCapture,
          messages: thread.messages.map((message) => ({
            id: message._id,
            link: linkFor(evidence.url, thread._id, message._id),
            author: message.author,
            createdAt: message.createdAt,
            editedAt: message.editedAt,
            body: message.body,
            revision: message.revision,
            ...(message.via === undefined ? {} : { via: message.via }),
          })),
        };
      }),
    };
    return format === "markdown" ? exportMarkdown(collection) : exportJson(collection);
  })();

  const count = result.status === "ready" ? result.data.threads.length : threadIds.length;
  const download = () => {
    if (text === null) return;
    const blob = new Blob([text], { type: format === "markdown" ? "text/markdown" : "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${title.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "feedback"}.${format === "markdown" ? "md" : "json"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  return (
    <Dialog label="Export feedback" onClose={onClose}>
      <h3>
        Export {count} {count === 1 ? "thread" : "threads"}
      </h3>
      <p className="note">
        Includes each full discussion, links, tags, version, target, and context. Excludes sign-in details, other app
        data, and images; open a thread's link to see its capture.
      </p>
      <input className="field" aria-label="Collection title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <div className="row between">
        <div className="segmented" role="group" aria-label="Format">
          <button type="button" aria-pressed={format === "markdown"} onClick={() => setFormat("markdown")}>
            Markdown, for people
          </button>
          <button type="button" aria-pressed={format === "json"} onClick={() => setFormat("json")}>
            JSON, for tools
          </button>
        </div>
      </div>
      <pre aria-label="Preview">{text ?? (result.status === "error" ? result.message : "Preparing…")}</pre>
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn" disabled={text === null} onClick={download}>
          Download
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={text === null}
          onClick={async () => {
            await copyText(text!);
            notify("Export copied");
          }}
        >
          Copy
        </button>
      </div>
    </Dialog>
  );
}
