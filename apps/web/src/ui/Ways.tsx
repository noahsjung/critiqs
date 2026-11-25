import {
  type DeveloperInvite,
  type DeveloperSendResult,
  type DeveloperSendSummary,
  developerMessage,
  installCommands,
  MAX_DEVELOPER_INVITES_PER_PROJECT,
  type ProjectInfo,
  STACKS,
} from "@critiqs/core";
import { useId, useState } from "react";
import { failureMessage, useBackend } from "../backend.ts";
import { copy } from "../copy.ts";
import { type CreatedProject, developerErrors, emailAddress, filledDevelopers, shownHost } from "../flow.ts";
import type { QueryState } from "../shared.ts";
import { DeveloperEmails } from "./DeveloperEmails.tsx";
import { BackendStep, CheckIcon, Command, CopyButton, Heading, oneCommand, ScriptTagStep } from "./parts.tsx";

// The two ways to add Critiqs to the prototype: run one command, or send the
// steps to a developer.

/** The setup page a copied message links to: this site's, by project ID, which shows the install steps to anyone signed in. */
export function projectSetupUrl(projectId: string, origin = window.location.origin): string {
  return `${origin}/setup/${encodeURIComponent(projectId)}`;
}

/**
 * "I will": the commands, one Copy, and what happens next. A stack with no
 * Critiqs package gets the script tag's guide and the project ID instead.
 * `onDone` runs once the command, the agent's instructions, or the project ID
 * is copied.
 */
