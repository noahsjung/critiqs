import { useId, useState } from "react";
import { failureMessage, type ReviewLinkSummary, useAuth, useBackend } from "../backend.ts";
import { copyText } from "../clipboard.ts";
import { copy } from "../copy.ts";
import { CopyButton, Heading, SignInButton } from "./parts.tsx";
import { ShareBuildPanel } from "./Ways.tsx";

// A project's review links, at /review-links/<project ID>, for the people who
// manage it: create one for the prototype's address, copy it again, open it,
// or remove it. Shared builds (`critiqs share`) are listed with them, and the
// command to share one is shown where the deployment offers shared builds. The backend allows each of these only to the project's owners
// and never returns a link's key in the list; Copy asks for it each time.

export function ReviewLinksPage({ projectId }: { projectId: string }) {
  const auth = useAuth();
  if (auth.reviewer === null || !auth.ready) {
    return (
      <>
        <Heading title={copy.reviewLinks.title} lead={copy.reviewLinks.signIn} />
        <SignInButton />
      </>
    );
  }
  return <ReviewLinks projectId={projectId} />;
}

function ReviewLinks({ projectId }: { projectId: string }) {
  const backend = useBackend();
  const project = backend.useProject(projectId);
  const offered = backend.reviewLinks?.live === true || backend.reviewLinks?.builds === true;
  const links = backend.useReviewLinks(offered ? projectId : null);
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const fieldId = useId();
  if (!offered) {
    return <Heading title={copy.reviewLinks.title} lead={copy.reviewLinks.notOffered} />;
  }
  const shownAddress = address ?? (project.status === "ready" ? (project.data.reviewUrl ?? "") : "");
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const link = await backend.createReviewLink(projectId, shownAddress.trim(), crypto.randomUUID());
      setCreated(link.url);
    } catch (failure) {
      setError(failureMessage(failure, copy.reviewLinks.createFailed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Heading title={project.status === "ready" ? `${copy.reviewLinks.title} · ${project.data.name}` : copy.reviewLinks.title} lead={copy.reviewLinks.lead} />
      {backend.reviewLinks?.live === true && (
        <form
          className="stacked"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void create();
          }}
        >
          <label htmlFor={fieldId} className="note">{copy.reviewLinks.address}</label>
          <div className="review-links-create">
            <input id={fieldId} className="field" type="url" required placeholder={copy.reviewLinks.placeholder} value={shownAddress} onChange={(event) => setAddress(event.target.value)} />
            <button type="submit" className="btn primary" disabled={busy || shownAddress.trim() === ""}>
              {busy ? copy.reviewLinks.creating : copy.reviewLinks.create}
            </button>
          </div>
          {error !== null && <p className="error" role="alert">{error}</p>}
          {created !== null && (
            <p className="note" role="status">
              <a href={created}>{created}</a>
            </p>
          )}
        </form>
      )}
      {links.status === "loading" && <p className="note">{copy.loading}</p>}
      {links.status === "error" && <p className="error">{links.message}</p>}
      {links.status === "ready" && (links.data.length === 0 ? <p className="note">{copy.reviewLinks.none}</p> : <ul className="review-links">{links.data.map((link) => <LinkRow key={link.linkId} link={link} />)}</ul>)}
      {backend.reviewLinks?.builds === true && (
        <section className="stacked share-build">
          <ShareBuildPanel projectId={projectId} />
        </section>
      )}
    </>
  );
}

function LinkRow({ link }: { link: ReviewLinkSummary }) {
  const backend = useBackend();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  /** Asks the backend for the link and copies it, in the one click: the list never holds keys. */
  const copyLink = async () => {
    setError(null);
    const asked = backend.copyReviewLink(link.linkId);
    let done = false;
    // Where the browser takes a clipboard item whose text is still coming, the click's permission covers the backend's answer.
    if (typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function") {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": asked.then((value) => new Blob([value], { type: "text/plain" })) })]);
        done = true;
      } catch {
        // Copied below, once the address is here.
      }
    }
    let address: string;
    try {
      address = await asked;
    } catch (failure) {
      setError(failureMessage(failure, copy.review.failed));
      return;
    }
    setUrl(address);
    if (!done) done = await copyText(address);
    setCopied(done ? "copied" : "failed");
    if (done) setTimeout(() => setCopied("idle"), 2000);
  };
  return (
    <li className="review-link-row">
      <div className="review-link-text">
        <strong>{link.build === null ? `${link.origin}${link.startPath === "/" ? "" : link.startPath}` : copy.reviewLinks.build(link.build.fileCount, link.build.bytes, link.build.expiresAt)}</strong>
        <span className="note">
          {[copy.reviewLinks.status[link.status] ?? link.status, link.paused ? copy.reviewLinks.paused : null, copy.reviewLinks.usage(link.usageToday.requests), copy.reviewLinks.createdBy(link.createdByName)].filter(Boolean).join(" · ")}
        </span>
        {error !== null && <span className="error">{error}</span>}
      </div>
      <div className="review-link-actions">
        {url === null || copied !== "failed" ? (
          <button type="button" className={copied === "copied" ? "btn small copied" : "btn small"} onClick={() => void copyLink()}>
            <span aria-live="polite">{copied === "copied" ? copy.reviewLinks.copied : copy.reviewLinks.copy}</span>
          </button>
        ) : (
          // The browser refused the clipboard: the usual button, which offers the address to select.
          <CopyButton text={url} label={copy.reviewLinks.copy} copiedLabel={copy.reviewLinks.copied} className="btn small" />
        )}
        {url !== null && <a className="btn small" href={url} target="_blank" rel="noreferrer noopener">{copy.reviewLinks.open}</a>}
        <button
          type="button"
          className="btn small"
          onClick={() => {
            if (window.confirm(link.build === null ? copy.reviewLinks.removeConfirm : copy.reviewLinks.removeBuildConfirm)) void backend.revokeReviewLink(link.linkId).catch((failure) => setError(failureMessage(failure, copy.review.failed)));
          }}
        >
          {copy.reviewLinks.remove}
        </button>
      </div>
    </li>
  );
}
