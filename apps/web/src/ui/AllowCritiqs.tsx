import { useEffect, useState } from "react";
import { type AllowCheck, type AllowCritiqsSetup, failureMessage, useAuth, useBackend } from "../backend.ts";
import { copy } from "../copy.ts";
import { relativeTime } from "../shared.ts";
import { CopyButton, Heading, SignInButton } from "./parts.tsx";

// /allow-critiqs: how a site behind a bot wall or firewall lets one Critiqs
// project's review links in. Anyone can read how it works. With
// `?project=<id>&origin=<origin>`, the project's owners get that origin's
// token, the firewall rule to add, the proof file to publish, and **Check
// again**, which asks the review proxy to fetch the site with the token.

export function AllowCritiqsPage({ projectId, origin }: { projectId: string | null; origin: string | null }) {
  const auth = useAuth();
  const backend = useBackend();
  return (
    <>
      <Heading title={copy.allowCritiqs.title} lead={copy.allowCritiqs.lead} />
      {projectId !== null && origin !== null && backend.reviewLinks?.allowCritiqs === true ? (
        auth.reviewer === null || !auth.ready ? (
          <div className="stacked">
            <p className="note">{copy.allowCritiqs.signIn}</p>
            <SignInButton />
          </div>
        ) : (
          <OwnerSetup projectId={projectId} origin={origin} />
        )
      ) : (
        <p className="note">{copy.allowCritiqs.ownersOnly}</p>
      )}
      <section className="stacked allow-explainer">
        <h2>{copy.allowCritiqs.howTitle}</h2>
        <ol>
          {copy.allowCritiqs.how.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <h2>{copy.allowCritiqs.whyTitle}</h2>
        <p>{copy.allowCritiqs.why}</p>
        <h2>{copy.allowCritiqs.cantTitle}</h2>
        <p>{copy.allowCritiqs.cant}</p>
      </section>
    </>
  );
}

function OwnerSetup({ projectId, origin }: { projectId: string; origin: string }) {
  const backend = useBackend();
  const [setup, setSetup] = useState<{ status: "loading" } | { status: "ready"; data: AllowCritiqsSetup } | { status: "error"; message: string }>({ status: "loading" });
  const [check, setCheck] = useState<{ status: "idle" } | { status: "checking" } | { status: "done"; data: AllowCheck } | { status: "error"; message: string }>({ status: "idle" });
  useEffect(() => {
    let current = true;
    backend.issueAllowCritiqs(projectId, origin).then(
      (data) => current && setSetup({ status: "ready", data }),
      (failure: unknown) => current && setSetup({ status: "error", message: failureMessage(failure, copy.allowCritiqs.failed) }),
    );
    return () => void (current = false);
  }, [backend, projectId, origin]);
  if (setup.status === "loading") return <p className="note">{copy.loading}</p>;
  if (setup.status === "error") return <p className="error" role="alert">{setup.message}</p>;
  const data = setup.data;

  const runCheck = async () => {
    setCheck({ status: "checking" });
    try {
      setCheck({ status: "done", data: await backend.checkAllowCritiqs(projectId, data.origin) });
    } catch (failure) {
      setCheck({ status: "error", message: failureMessage(failure, copy.allowCritiqs.failed) });
    }
  };
  const rotate = async () => {
    if (!window.confirm(copy.allowCritiqs.rotateConfirm)) return;
    try {
      setSetup({ status: "ready", data: await backend.rotateAllowCritiqs(projectId, data.origin) });
      setCheck({ status: "idle" });
    } catch (failure) {
      setCheck({ status: "error", message: failureMessage(failure, copy.allowCritiqs.failed) });
    }
  };
  const proofFile = `${data.proofLine}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([proofFile], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "critiqs-allow.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  const verified = check.status === "done" ? check.data.verified : data.verifiedAt !== null && check.status === "idle";
  const result = check.status === "done" && !check.data.verified ? copy.allowCritiqs.results[check.data.result] : null;

  return (
    <section className="stacked allow-setup" aria-label={copy.allowCritiqs.forOrigin(data.origin)}>
      <p className="lead">
        <strong>{copy.allowCritiqs.forOrigin(data.origin)}</strong>
      </p>
      <h2>{copy.allowCritiqs.tokenTitle}</h2>
      <p className="note">{copy.allowCritiqs.tokenLead}</p>
      <pre className="command allow-token">
        <code>
          {data.header}: {data.token}
        </code>
      </pre>
      <div className="actions">
        <CopyButton text={data.token} label={copy.allowCritiqs.copyToken} copiedLabel={copy.allowCritiqs.copied} className="btn" />
        <button type="button" className="btn quiet" onClick={() => void rotate()}>
          {copy.allowCritiqs.rotate}
        </button>
      </div>
      <h2>{copy.allowCritiqs.ruleTitle}</h2>
      <p className="note">{copy.allowCritiqs.ruleLead}</p>
      <dl className="allow-rules">
        {copy.allowCritiqs.rules(data.token).map((rule) => (
          <div key={rule.name}>
            <dt>{rule.name}</dt>
            <dd>
              <code>{rule.text}</code>
            </dd>
          </div>
        ))}
      </dl>
      <p className="note">
        <a href={data.wellKnownUrl} target="_blank" rel="noreferrer noopener">
          {copy.allowCritiqs.egress}
        </a>
      </p>
      <h2>{copy.allowCritiqs.proofTitle}</h2>
      <p className="note">{copy.allowCritiqs.proofLead(`${data.origin}${data.proofPath}`)}</p>
      <pre className="command allow-proof">
        <code>{data.proofLine}</code>
      </pre>
      <div className="actions">
        <button type="button" className="btn" onClick={download}>
          {copy.allowCritiqs.downloadProof}
        </button>
      </div>
      <h2>{copy.allowCritiqs.checkTitle}</h2>
      <p className="note">{copy.allowCritiqs.checkLead}</p>
      <div className="actions">
        <button type="button" className="btn primary" disabled={check.status === "checking"} onClick={() => void runCheck()}>
          {check.status === "checking" ? copy.allowCritiqs.checking : copy.allowCritiqs.check}
        </button>
      </div>
      {verified && (
        <p className="success allow-result" role="status">
          {copy.allowCritiqs.allowed}{" "}
          <a href={`/review-links/${encodeURIComponent(projectId)}`}>{copy.allowCritiqs.createLink}</a>
        </p>
      )}
      {result !== null && (
        <p className="error allow-result" role="status">
          {result}
        </p>
      )}
      {check.status === "error" && (
        <p className="error" role="alert">
          {check.message}
        </p>
      )}
      {check.status === "idle" && data.lastCheck !== null && <p className="note">{copy.allowCritiqs.lastChecked(relativeTime(data.lastCheck.at))}</p>}
    </section>
  );
}
