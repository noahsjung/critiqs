import type { OrganizationDetails, ParticipantInfo, ProjectInfo, ReviewAccess } from "@critiqs/core";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Reviewer } from "../session.ts";
import { errorMessage, useTransport } from "../transport.ts";
import { Avatar } from "./common.tsx";
import { Confirm, Select, type SelectOption } from "./ds.tsx";
import { inviteToast } from "./OrganizationDialog.tsx";

const ANYONE = "Anyone who signs in while using this prototype can see and add comments. Control access by controlling who can reach the prototype.";

const WHO_CAN_COMMENT: SelectOption[] = [
  { value: "anyone", label: "Anyone who can reach the prototype" },
  { value: "organization", label: "Only people added here" },
];

/**
 * The project panel's "Who has access": who can see and add comments, and the
 * people. Where the backend keeps organizations' members and the reviewer is
 * in the project's organization, it lists its members, its invites, and the
 * others who commented; its admins add people by email, remove members,
 * withdraw invites, and choose who can comment. Elsewhere it lists the
 * reviewer and who commented most recently.
 */
export function WhoHasAccess({
  project,
  reviewer,
  organizationMembers,
  notify,
}: {
  project: ProjectInfo;
  reviewer: Reviewer;
  /** The backend's configuration reports `organizationMembers`. */
  organizationMembers: boolean;
  notify: (message: string) => void;
}) {
  const transport = useTransport();
  const people = transport.useParticipants(project._id, "");
  const commenters = people.status === "ready" ? people.data : [];
  const organizationId = organizationMembers ? (project.organization?.id ?? null) : null;
  const details = transport.useOrganization(organizationId);
  if (organizationId === null || details.status !== "ready") {
    return (
      <section className="review-address" aria-label="Who has access">
        <strong>Who has access</strong>
        <span className="note">
          {project.reviewAccess === "organization"
            ? "Only members of the project's organization can see and add comments. Invite people to the organization to let them review."
            : ANYONE}
        </span>
        <ul className="people">
          <li>
            <Avatar name={reviewer.name} imageUrl={reviewer.pictureUrl} />
            <span>
              {reviewer.name} <span className="note">(you{project.isOwner ? ", project owner" : ""})</span>
            </span>
          </li>
          {commenters.map((person) => (
            <li key={person._id}>
              <Avatar name={person.name} imageUrl={person.imageUrl} />
              <span>{person.name}</span>
            </li>
          ))}
        </ul>
        {commenters.length > 0 && <span className="note">People who commented most recently.</span>}
      </section>
    );
  }
  return <Members project={project} organization={details.data} commenters={commenters} notify={notify} />;
}

/** What an admin did here, so each failure shows beside what it acted on. */
type Action = "invite" | "remove" | "withdraw" | "access";

