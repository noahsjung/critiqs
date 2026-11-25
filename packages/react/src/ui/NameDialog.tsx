import { useState } from "react";
import { Dialog } from "./common.tsx";

/** Changes the name shown on the reviewer's comments, wherever they use Critiqs. */
export function NameDialog({
  current,
  onSave,
  onClose,
}: {
  current: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const save = async () => {
    if (trimmed === "" || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Your name couldn't be changed. Try again.");
      setSaving(false);
    }
  };

  return (
    <Dialog label="Change display name" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <h3>Change display name</h3>
        <p>Everyone in your projects sees this name on your comments. Your email address is never shown.</p>
        <input
          className="field"
          aria-label="Display name"
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        {error !== null && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={trimmed === "" || trimmed === current || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
