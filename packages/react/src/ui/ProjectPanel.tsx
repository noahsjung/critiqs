import type { ProjectInfo } from "@critiqs/core";
import type { Reviewer } from "../session.ts";
import { copyText } from "./common.tsx";
import { PlanUsage } from "./Setup.tsx";
import { WhoHasAccess } from "./WhoHasAccess.tsx";
import { useCritiqsRoot } from "../root.ts";

/**
 * The side panel in Browse mode: the project itself, rather than its comments,
 * which live in Comment mode. Shows who has access, which its organization's
 * admins change here, and its settings.
 */
export function ProjectPanel({
  project,
  reviewer,
  openCount,
  unreadCount,
  onShowComments,
  onNotifications,
  onSetup,
  onDocs,
  organizationMembers,
  notify,
}: {
  project: ProjectInfo;
  reviewer: Reviewer;
  openCount: number;
  unreadCount: number;
  onShowComments: () => void;
  onNotifications: () => void;
  onSetup: () => void;
  onDocs: () => void;
  /** The backend's configuration reports `organizationMembers`, so admins manage who has access here. */
  organizationMembers: boolean;
  notify: (message: string) => void;
}) {
  const { shadow } = useCritiqsRoot();
  const copyId = async () => {
    await copyText(project._id, shadow);
    notify("Project ID copied");
  };

  return (
    <div className="setup project-panel">
      <section className="review-address" aria-label="Comments">
        <strong>Comments</strong>
        <span className="note">
          {openCount === 1 ? "1 open thread" : `${openCount} open threads`}
          {unreadCount > 0 && ` · ${unreadCount} unread`}
        </span>
        <div>
          <button type="button" className="link-btn" onClick={onShowComments}>
            Show comments
          </button>
        </div>
      </section>

      <WhoHasAccess project={project} reviewer={reviewer} organizationMembers={organizationMembers} notify={notify} />

      <section className="review-address" aria-label="Your email notifications">
        <strong>Your email notifications</strong>
        <span className="note">Choose which emails you get about this project.</span>
        <div>
          <button type="button" className="link-btn" onClick={onNotifications}>
            Email notifications…
          </button>
        </div>
      </section>

      <section className="review-address" aria-label="Documentation">
        <strong>Documentation</strong>
        <span className="note">What each part of Critiqs does and how to use it.</span>
        <div>
          <button type="button" className="link-btn" onClick={onDocs}>
            Open documentation
          </button>
        </div>
      </section>

      <PlanUsage project={project} className="review-address" />

      <section className="review-address" aria-label="Project ID">
        <strong>Project ID</strong>
        <div className="code light">
          <code>{project._id}</code>
          <button type="button" className="btn small" onClick={() => void copyId()}>
            Copy
          </button>
        </div>
        <div>
          <button type="button" className="link-btn" onClick={onSetup}>
            Project setup
          </button>
        </div>
      </section>
    </div>
  );
}
