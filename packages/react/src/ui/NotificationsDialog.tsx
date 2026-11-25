import { useState } from "react";
import { errorMessage, useTransport } from "../transport.ts";
import { Dialog } from "./common.tsx";

/** The reviewer's email choices: mention emails, reply emails, and muting this project. */
export function NotificationsDialog({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const transport = useTransport();
  const settings = transport.useNotificationSettings(projectId);
  const [error, setError] = useState<string | null>(null);
  const change = (update: { mentionEmails?: boolean; replyEmails?: boolean; projectMuted?: boolean }) => {
    setError(null);
    transport.setNotificationSettings({ projectId, ...update }).catch((failure) => setError(errorMessage(failure)));
  };

  return (
    <Dialog label="Email notifications" onClose={onClose}>
      <h3>Email notifications</h3>
      <p>
        Critiqs emails you when someone mentions you, or replies in a thread you started, replied to, or were mentioned in. Emails show the
        thread's image and whole discussion, and link to the comment.
      </p>
      {settings.status === "ready" ? (
        <div className="settings">
          <label className="row">
            <input
              type="checkbox"
              checked={settings.data.mentionEmails}
              onChange={(event) => change({ mentionEmails: event.target.checked })}
            />
            Email me when someone mentions me
          </label>
          {/* Backends from before reply emails don't report this choice. */}
          {settings.data.replyEmails !== undefined && (
            <label className="row">
              <input
                type="checkbox"
                checked={settings.data.replyEmails}
                onChange={(event) => change({ replyEmails: event.target.checked })}
              />
              Email me about new replies in threads I'm in
            </label>
          )}
          <label className="row">
            <input
              type="checkbox"
              checked={settings.data.projectMuted}
              disabled={!settings.data.mentionEmails && settings.data.replyEmails === false}
              onChange={(event) => change({ projectMuted: event.target.checked })}
            />
            Mute {projectName}
          </label>
        </div>
      ) : (
        <p className="note">{settings.status === "error" ? settings.message : "Loading…"}</p>
      )}
      {error !== null && <div className="error">{error}</div>}
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
