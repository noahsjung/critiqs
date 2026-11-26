import {
  AVAILABLE_WAYS,
  type DeveloperInvite,
  type DeveloperSendResult,
  type DeveloperSendSummary,
  developerMessage,
  installCommands,
  type OnboardingAnswers,
  type ProjectInfo,
  recommend,
  STACKS,
  type StackInfo,
  type Way,
} from "@critiqs/core";
import { type ReactNode, useState } from "react";
import { failureMessage, useBackend } from "../backend.ts";
import { copy } from "../copy.ts";
import { type CreatedProject, developerErrors, emailAddress, filledDevelopers } from "../flow.ts";
import type { QueryState } from "../shared.ts";
import { DeveloperEmails } from "./DeveloperEmails.tsx";
import { BackendStep, Commands, CopyButton } from "./parts.tsx";

/** The setup page a copied message links to: this site's, by project ID, which shows the install steps to anyone signed in. */
export function projectSetupUrl(projectId: string, origin = window.location.origin): string {
  return `${origin}/setup/${encodeURIComponent(projectId)}`;
}

/**
 * The recommended way in for the project as created, then the other ways
 * Critiqs offers today. `someoneElse` is an engineer saying, after all, that
 * someone else changes the code.
 */
export function Recommendation({
  project,
  developers,
  onDevelopers,
  email,
}: {
  project: CreatedProject;
  developers: readonly string[];
  onDevelopers: (fields: string[]) => void;
  email: string | null;
}) {
  const [someoneElse, setSomeoneElse] = useState(false);
  const answers: OnboardingAnswers = someoneElse ? { ...project.answers, codeAccess: "teammate" } : project.answers;
  const { primary, others, reason } = recommend(answers, project.check, AVAILABLE_WAYS);
  const stack = STACKS.find((candidate) => candidate.id === project.stack) ?? null;
  /** A way's card; the recommended one says why in place of its own line of help. */
  const card = (way: Way, reason: string | null): ReactNode => {
    switch (way) {
      case "install":
        return <InstallCard key={way} projectId={project.id} stack={stack} reason={reason} />;
      case "send-to-developer":
        return <SendCard key={way} project={project} developers={developers} onDevelopers={onDevelopers} email={email} reason={reason} />;
      // Ways that haven't shipped have no card; `AVAILABLE_WAYS` leaves them out.
      default:
        return null;
    }
  };
  return (
    <>
      <p className="lead">{copy.recommendation.lead}</p>
      <section className="recommended" aria-labelledby="recommended-badge">
        <p className="badge" id="recommended-badge">
          {copy.recommendation.badge}
        </p>
        {card(primary, copy.recommendation.reasons[reason])}
      </section>
      {reason === "can-change-code" && !someoneElse && (
        <div>
          <button type="button" className="link-btn" onClick={() => setSomeoneElse(true)}>
            {copy.recommendation.someoneElse}
          </button>
        </div>
      )}
      {others.length > 0 && (
        <section className="other-ways" aria-labelledby="other-ways">
          <h2 className="ds-group-label" id="other-ways">
            {copy.recommendation.others}
          </h2>
          {others.map((way) => card(way, null))}
        </section>
      )}
    </>
  );
}

/**
 * The copied message, with the step for a backend other than Critiqs Cloud
 * after the commands when it has them: `init <projectId>` doesn't write the
 * component's `backend` property.
 */
function withBackendStep(message: string, stack: CreatedProject["stack"], backend: string | null): string {
  const installable = STACKS.find((candidate) => candidate.id === stack)?.installable ?? true;
  if (backend === null || !installable) return message;
  const parts = message.split("\n\n");
  parts.splice(parts.length - 1, 0, `${copy.install.customBackend("our")}\n${copy.install.backendProperty(backend)}`);
  return parts.join("\n\n");
}

/** Installing in the app: the commands for an installable or unknown stack, or why it can't be installed yet. */
export function InstallCard({ projectId, stack, reason }: { projectId: string; stack: StackInfo | null; reason: string | null }) {
  const { componentBackend } = useBackend();
  const commands = installCommands(projectId);
  return (
    <div className="way" aria-label={copy.install.title} role="group">
      <h2 className={reason === null ? "way-title" : "way-title large"}>{copy.install.title}</h2>
      {reason !== null && <p className="reason">{reason}</p>}
      {stack !== null && !stack.installable ? (
        <p className="caution">{copy.stack.notInstallable(stack.label)}</p>
      ) : (
        <>
          <p className="note">{stack === null ? copy.install.unknownStack : copy.install.commandsLabel}</p>
          <Commands commands={commands} />
          {componentBackend !== null && <BackendStep backend={componentBackend} whose="your team's" />}
          <div className="row between wrap agent">
            <span className="note">{copy.install.agentLabel}</span>
            <CopyButton text={copy.install.agentPrompt(commands, stack?.label ?? null, componentBackend)} label={copy.install.copyPrompt} copiedLabel={copy.install.promptCopied} />
          </div>
        </>
      )}
    </div>
  );
}