function Members({
  project,
  organization,
  commenters,
  notify,
}: {
  project: ProjectInfo;
  organization: OrganizationDetails;
  commenters: ParticipantInfo[];
  notify: (message: string) => void;
}) {
  const transport = useTransport();
  const admin = organization.role === "admin";
  const canSetAccess = admin && project.isOwner && project.reviewAccess !== undefined;
  const [busy, setBusy] = useState<Action | null>(null);
  // The last action's outcome, shown beside what it acted on; starting another clears it.
  const [outcome, setOutcome] = useState<{ target: string; message: string; failed: boolean } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [savingAccess, setSavingAccess] = useState<ReviewAccess | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const accessLabelId = useId();
  const fieldId = useId();

  /** Runs one change at a time on `target`, reporting `done` with its result, or its failure beside the target. */
  const attempt = <T,>(action: Action, target: string, work: () => Promise<T>, done: (result: T) => void) => {
    if (busy !== null) return;
    setBusy(action);
    setOutcome(null);
    work().then(
      (result) => {
        if (!mounted.current) return;
        setBusy(null);
        done(result);
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setBusy(null);
        if (action === "remove") setConfirming(null);
        setOutcome({ target, message: errorMessage(failure), failed: true });
        if (action === "remove") removeButtons.current.get(target)?.focus();
      },
    );
  };
  const outcomeLine = (target: string) =>
    outcome !== null &&
    outcome.target === target &&
    (outcome.failed ? (
      <p className="error" role="alert">
        {outcome.message}
      </p>
    ) : (
      <p className="note" role="status">
        {outcome.message}
      </p>
    ));

  const invite = () => {
    const address = email.trim();
    if (address === "") return;
    attempt(
      "invite",
      "invite",
      () => transport.inviteMember({ organizationId: organization.id, email: address, role: "member", projectId: project._id }),
      (result) => {
        setOutcome({ target: "invite", message: inviteToast(address, result), failed: false });
        if (result.status === "invited") setEmail("");
      },
    );
  };
  const keep = (userId: string) => {
    removeButtons.current.get(userId)?.focus();
    setConfirming(null);
  };
  const remove = (userId: string, name: string) =>
    attempt(
      "remove",
      userId,
      () => transport.removeMember({ organizationId: organization.id, userId }),
      () => {
        setConfirming(null);
        field.current?.focus();
        notify(`${name} was removed`);
      },
    );
  const withdraw = (inviteId: string, address: string) =>
    attempt(
      "withdraw",
      `invite:${inviteId}`,
      () => transport.revokeInvite(inviteId),
      () => notify(`Invite to ${address} withdrawn`),
    );
  const chooseAccess = (next: ReviewAccess) => {
    if (busy !== null) return;
    setSavingAccess(next);
    attempt(
      "access",
      "access",
      // Shows the choice while it saves; a failed save puts it back.
      () => transport.setReviewAccess({ projectId: project._id, reviewAccess: next }).finally(() => mounted.current && setSavingAccess(null)),
      () => notify(next === "organization" ? "Only people added here can comment now" : "Anyone who can reach the prototype can comment now"),
    );
  };

  const access = savingAccess ?? project.reviewAccess ?? "anyone";
  const you = organization.members.find((member) => member.you);
  const others = organization.members.filter((member) => !member.you);
  const memberIds = new Set(organization.members.map((member) => member.userId));
  const onlyCommented = commenters.filter((person) => !memberIds.has(person._id));
  const youSay = [
    "you",
    ...(project.isOwner ? ["project owner"] : []),
    ...(you?.role === "admin" ? ["admin"] : []),
  ].join(", ");

  return (
    <section className="review-address" aria-label="Who has access">
      <strong>Who has access</strong>
      <span className="note">
        {project.reviewAccess === "organization" ? `Only people added here, the members of ${organization.name}, can see and add comments.` : ANYONE}
      </span>
      <ul className="people managed">
        {you !== undefined && (
          <PersonRow name={you.name} imageUrl={you.imageUrl} detail={`(${youSay})`} />
        )}
        {others.map((member) => (
          <PersonRow
            key={member.userId}
            name={member.name}
            imageUrl={member.imageUrl}
            detail={member.role === "admin" ? "(admin)" : null}
            action={
              admin && (
                <button
                  ref={(element) => {
                    if (element === null) removeButtons.current.delete(member.userId);
                    else removeButtons.current.set(member.userId, element);
                  }}
                  type="button"
                  className="btn small ghost"
                  disabled={busy !== null}
                  aria-label={`Remove ${member.name}`}
                  onClick={() => {
                    setOutcome(null);
                    setConfirming(member.userId);
                  }}
                >
                  Remove
                </button>
              )
            }
          >
            {confirming === member.userId && (
              <Confirm
                question={`Remove ${member.name} from ${organization.name}?`}
                keep={`Keep ${member.name}`}
                act="Remove"
                actLabel={`Remove ${member.name} from ${organization.name}`}
                busy={busy === "remove"}
                onKeep={() => keep(member.userId)}
                onAct={() => remove(member.userId, member.name)}
              />
            )}
            {outcomeLine(member.userId)}
          </PersonRow>
        ))}
        {admin &&
          organization.invites.map((each) => (
            <PersonRow
              key={each._id}
              name={each.email}
              imageUrl={null}
              detail="· Invited"
              action={
                <button
                  type="button"
                  className="btn small ghost"
                  disabled={busy !== null}
                  aria-label={`Withdraw the invite to ${each.email}`}
                  onClick={() => withdraw(each._id, each.email)}
                >
                  Withdraw
                </button>
              }
            >
              {outcomeLine(`invite:${each._id}`)}
            </PersonRow>
          ))}
        {onlyCommented.map((person) => (
          <PersonRow key={person._id} name={person.name} imageUrl={person.imageUrl} detail="· commented" />
        ))}
      </ul>
      {admin ? (
        <form
          className="add-people"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            invite();
          }}
        >
          <label className="field-label" htmlFor={fieldId}>
            Add people
          </label>
          <div className="row">
            <input
              ref={field}
              id={fieldId}
              className="field"
              type="email"
              autoComplete="off"
              placeholder="name@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button type="submit" className="btn" disabled={busy !== null}>
              {busy === "invite" ? "Adding…" : "Add"}
            </button>
          </div>
          {outcomeLine("invite")}
        </form>
      ) : (
        <span className="note">Ask an admin of {organization.name} to add or remove people.</span>
      )}
      {canSetAccess && (
        <div className="stacked who-can-comment">
          <span id={accessLabelId} className="field-label">
            Who can comment
          </span>
          <Select value={access} options={WHO_CAN_COMMENT} labelledBy={accessLabelId} disabled={busy !== null} onChange={(next) => chooseAccess(next as ReviewAccess)} />
          {access === "anyone" && (
            <span className="note">While anyone who can reach the prototype can comment, removing someone here doesn't stop them. Only people added here does.</span>
          )}
          {outcomeLine("access")}
        </div>
      )}
    </section>
  );
}

function PersonRow({
  name,
  imageUrl,
  detail,
  action,
  children,
}: {
  name: string;
  imageUrl: string | null;
  detail: string | null;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li>
      <Avatar name={name} imageUrl={imageUrl} />
      <span className="who">
        {name}
        {detail !== null && <span className="note"> {detail}</span>}
      </span>
      {action}
      {children}
    </li>
  );
}
