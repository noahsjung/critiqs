import { isPrivateReviewAddress, MAX_PROJECT_NAME_LENGTH, type OrganizationSummary, type ProjectInfo, type ReviewAccess, validReviewUrl } from "@critiqs/core";
import { type ReactNode, useContext, useEffect, useId, useRef, useState } from "react";
import type { Reviewer } from "../session.ts";
import { errorMessage, useTransport } from "../transport.ts";
import { copyText } from "./common.tsx";
import { OpenBillingContext } from "./BillingDialog.tsx";
import { Meter, NEAR_LIMIT, Select, type SelectOption, SettingRow } from "./ds.tsx";
import { amount, ceilingOf, type UsageRow, usageName, usageText } from "./usage.ts";

/**
 * Project setup in the sidebar (F1). A developer signs in, names the project,
 * and copies the command that writes its ID into the code. The browser remembers the new
 * project so they can comment before changing any code.
 */
export function Setup({
  reviewer,
  signedIn,
  organizations = false,
  onSignIn,
  configuredProjectId,
  browserProjectId,
  onUseProject,
  onDone,
  backLabel,
  notify,
}: {
  reviewer: Reviewer | null;
  /** Signed in and accepted by the backend. */
  signedIn: boolean;
  /** The backend keeps organizations' members, so a new project can go in any of the reviewer's organizations. */
  organizations?: boolean;
  onSignIn: () => void;
  /** Project ID from the prototype's code, if any. */
  configuredProjectId: string | null;
  /** Project remembered in this browser until the ID is in the code. */
  browserProjectId: string | null;
  onUseProject: (projectId: string | null) => void;
  onDone: () => void;
  /** The finished button's label once the project is in the code, naming the panel it returns to. */
  backLabel: string;
  notify: (message: string) => void;
}) {
  const projectId = configuredProjectId ?? browserProjectId;

  if (reviewer === null || !signedIn) {
    return (
      <div className="setup">
        <h3>Set up Critiqs for this prototype</h3>
        <p>Setup creates a shared feedback project. Reviewers then comment directly on the prototype's elements.</p>
        <Step number={1} title="Sign in">
          <p>Sign in with a verified email address to create the project.</p>
          <div>
            <button type="button" className="btn primary" onClick={onSignIn} disabled={reviewer !== null}>
              {reviewer === null ? "Sign in" : "Signing in…"}
            </button>
          </div>
        </Step>
        <Step number={2} title="Name the project" />
        <Step number={3} title="Add the project ID to the prototype" />
      </div>
    );
  }
  if (projectId === null) return <CreateProject organizations={organizations} onCreated={onUseProject} />;
  return (
    <ProjectReady
      projectId={projectId}
      configured={configuredProjectId !== null}
      onChange={() => onUseProject(null)}
      onDone={onDone}
      backLabel={backLabel}
      notify={notify}
    />
  );
}

