import type { OrganizationDetails, OrganizationMember, OrganizationRole } from "@critiqs/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { errorMessage, useTransport } from "../transport.ts";
import { Avatar, Dialog } from "./common.tsx";
import { DialogHeader, NavRow, Select, SettingRow, usePageFocus } from "./ds.tsx";

type Page = { kind: "list" } | { kind: "organization" } | { kind: "name" } | { kind: "invite" } | { kind: "member"; userId: string };

const ROLES: { value: OrganizationRole; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];
const roleLabel = (role: OrganizationRole) => (role === "admin" ? "Admin" : "Member");

/**
 * The reviewer's organization: its name, members and their roles, and, for
 * its admins, inviting people by email, pending invites, and changing or
 * removing members. Members see it read-only. Someone in several
 * organizations picks one first. `projectId` links invite emails to the
 * prototype the admin is in.
 */
export function OrganizationDialog({
  projectOrganizationId,
  projectId,
  onClose,
  notify,
}: {
  /** The open project's organization, shown first when the reviewer belongs to it. */
  projectOrganizationId: string | null;
  projectId: string | null;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const transport = useTransport();
  const mine = transport.useMyOrganizations(true);
  const [chosen, setChosen] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ organizationId: string; page: Page } | null>(null);
  const list = mine.status === "ready" ? mine.data : [];
  const several = list.length > 1;
  const organizationId = list.find((organization) => organization.id === chosen)?.id ?? (several ? null : (list[0]?.id ?? null));
  const details = transport.useOrganization(organizationId);
  const shown: Page = organizationId === null ? { kind: "list" } : opened?.organizationId === organizationId ? opened.page : { kind: "organization" };
  const backToList = () => {
    setChosen(null);
    setOpened(null);
  };
  const ref = useRef<HTMLDivElement>(null);
  usePageFocus(ref, shown.kind === "member" ? `member:${shown.userId}` : shown.kind);

  const body = (() => {
    if (mine.status === "error") return <p className="error">{mine.message}</p>;
    if (mine.status === "loading") return <p className="note">Loading…</p>;
    if (list.length === 0) return <p className="note">You aren't in an organization yet. Setting up a project creates one, and invites from others appear here once you accept them by signing in.</p>;
    if (shown.kind === "list") {
      const first = list.find((organization) => organization.id === projectOrganizationId);
      const ordered = first === undefined ? list : [first, ...list.filter((organization) => organization !== first)];
      return (
        <div className="ds-group">
          {ordered.map((organization) => (
            <NavRow
              key={organization.id}
              label={organization.name}
              value={roleLabel(organization.role)}
              onClick={() => setChosen(organization.id)}
            />
          ))}
        </div>
      );
    }
    if (details.status === "error") return <p className="error">{details.message}</p>;
    if (details.status === "loading") return <p className="note">Loading…</p>;
    return null;
  })();

  if (body !== null || details.status !== "ready") {
    return (
      <Dialog label="Organization" onClose={onClose}>
        <div ref={ref} className="ds-page">
          <DialogHeader
            title={shown.kind === "list" ? "Organizations" : "Organization"}
            onBack={shown.kind !== "list" && several ? backToList : undefined}
            onClose={onClose}
          />
          {body}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog label="Organization" onClose={onClose}>
      <div ref={ref}>
        <OrganizationPages
          key={details.data.id}
          organization={details.data}
          page={shown}
          setPage={(page) => setOpened({ organizationId: details.data.id, page })}
          onBackToList={several ? backToList : undefined}
          onLeft={() => {
            notify(`You left ${details.data.name}`);
            if (several) backToList();
            else onClose();
          }}
          projectId={projectId}
          onClose={onClose}
          notify={notify}
        />
      </div>
    </Dialog>
  );
}

function OrganizationPages({
  organization,
  page,
  setPage,
  onBackToList,
  onLeft,
  projectId,
  onClose,
  notify,
}: {
  organization: OrganizationDetails;
  page: Page;
  setPage: (page: Page) => void;
  onBackToList: (() => void) | undefined;
  onLeft: () => void;
  projectId: string | null;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const transport = useTransport();
  const admin = organization.role === "admin";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const go = (next: Page) => {
    setError(null);
    setConfirming(false);
    setPage(next);
  };
  const attempt = async (work: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const errorLine = error !== null && (
    <p className="error" role="alert">
      {error}
    </p>
  );
  const you = organization.members.find((member) => member.you);
  const leave = () =>
    void attempt(async () => {
      await transport.removeMember({ organizationId: organization.id, userId: you!.userId });
      onLeft();
    });

  if (page.kind === "name" && admin) {
    return (
      <NamePage
        current={organization.name}
        busy={busy}
        error={errorLine}
        onBack={() => go({ kind: "organization" })}
        onClose={onClose}
        onSave={(name) =>
          void attempt(() => transport.renameOrganization(organization.id, name)).then((ok) => {
            if (!ok) return;
            notify("Organization renamed");
            go({ kind: "organization" });
          })
        }
      />
    );
  }

  if (page.kind === "invite" && admin) {
    return (
      <InvitePage
        busy={busy}
        error={errorLine}
        onBack={() => go({ kind: "organization" })}
        onClose={onClose}
        onSend={(email, role) =>
          void attempt(async () => {
            const { status } = await transport.inviteMember({ organizationId: organization.id, email, role, ...(projectId === null ? {} : { projectId }) });
            const address = email.trim();
            notify(status === "invited" ? `Invite sent to ${address}` : status === "member" ? `${address} is already a member` : `${address} is already invited`);
          }).then((ok) => ok && go({ kind: "organization" }))
        }
      />
    );
  }

  const member = page.kind === "member" ? organization.members.find((each) => each.userId === page.userId) : undefined;
  if (member !== undefined && admin) {
    return (
      <div className="ds-page">
        <DialogHeader title={member.you ? `${member.name} (you)` : member.name} onBack={() => go({ kind: "organization" })} onClose={onClose} />
        {member.email !== null && <p className="note">{member.email}</p>}
        {errorLine}
        <div className="ds-group">
          <SettingRow label="Role">
            {(labelId) => (
              <Select
                value={member.role}
                options={ROLES}
                labelledBy={labelId}
                disabled={busy}
                onChange={(role) =>
                  void attempt(() => transport.setMemberRole({ organizationId: organization.id, userId: member.userId, role: role as OrganizationRole })).then(
                    (ok) => ok && notify(`${member.you ? "You are" : `${member.name} is`} now ${role === "admin" ? "an admin" : "a member"}`),
                  )
                }
              />
            )}
          </SettingRow>
        </div>
        <div className="ds-group">
          <hr className="ds-divider" />
          {confirming ? (
            <Confirm
              question={member.you ? `Leave ${organization.name}?` : `Remove ${member.name} from ${organization.name}?`}
              keep={member.you ? "Stay" : `Keep ${member.name}`}
              act={member.you ? "Leave" : "Remove"}
              busy={busy}
              onKeep={() => setConfirming(false)}
              onAct={() =>
                member.you
                  ? leave()
                  : void attempt(() => transport.removeMember({ organizationId: organization.id, userId: member.userId })).then((ok) => {
                      if (!ok) return;
                      notify(`${member.name} was removed`);
                      go({ kind: "organization" });
                    })
              }
            />
          ) : (
            <NavRow label={member.you ? "Leave organization" : "Remove from organization"} onClick={() => setConfirming(true)} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ds-page">
      <DialogHeader title={organization.name} onBack={onBackToList} onClose={onClose} />
      {errorLine}
      <div className="ds-group">
        {admin ? (
          <NavRow label="Name" value={organization.name} onClick={() => go({ kind: "name" })} />
        ) : (
          <SettingRow label="Name">{(labelId) => <span aria-labelledby={labelId}>{organization.name}</span>}</SettingRow>
        )}
        {organization.plan !== null && <SettingRow label="Plan">{(labelId) => <span aria-labelledby={labelId}>{organization.plan}</span>}</SettingRow>}
      </div>
      <div className="ds-group" role="group" aria-label="Members">
        <h4 className="ds-group-label">Members</h4>
        {organization.members.map((each) =>
          admin ? (
            <NavRow key={each.userId} label={<Person member={each} />} value={roleLabel(each.role)} onClick={() => go({ kind: "member", userId: each.userId })} />
          ) : (
            <div key={each.userId} className="ds-row">
              <Person member={each} />
              <span className="note">{roleLabel(each.role)}</span>
            </div>
          ),
        )}
        {admin && <NavRow label="Invite by email" onClick={() => go({ kind: "invite" })} />}
      </div>
      {admin && organization.invites.length > 0 && (
        <div className="ds-group" role="group" aria-label="Invited">
          <h4 className="ds-group-label">Invited</h4>
          {organization.invites.map((invite) => (
            <div key={invite._id} className="ds-row">
              <span className="ds-row-label stacked">
                <span className="ellipsis">{invite.email}</span>
                <span className="note">
                  {roleLabel(invite.role)} · invited by {invite.invitedBy}
                </span>
              </span>
              <button
                type="button"
                className="btn small ghost"
                disabled={busy}
                aria-label={`Withdraw the invite to ${invite.email}`}
                onClick={() => void attempt(() => transport.revokeInvite(invite._id)).then((ok) => ok && notify(`Invite to ${invite.email} withdrawn`))}
              >
                Withdraw
              </button>
            </div>
          ))}
        </div>
      )}
      {!admin && you !== undefined && (
        <div className="ds-group">
          <hr className="ds-divider" />
          {confirming ? (
            <Confirm question={`Leave ${organization.name}?`} keep="Stay" act="Leave" busy={busy} onKeep={() => setConfirming(false)} onAct={leave} />
          ) : (
            <NavRow label="Leave organization" onClick={() => setConfirming(true)} />
          )}
        </div>
      )}
    </div>
  );
}

function Person({ member }: { member: OrganizationMember }) {
  return (
    <span className="ds-person">
      <Avatar name={member.name} imageUrl={member.imageUrl} />
      <span className="stacked">
        <span className="ellipsis">
          {member.name}
          {member.you && <span className="note"> (you)</span>}
        </span>
        {member.email !== null && <span className="note ellipsis">{member.email}</span>}
      </span>
    </span>
  );
}

function Confirm({ question, keep, act, busy, onKeep, onAct }: { question: string; keep: string; act: string; busy: boolean; onKeep: () => void; onAct: () => void }) {
  const keepButton = useRef<HTMLButtonElement>(null);
  useEffect(() => keepButton.current?.focus(), []);
  return (
    <div className="warning stacked" role="alert">
      <span>{question}</span>
      <div className="row end">
        <button ref={keepButton} type="button" className="btn small" disabled={busy} onClick={onKeep}>
          {keep}
        </button>
        <button type="button" className="btn small danger solid" disabled={busy} onClick={onAct}>
          {busy ? `${act}…` : act}
        </button>
      </div>
    </div>
  );
}

function NamePage({
  current,
  busy,
  error,
  onBack,
  onClose,
  onSave,
}: {
  current: string;
  busy: boolean;
  error: ReactNode;
  onBack: () => void;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  const unchanged = name.trim() === "" || name.trim() === current;
  return (
    <form
      className="ds-page"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged) onSave(name);
      }}
    >
      <DialogHeader title="Organization name" onBack={onBack} onClose={onClose} />
      <label className="stacked">
        <span className="field-label">Name</span>
        <input className="field" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </label>
      {error}
      <div className="ds-actions">
        <button type="submit" className="btn primary" disabled={busy || unchanged}>
          {busy ? "Saving…" : "Save name"}
        </button>
      </div>
    </form>
  );
}

function InvitePage({
  busy,
  error,
  onBack,
  onClose,
  onSend,
}: {
  busy: boolean;
  error: ReactNode;
  onBack: () => void;
  onClose: () => void;
  onSend: (email: string, role: OrganizationRole) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationRole>("member");
  return (
    <form
      className="ds-page"
      onSubmit={(event) => {
        event.preventDefault();
        if (email.trim() !== "") onSend(email, role);
      }}
    >
      <DialogHeader title="Invite by email" onBack={onBack} onClose={onClose} />
      <p className="note">They join when they sign in to Critiqs with this address.</p>
      <label className="stacked">
        <span className="field-label">Email</span>
        <input className="field" type="email" autoComplete="off" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <div className="ds-group">
        <SettingRow label="Role">{(labelId) => <Select value={role} options={ROLES} labelledBy={labelId} onChange={(value) => setRole(value as OrganizationRole)} />}</SettingRow>
      </div>
      {error}
      <div className="ds-actions">
        <button type="submit" className="btn primary" disabled={busy || email.trim() === ""}>
          {busy ? "Sending…" : "Send invite"}
        </button>
      </div>
    </form>
  );
}
