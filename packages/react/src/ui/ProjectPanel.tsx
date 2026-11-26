import type { ProjectInfo } from "@critiqs/core";
import type { Reviewer } from "../session.ts";
import { useTransport } from "../transport.ts";
import { Avatar, copyText } from "./common.tsx";
import { PlanUsage } from "./Setup.tsx";

/**
 * The side panel in Browse mode: the project itself, rather than its comments,
 * which live in Comment mode. Shows who can reach it and its settings.
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
  notify: (message: string) => void;
}) {
  const people = useTransport().useParticipants(project._id, "");
  const others = people.status === "ready" ? people.data : [];
  const copyId = async () => {
    await copyText(project._id);
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

      <section className="review-address" aria-label="Who has access">
        <strong>Who has access</strong>
        <span className="note">
          {project.reviewAccess === "organization"
            ? "Only members of the project's organization can see and add comments. Invite people to the organization to let them review."
            : "Anyone who signs in while using this prototype can see and add comments. Control access by controlling who can reach the prototype."}
        </span>
        <ul className="people">
          <li>
            <Avatar name={reviewer.name} imageUrl={reviewer.pictureUrl} />
            <span>
              {reviewer.name} <span className="note">(you{project.isOwner ? ", project owner" : ""})</span>
            </span>
          </li>
          {others.map((person) => (
            <li key={person._id}>
              <Avatar name={person.name} imageUrl={person.imageUrl} />
              <span>{person.name}</span>
            </li>
          ))}
        </ul>
        {others.length > 0 && <span className="note">People who commented most recently.</span>}
      </section>

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
