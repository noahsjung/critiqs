import { inboxOf } from "@critiqs/core";
import { useId, useState } from "react";
import { failureMessage, type InviteAnswer, useBackend } from "../backend.ts";
import { copy } from "../copy.ts";
import { type CreatedProject, emailAddress, shownHost } from "../flow.ts";

/** What one invite did, as a line under the field. */
interface InviteLine {
  email: string;
  text: string;
  tone: "success" | "note" | "error";
}

/** The line for an invite's answer. */
export function inviteAnswerLine(email: string, answer: InviteAnswer, organization: string): InviteLine {
  switch (answer.status) {
    case "invited":
      if (answer.email === "not-sent") return { email, text: `${copy.invite.invited(email, organization)} ${copy.invite.notEmailed(email)}`, tone: "note" };
      // Only an email that was queued is mentioned: the card promises none up front.
      return { email, text: answer.email === "pending" ? `${copy.invite.invited(email, organization)} ${copy.invite.emailed}` : copy.invite.invited(email, organization), tone: "success" };
    case "member":
      return { email, text: copy.invite.member(email, organization), tone: "note" };
    case "pending":
      return { email, text: copy.invite.pending(email, organization), tone: "note" };
    default: {
      const exhaustive: never = answer;
      return exhaustive;
    }
  }
}

/**
 * Inviting the team at the end of setup, optional: an admin of the project's
 * organization invites people as members, one address at a time, with the
 * organization's own invites. Each joins when they sign in with that address,
 * on the prototype or the website, and gets the invite email, which links to
 * the prototype, when the deployment sends email: the card says so only once
 * the answer shows it. Someone who isn't an admin is told who can.
 */
export function InviteTeam({ project, email }: { project: CreatedProject; email: string | null }) {
  const backend = useBackend();
  const fieldId = useId();
  const info = backend.useProject(project.id);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [lines, setLines] = useState<InviteLine[]>([]);
  const organization = info.status === "ready" ? (info.data.organization ?? null) : null;
  if (organization === null) return null;
  if (organization.role !== "admin") {
    return (
      <aside className="about invite" aria-label={copy.invite.heading}>
        <p className="about-heading">{copy.invite.heading}</p>
        <p className="note">{copy.invite.askAdmin(organization.name)}</p>
      </aside>
    );
  }
  const invite = async () => {
    if (sending) return;
    const address = emailAddress(text);
    if (address === null) return setError(copy.invite.invalid);
    if (email !== null && inboxOf(address) === inboxOf(email)) return setError(copy.invite.own);
    setError(null);
    setSending(true);
    try {
      const answer = await backend.inviteMember(organization.id, address, project.id);
      setLines((current) => [inviteAnswerLine(address, answer, organization.name), ...current.filter((line) => line.email !== address)]);
      setText("");
    } catch (failure) {
      setError(failureMessage(failure, copy.invite.failed));
    } finally {
      setSending(false);
    }
  };
  return (
    <aside className="about invite" aria-label={copy.invite.heading}>
      <p className="about-heading">{copy.invite.heading}</p>
      <p className="note">{copy.invite.lead(organization.name, project.reviewUrl === null ? null : shownHost(project.reviewUrl))}</p>
      <form
        className="field-row"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void invite();
        }}
      >
        <label className="visually-hidden" htmlFor={fieldId}>
          {copy.invite.field}
        </label>
        <input
          id={fieldId}
          className="field"
          type="email"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          placeholder={copy.invite.placeholder}
          value={text}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : `${fieldId}-error`}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="btn" disabled={sending}>
          {sending ? copy.invite.inviting : copy.invite.button}
        </button>
      </form>
      {error !== null && (
        <p className="error" id={`${fieldId}-error`} role="alert">
          {error}
        </p>
      )}
      {lines.length > 0 && (
        <ul className="deliveries" aria-live="polite">
          {lines.map((line) => (
            <li key={line.email} className={line.tone}>
              <span className="delivery-text">{line.text}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