/** A line about one developer's setup email. `copy`: offer Copy message beside it, since Critiqs won't email them; `send-again`: its email failed, so Send again emails them now. */
export interface DeliveryLine {
  text: string;
  tone: "success" | "error" | "note";
  action: "copy" | "send-again" | null;
}

/**
 * What to say about one address's email. The last answer to sending it comes
 * first when it refused the address, so a refused retry of a failed email
 * says why; otherwise the project's record of the email when there is one,
 * which updates live, so a failed one says so and offers Send again.
 */
export function deliveryLine(email: string, summary: DeveloperSendSummary | undefined, result: DeveloperSendResult | undefined): DeliveryLine | null {
  switch (result?.status) {
    case "already-sent":
      return { text: copy.send.alreadySent(email), tone: "note", action: "copy" };
    case "limit":
      return { text: result.message, tone: "error", action: "copy" };
    case "suppressed":
      return { text: copy.send.suppressed(email), tone: "error", action: "copy" };
    case "invalid":
      return { text: copy.send.invalid(email, result.message), tone: "error", action: null };
    case "sent":
    case undefined:
      if (summary?.status === "failed") return { text: copy.send.failed(email), tone: "error", action: "send-again" };
      // An email whose answer never came counts as sent, as the server counts it.
      return result === undefined && summary === undefined ? null : { text: copy.send.sent(email), tone: "success", action: null };
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

/** What sending did about the developer joining the project's organization, apart from the email; null when nothing was tried. */
export function inviteLine(email: string, invite: DeveloperInvite, organization: string): string | null {
  switch (invite) {
    case "created":
      return copy.send.invite.created(email, organization);
    case "pending":
      return copy.send.invite.pending(email, organization);
    case "member":
      return copy.send.invite.member(email, organization);
    case "limit":
      return copy.send.invite.limit(email, organization);
    case "none":
      return null;
    default: {
      const exhaustive: never = invite;
      return exhaustive;
    }
  }
}

/** An address as the server keeps a send's: trimmed and lowercase. */
function exactAddress(address: string): string {
  return emailAddress(address) ?? address.trim().toLowerCase();
}

/**
 * The project's record for an address: the one for exactly that address,
 * trimmed and lowercase, as the server keeps sends. Another address of the
 * same inbox, such as a +tag, is its own send with its own setup link.
 */
export function recordFor<T extends { email: string }>(records: readonly T[], address: string): T | undefined {
  const email = exactAddress(address);
  return records.find((record) => record.email === email);
}

/** Sending the setup steps to developers: copy a message, or have Critiqs email each address. */
export function SendCard({
  project,
  developers,
  onDevelopers,
  email,
  reason,
}: {
  project: CreatedProject;
  developers: readonly string[];
  onDevelopers: (fields: string[]) => void;
  email: string | null;
  reason: string | null;
}) {
  const backend = useBackend();
  const sends = backend.useDeveloperSends(project.id);
  const info = backend.useProject(project.id);
  return (
    <SendCardView
      project={project}
      organization={info.status === "ready" ? { status: "ready", data: info.data.organization ?? null } : info}
      developers={developers}
      onDevelopers={onDevelopers}
      email={email}
      reason={reason}
      sends={sends}
      send={(emails) => backend.sendDeveloperSetup(project.id, emails)}
    />
  );
}

export function SendCardView({
  project,
  organization,
  developers,
  onDevelopers,
  email,
  reason,
  sends,
  send,
}: {
  project: CreatedProject;
  /**
   * The project's organization and the sender's role in it; an admin's sends
   * invite each developer to it. Send and Send again wait until it loads, so
   * the invite note is always shown before a send that can invite.
   */
  organization: QueryState<ProjectInfo["organization"] | null>;
  developers: readonly string[];
  onDevelopers: (fields: string[]) => void;
  email: string | null;
  /** Why it's recommended; null when it's one of the other ways. */
  reason: string | null;
  sends: QueryState<DeveloperSendSummary[]>;
  send: (emails: string[]) => Promise<DeveloperSendResult[]>;
}) {
  const { componentBackend } = useBackend();
  const [results, setResults] = useState<readonly DeveloperSendResult[]>([]);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [refused, setRefused] = useState(0);
  const fields = developers.length === 0 ? [""] : developers;
  const errors = developerErrors(fields, email);
  const summaries = sends.status === "ready" ? sends.data : [];
  const filled = filledDevelopers(fields);
  // Send emails each address that has no email yet, or whose email failed.
  const unsent = filled.filter((address) => {
    const status = recordFor(summaries, address)?.status;
    return status !== "sent" && status !== "uncertain";
  });

  const run = async (emails: string[]) => {
    setSending(true);
    setFailure(null);
    try {
      const answered = await send(emails);
      // The newest answer for each address replaces the one before it.
      setResults((current) => [...answered, ...current.filter((earlier) => !answered.some((result) => result.email === earlier.email))]);
    } catch (error) {
      setFailure(failureMessage(error, copy.send.failedRequest));
    } finally {
      setSending(false);
    }
  };
  const sendAll = () => {
    if (errors.some((error) => error !== null)) {
      setShowErrors(true);
      setRefused((count) => count + 1);
      return;
    }
    void run(unsent);
  };
  const message = withBackendStep(
    developerMessage({
      projectName: project.name,
      address: project.reviewUrl,
      stack: project.stack,
      projectId: project.id,
      setupUrl: projectSetupUrl(project.id),
    }),
    project.stack,
    componentBackend,
  );
  // Sending waits for the project's organization, so an admin always sees the invite note first.
  const known = organization.status === "ready";
  const org = known ? organization.data : null;
  const admin = org?.role === "admin" ? org : null;
  // One line per address, however often it was typed.
  const addresses = [...new Map(filled.map((address) => [exactAddress(address), address])).values()];
  const lines = addresses.flatMap((address) => {
    const result = recordFor(results, address);
    const line = deliveryLine(address, recordFor(summaries, address), result);
    const invite = result?.status === "sent" ? inviteLine(address, result.invite, org?.name ?? copy.send.invite.theOrganization) : null;
    return line === null ? [] : [{ address, line, invite }];
  });

  return (
    <div className="way" aria-label={copy.send.title} role="group">
      <h2 className={reason === null ? "way-title" : "way-title large"}>{copy.send.title}</h2>
      {reason === null ? <p className="note">{copy.send.lead}</p> : <p className="reason">{reason}</p>}
      <DeveloperEmails fields={fields} onChange={onDevelopers} errors={showErrors ? errors : null} refused={refused} />
      {admin !== null && <p className="note invite-note">{copy.send.invite.before(admin.name)}</p>}
      {lines.length > 0 && (
        <ul className="deliveries" aria-live="polite">
          {lines.map(({ address, line, invite }) => (
            <li key={address} className={line.tone}>
              <span className="delivery-text">
                <span>{line.text}</span>
                {invite !== null && <span className="note invite-outcome">{invite}</span>}
              </span>
              {line.action === "copy" && <CopyButton text={message} label={copy.send.copyMessage} copiedLabel={copy.send.messageCopied} name={copy.send.copyMessageFor(address)} />}
              {line.action === "send-again" && (
                <button type="button" className="btn small" disabled={sending || !known} aria-label={copy.send.sendAgainTo(address)} onClick={() => void run([address])}>
                  {copy.send.sendAgain}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {failure !== null && (
        <div className="request-failure">
          <p className="error" role="alert">
            {failure}
          </p>
          <CopyButton text={message} label={copy.send.copyMessageInstead} copiedLabel={copy.send.messageCopied} />
        </div>
      )}
      {organization.status === "error" && <p className="error">{copy.send.organizationFailed}</p>}
      {filled.length === 0 && <p className="note">{copy.send.noAddresses}</p>}
      <div className="ds-actions">
        <CopyButton text={message} label={copy.send.copyMessage} copiedLabel={copy.send.messageCopied} className="btn" />
        {unsent.length > 0 && (
          <button type="button" className={reason === null ? "btn" : "btn primary"} disabled={sending || !known} onClick={sendAll}>
            {sending ? copy.send.sending : unsent.length === 1 ? copy.send.sendOne : copy.send.sendMany}
          </button>
        )}
      </div>
    </div>
  );
}