export function InstallPanel({ project, onDone }: { project: CreatedProject; onDone?: () => void }) {
  const { componentBackend } = useBackend();
  const stack = STACKS.find((candidate) => candidate.id === project.stack) ?? null;
  const commands = installCommands(project.id, stack?.id ?? null);
  const host = project.reviewUrl === null ? null : shownHost(project.reviewUrl);
  if (commands === null) {
    return (
      <>
        <Heading title={copy.install.title} />
        <ScriptTagStep label={stack?.label ?? ""} projectId={project.id} onCopied={onDone} />
      </>
    );
  }
  const command = oneCommand(commands);
  return (
    <>
      <Heading title={copy.install.title} lead={copy.install.lead} />
      <Command
        commands={commands}
        onCopied={onDone}
        after={
          <CopyButton text={copy.install.agentPrompt(command, stack?.label ?? null, componentBackend)} label={copy.install.agent} copiedLabel={copy.install.agentCopied} className="quiet" onCopied={onDone} />
        }
      />
      {componentBackend !== null && <BackendStep backend={componentBackend} whose="your team's" />}
      <p className="then">{copy.install.then(host)}</p>
      {stack === null && <p className="note">{copy.install.unknownStack}</p>}
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

/** Answers to Send, with the newest answer for each address replacing the one before it. */
function withResults(current: readonly DeveloperSendResult[], answered: readonly DeveloperSendResult[]): DeveloperSendResult[] {
  return [...answered, ...current.filter((earlier) => !answered.some((result) => result.email === earlier.email))];
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

/** "My developer will": email the steps to up to three developers, or copy a message. */
export function SendPanel({
  project,
  developers,
  onDevelopers,
  email,
  onDone,
}: {
  project: CreatedProject;
  developers: readonly string[];
  onDevelopers: (fields: string[]) => void;
  email: string | null;
  onDone?: () => void;
}) {
  const backend = useBackend();
  const sends = backend.useDeveloperSends(project.id);
  const info = backend.useProject(project.id);
  return (
    <SendPanelView
      project={project}
      organization={info.status === "ready" ? { status: "ready", data: info.data.organization ?? null } : info}
      developers={developers}
      onDevelopers={onDevelopers}
      email={email}
      sends={sends}
      send={(emails) => backend.sendDeveloperSetup(project.id, emails)}
      onDone={onDone}
    />
  );
}

export function SendPanelView({
  project,
  organization,
  developers,
  onDevelopers,
  email,
  sends,
  send,
  onDone,
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
  sends: QueryState<DeveloperSendSummary[]>;
  send: (emails: string[]) => Promise<DeveloperSendResult[]>;
  onDone?: () => void;
}) {
  const { componentBackend } = useBackend();
  const waitingId = useId();
  const [results, setResults] = useState<readonly DeveloperSendResult[]>([]);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [refused, setRefused] = useState(0);
  const fields = developers.length === 0 ? [""] : developers;
  const errors = developerErrors(fields, email);
  const summaries = sends.status === "ready" ? sends.data : [];
  const filled = filledDevelopers(fields);
  const [adding, setAdding] = useState(false);
  // Send emails each address that has no email yet, or whose email failed. The project's record wins; until it arrives, the answer to Send.
  const unsent = filled.filter((address) => {
    const status = recordFor(summaries, address)?.status;
    if (status !== undefined) return status === "failed";
    const answer = recordFor(results, address)?.status;
    return answer !== "sent" && answer !== "already-sent";
  });

  const run = async (emails: string[]) => {
    setSending(true);
    setFailure(null);
    try {
      const answered = await send(emails);
      setResults((current) => withResults(current, answered));
      if (answered.some((result) => result.status === "sent")) {
        setAdding(false);
        onDone?.();
      }
    } catch (error) {
      setFailure(failureMessage(error, copy.send.failedRequest));
    } finally {
      setSending(false);
    }
  };
  const sendAll = () => {
    // Enter in a field submits too, so the button's own conditions hold here: nothing while sending or before the organization loads, and only unsent addresses.
    if (sending || !known) return;
    if (filled.length === 0) {
      setShowErrors(true);
      return;
    }
    if (errors.some((error) => error !== null)) {
      setShowErrors(true);
      setRefused((count) => count + 1);
      return;
    }
    if (unsent.length > 0) void run(unsent);
  };
  const message = withBackendStep(
    developerMessage({ projectName: project.name, address: project.reviewUrl, stack: project.stack, projectId: project.id, setupUrl: projectSetupUrl(project.id) }),
    project.stack,
    componentBackend,
  );
  // Sending waits for the project's organization, so an admin always sees the invite note first.
  const known = organization.status === "ready";
  // While it loads, the disabled buttons name why they wait.
  const waiting = organization.status === "loading" ? waitingId : undefined;
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
  // Every address typed has its email: the form gives way to what was sent.
  const allSent = !adding && lines.length > 0 && unsent.length === 0 && lines.every(({ line }) => line.tone === "success");

  const deliveries = lines.length > 0 && (
    <ul className="deliveries" aria-live="polite">
      {lines.map(({ address, line, invite }) => (
        <li key={address} className={line.tone}>
          <span className="delivery-text">
            <span className="delivery-main">
              {line.tone === "success" && <CheckIcon />}
              {line.text}
            </span>
            {invite !== null && <span className="note">{invite}</span>}
          </span>
          {line.action === "copy" && (
            <CopyButton text={message} label={copy.send.copyMessageShort} copiedLabel={copy.send.messageCopied} name={copy.send.copyMessageFor(address)} className="btn small" onCopied={onDone} />
          )}
          {line.action === "send-again" && (
            <button type="button" className="btn small" disabled={sending || !known} aria-label={copy.send.sendAgainTo(address)} aria-describedby={waiting} onClick={() => void run([address])}>
              {copy.send.sendAgain}
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  if (allSent) {
    return (
      <>
        <Heading title={copy.send.sentTitle(lines.length)} lead={copy.send.sentNext} />
        {deliveries}
        {fields.length < MAX_DEVELOPER_INVITES_PER_PROJECT && (
          <div>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                setAdding(true);
                onDevelopers([...fields, ""]);
              }}
            >
              {copy.send.sendAnother}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <Heading title={copy.send.title} lead={copy.send.lead} />
      <form
        className="stacked"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          sendAll();
        }}
      >
        <DeveloperEmails fields={fields} onChange={onDevelopers} errors={showErrors ? errors : null} refused={refused} />
        {showErrors && filled.length === 0 && <p className="error">{copy.send.noAddresses}</p>}
        {admin !== null && <p className="note">{copy.send.invite.before(admin.name)}</p>}
        {deliveries}
        {failure !== null && (
          <div className="request-failure">
            <p className="error" role="alert">
              {failure}
            </p>
            <CopyButton text={message} label={copy.send.copyMessageInstead} copiedLabel={copy.send.messageCopied} className="btn small" onCopied={onDone} />
          </div>
        )}
        {organization.status === "error" && <p className="error">{copy.send.organizationFailed}</p>}
        {waiting !== undefined && (
          <p className="note" role="status" id={waiting}>
            {copy.send.organizationLoading}
          </p>
        )}
        <div className="actions">
          {(unsent.length > 0 || filled.length === 0) && (
            <button type="submit" className="btn primary large" disabled={sending || !known} aria-describedby={waiting}>
              {sending ? copy.send.sending : unsent.length > 1 ? copy.send.sendMany : copy.send.sendOne}
            </button>
          )}
          <CopyButton text={message} label={copy.send.copyMessage} copiedLabel={copy.send.messageCopied} className="quiet" onCopied={onDone} />
        </div>
      </form>
    </>
  );
}