function Step({ number, title, done, children }: { number: number; title: string; done?: boolean; children?: ReactNode }) {
  return (
    <div className={`step${done ? " done" : ""}`}>
      <span className="num">{done ? "✓" : number}</span>
      <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}

function defaultOrganization(choices: OrganizationSummary[]): OrganizationSummary | undefined {
  return choices.find((organization) => organization.home) ?? choices[0];
}

function CreateProject({ organizations, onCreated }: { organizations: boolean; onCreated: (projectId: string) => void }) {
  const transport = useTransport();
  const mine = transport.useMyProjects(true);
  const memberOf = transport.useMyOrganizations(organizations);
  const choices = memberOf.status === "ready" ? memberOf.data : [];
  const [picked, setPicked] = useState<string | null>(null);
  const organizationId = choices.find((organization) => organization.id === picked)?.id ?? defaultOrganization(choices)?.id;
  const organizationLabel = useId();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewUrl = savedAddress(address);

  const submit = async () => {
    if (name.trim() === "" || reviewUrl === undefined) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await transport.createProject(name, reviewUrl, organizationId));
    } catch (failure) {
      setError(errorMessage(failure));
      setSaving(false);
    }
  };

  return (
    <div className="setup">
      <h3>Set up Critiqs for this prototype</h3>
      <p>Setup creates a shared feedback project. Reviewers then comment directly on the prototype's elements.</p>
      <Step number={1} title="Sign in" done />
      <Step number={2} title="Name the project">
        <form
          className="setup-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="stacked">
            <span className="note">Project name</span>
            <input
              className="field"
              placeholder="For example, Admin console prototype"
              value={name}
              maxLength={MAX_PROJECT_NAME_LENGTH}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <ReviewAddressField label="Review address (optional)" value={address} onChange={setAddress} owner />
          {choices.length > 1 && organizationId !== undefined && (
            <div className="stacked">
              <span className="note" id={organizationLabel}>
                Organization
              </span>
              <Select
                value={organizationId}
                options={choices.map((organization) => ({ value: organization.id, label: organization.name }))}
                labelledBy={organizationLabel}
                onChange={setPicked}
              />
            </div>
          )}
          <div>
            <button type="submit" className="btn primary" disabled={saving || name.trim() === "" || reviewUrl === undefined}>
              {saving ? "Creating…" : "Create project"}
            </button>
          </div>
        </form>
        {error !== null && <div className="error">{error}</div>}
        {mine.status === "ready" && mine.data.length > 0 && (
          <>
            <span className="note">Or reconnect a project you created:</span>
            <div className="project-list">
              {mine.data.map((project) => (
                <button key={project._id} type="button" onClick={() => onCreated(project._id)}>
                  {project.name}
                  <span className="note"> · created {new Date(project.createdAt).toLocaleDateString()}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </Step>
      <Step number={3} title="Add the project ID to the prototype" />
    </div>
  );
}

function ProjectReady({
  projectId,
  configured,
  onChange,
  onDone,
  backLabel,
  notify,
}: {
  projectId: string;
  configured: boolean;
  onChange: () => void;
  onDone: () => void;
  backLabel: string;
  notify: (message: string) => void;
}) {
  const project = useTransport().useProject(projectId);
  const command = `npx critiqs init ${projectId}`;
  const copy = async (text: string, what: string) => {
    await copyText(text);
    notify(`${what} copied`);
  };

  if (project.status === "error" && project.code === "forbidden") {
    return (
      <div className="setup">
        <h3>No access to this project</h3>
        <p>{project.message}</p>
      </div>
    );
  }
  if (project.status === "error") {
    return (
      <div className="setup">
        <h3>Project not found</h3>
        <p>
          {configured
            ? "The project ID in this prototype's code is not known to this Critiqs backend. Check the ID, or the backend it points to."
            : "The project remembered in this browser no longer exists."}
        </p>
        {!configured && (
          <div>
            <button type="button" className="btn" onClick={onChange}>
              Set up a new project
            </button>
          </div>
        )}
      </div>
    );
  }
  const name = project.status === "ready" ? project.data.name : "…";

  return (
    <div className="setup">
      <h3>{configured ? `Connected to ${name}` : `${name} is ready`}</h3>
      {configured ? (
        <SetupDone projectId={projectId} copy={copy} />
      ) : (
        <>
          <div className="step done">
            <span className="num">✓</span>
            <div className="grow row between wrap">
              <strong>Project created</strong>
              <button type="button" className="link-btn" onClick={onChange}>
                Use a different project
              </button>
            </div>
          </div>
          <Step number={2} title="Add the project ID to the prototype">
            <span className="note">Run this in the prototype's folder:</span>
            <div className="code">
              <code>{command}</code>
              <button type="button" className="btn small" onClick={() => copy(command, "Command")}>
                Copy
              </button>
            </div>
            <span className="note">Or give the prototype's Critiqs component or tag this project ID, keeping its other settings:</span>
            <div className="code">
              <code>{projectId}</code>
              <button type="button" className="btn small" onClick={() => copy(projectId, "Project ID")}>
                Copy
              </button>
            </div>
            <span className="note">Until then, only this browser uses the project.</span>
          </Step>
        </>
      )}
      {project.status === "ready" && <ReviewAddress project={project.data} notify={notify} />}
      {project.status === "ready" && <WhoCanReview project={project.data} notify={notify} />}
      {project.status === "ready" && <PlanUsage project={project.data} className="setup-section" />}
      <p className="note">
        {project.status === "ready" && project.data.reviewAccess === "organization"
          ? "Only members of the project's organization see its feedback."
          : "Anyone who can open the prototype and sign in sees its feedback."}
      </p>
      <div>
        <button type="button" className="btn primary" onClick={onDone}>
          {configured ? backLabel : "Start commenting"}
        </button>
      </div>
    </div>
  );
}

function SetupDone({ projectId, copy }: { projectId: string; copy: (text: string, what: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div className="step done">
      <span className="num">✓</span>
      <div className="grow setup-details">
        <div className="row between wrap">
          <strong>Project is set up</strong>
          <button type="button" className="link-btn" aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={() => setOpen(!open)}>
            {open ? "Hide details" : "Details"}
          </button>
        </div>
        {open && (
          <div id={detailsId} className="setup-details">
            <span className="note">The prototype's code names this project, so every copy (local, preview, and deployed) shows its comments.</span>
            <div className="code light">
              <code>{projectId}</code>
              <button type="button" className="btn small" onClick={() => copy(projectId, "Project ID")}>
                Copy
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * This page's address, which the owner can choose as the review address. Only
 * HTTPS, or plain HTTP on this computer, can be linked.
 */
export function currentReviewUrl(): string | null {
  return validReviewUrl(window.location.href);
}

/** The address to save: null when left empty, undefined when emails can't link to it. */
function savedAddress(value: string): string | null | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? null : (validReviewUrl(trimmed) ?? undefined);
}

/** Says who can open a private review address; informs without blocking it. */
function PrivateAddressWarning({ owner }: { owner: boolean }) {
  return (
    <div className="warning" role="note">
      Only people on this computer or its private network (such as a Tailscale network) can open this address, so
      reviewers elsewhere can't follow mention emails to it.
      {owner ? " If reviewers use a deployed copy, enter that address instead." : " The project's owner can change it."}
    </div>
  );
}

/** The review address the owner types, with this page offered and private addresses explained. */
function ReviewAddressField({
  label,
  value,
  onChange,
  owner,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  owner: boolean;
  autoFocus?: boolean;
}) {
  const saved = savedAddress(value);
  const page = currentReviewUrl();
  return (
    <div className="stacked">
      <label className="stacked">
        <span className="note">{label}</span>
        <input
          className="field"
          inputMode="url"
          spellCheck={false}
          autoCapitalize="none"
          placeholder="https://your-team.github.io/prototype/"
          value={value}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <span className="note">
        The page reviewers open, such as the deployed prototype. Mention emails open it, and Critiqs then shows the
        comment.
      </span>
      {page !== null && value.trim() !== page && (
        <span className="note review-address-page">
          <button type="button" className="link-btn" onClick={() => onChange(page)}>
            Use this page
          </button>{" "}
          ({page})
        </span>
      )}
      {saved === undefined && <div className="error">Enter the full address, starting with https:// (or http://localhost while testing).</div>}
      {typeof saved === "string" && isPrivateReviewAddress(saved) && <PrivateAddressWarning owner={owner} />}
    </div>
  );
}

/** The project's review address, which only its owner can change. */
function ReviewAddress({ project, notify }: { project: ProjectInfo; notify: (message: string) => void }) {
  const transport = useTransport();
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const isEditing = editing !== null;
  const reviewUrl = editing === null ? null : savedAddress(editing);
  useEffect(() => {
    if (!isEditing && wasEditing.current) opener.current?.focus();
    wasEditing.current = isEditing;
  }, [isEditing]);
  const save = async () => {
    if (typeof reviewUrl !== "string") return;
    setSaving(true);
    setError(null);
    try {
      await transport.setReviewUrl({ projectId: project._id, reviewUrl });
      setEditing(null);
      notify("Review address saved");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="setup-section review-address-section" aria-label="Review address">
      <div className="row between">
        <strong>Review address</strong>
        {project.isOwner && editing === null && (
          <button ref={opener} type="button" className="link-btn" onClick={() => setEditing(project.reviewUrl ?? "")}>
            {project.reviewUrl === null ? "Add the address" : "Change"}
          </button>
        )}
      </div>
      {editing === null ? (
        <>
          <span className="note">
            {project.reviewUrl === null ? "None yet, so mention emails can't link to comments." : `Mention emails open ${project.reviewUrl}`}
          </span>
          {project.reviewUrl !== null && isPrivateReviewAddress(project.reviewUrl) && <PrivateAddressWarning owner={project.isOwner} />}
        </>
      ) : (
        <form
          className="setup-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <ReviewAddressField label="Address" value={editing} onChange={setEditing} owner autoFocus />
          <span className="note">Emails sent from now on use it; links in emails already sent don't change.</span>
          <div className="row">
            <button type="submit" className="btn small primary" disabled={saving || typeof reviewUrl !== "string"}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn small" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error !== null && <div className="error">{error}</div>}
    </section>
  );
}

const REVIEW_ACCESS_LABELS: Record<ReviewAccess, string> = {
  anyone: "Anyone who signs in",
  organization: "Organization members",
};

/**
 * Who can review the project. Its owners choose, and the choice saves at
 * once; everyone else sees it. Backends before the setting report none, so
 * the row isn't shown.
 */
function WhoCanReview({ project, notify }: { project: ProjectInfo; notify: (message: string) => void }) {
  const transport = useTransport();
  const [saving, setSaving] = useState<ReviewAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (project.reviewAccess === undefined) return null;
  const value = saving ?? project.reviewAccess;
  const options: SelectOption[] = [
    { value: "anyone", label: REVIEW_ACCESS_LABELS.anyone, detail: "Anyone with the project ID" },
    { value: "organization", label: REVIEW_ACCESS_LABELS.organization, detail: project.organization?.name ?? "Invite reviewers to it" },
  ];
  const choose = async (next: ReviewAccess) => {
    setSaving(next);
    setError(null);
    try {
      await transport.setReviewAccess({ projectId: project._id, reviewAccess: next });
      notify(next === "organization" ? "Only organization members can review now" : "Anyone who signs in can review now");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(null);
    }
  };
  return (
    <section className="setup-section" aria-label="Who can review">
      {error !== null && <div className="error">{error}</div>}
      <div className="ds-group">
        <SettingRow label="Who can review">
          {(labelId) =>
            project.isOwner ? (
              <Select value={value} options={options} labelledBy={labelId} disabled={saving !== null} onChange={(next) => void choose(next as ReviewAccess)} />
            ) : (
              <span aria-labelledby={labelId}>{REVIEW_ACCESS_LABELS[value]}</span>
            )
          }
        </SettingRow>
      </div>
    </section>
  );
}

const AI_CREDITS: readonly UsageRow["metric"][] = ["aiCredits", "aiRequests"];
const NEVER_SUMMARIZED: UsageRow["metric"] = "projects";

function shownInSummary(row: UsageRow): boolean {
  return AI_CREDITS.includes(row.metric) || (row.metric !== NEVER_SUMMARIZED && row.used >= row.max * NEAR_LIMIT);
}

function UsageMeter({ row }: { row: UsageRow }) {
  const name = usageName(row);
  const { text, tone } = usageText(row);
  return (
    <div className="usage-meter">
      <div className="row between">
        <span>{name}</span>
        <span className={tone}>{text}</span>
      </div>
      <Meter value={row.used} max={row.max} ceiling={ceilingOf(row)} label={name} valueText={text} />
    </div>
  );
}

export function PlanUsage({ project, className }: { project: ProjectInfo; className: string }) {
  const usage = useTransport().useUsage(project.isOwner ? project._id : null);
  const openBilling = useContext(OpenBillingContext);
  const [all, setAll] = useState(false);
  const listId = useId();
  if (usage.status !== "ready" || usage.data === null) return null;
  const { plan, rows, unlimited, upgradeUrl } = usage.data;
  return (
    <section className={`${className} plan-usage`} aria-label="Plan">
      <div className="row between">
        <strong>{plan} plan</strong>
        {openBilling !== null ? (
          <button type="button" className="link-btn" onClick={() => openBilling.open()}>
            Plan and billing
          </button>
        ) : (
          upgradeUrl !== undefined && (
            <a className="link-btn" href={upgradeUrl} target="_blank" rel="noreferrer noopener">
              Upgrade
            </a>
          )
        )}
      </div>
      <div id={listId} className="plan-usage-rows">
        {(all ? rows : rows.filter(shownInSummary)).map((row) => (
          <UsageMeter key={`${row.metric}-${row.period}`} row={row} />
        ))}
        {(all ? unlimited : unlimited?.filter((row) => AI_CREDITS.includes(row.metric)))?.map((row) => (
          <div key={`${row.metric}-${row.period}`} className="row between usage-unlimited">
            <span>{usageName(row)}</span>
            <span className="note">{amount(row.metric, row.used)} · Unlimited</span>
          </div>
        ))}
        {all && <p className="note">Projects, images, and Critiqs AI credits count for the whole organization.</p>}
      </div>
      <div>
        <button type="button" className="link-btn" aria-expanded={all} aria-controls={listId} onClick={() => setAll(!all)}>
          {all ? "Less" : "All usage"}
        </button>
      </div>
    </section>
  );
}
