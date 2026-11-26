import { MAX_DEVELOPER_INVITES_PER_PROJECT } from "@critiqs/core";
import { useEffect, useId, useRef } from "react";
import { copy } from "../copy.ts";

/**
 * Up to three developers' email addresses, added and removed one at a time.
 * `errors` has one entry per field (see `developerErrors`); null hides them.
 * Each time `refused` goes up, after the person tried to go on with an
 * invalid address, focus moves to the first field with an error, so a screen
 * reader reads its label and the error it describes.
 */
export function DeveloperEmails({
  fields,
  onChange,
  errors,
  refused = 0,
  note,
}: {
  fields: readonly string[];
  onChange: (fields: string[]) => void;
  errors: readonly (string | null)[] | null;
  refused?: number;
  note?: string;
}) {
  const groupId = useId();
  const fieldId = useId();
  const list = useRef<HTMLDivElement>(null);
  // A field added or removed by a button moves focus to the last field, since the button may be gone.
  const focusLast = useRef(false);
  useEffect(() => {
    if (!focusLast.current) return;
    focusLast.current = false;
    const inputs = list.current?.querySelectorAll("input");
    inputs?.[inputs.length - 1]?.focus();
  }, [fields.length]);
  useEffect(() => {
    if (refused > 0) list.current?.querySelector<HTMLInputElement>("input[aria-invalid='true']")?.focus();
  }, [refused]);
  const update = (index: number, value: string) => onChange(fields.map((field, at) => (at === index ? value : field)));
  return (
    <div className="ds-group developers" role="group" aria-labelledby={groupId}>
      <p className="ds-group-label" id={groupId}>
        {copy.developers.group}
      </p>
      {note !== undefined && <p className="note">{note}</p>}
      <div ref={list} className="developer-fields">
        {fields.map((field, index) => {
          const error = errors?.[index] ?? null;
          const id = `${fieldId}-${index}`;
          return (
            <div key={index} className="developer-field">
              <label className="visually-hidden" htmlFor={id}>
                {copy.developers.field(index + 1)}
              </label>
              <div className="row">
                <input
                  id={id}
                  className="field"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={copy.developers.placeholder}
                  value={field}
                  aria-invalid={error !== null}
                  aria-describedby={error === null ? undefined : `${id}-error`}
                  onChange={(event) => update(index, event.target.value)}
                />
                {fields.length > 1 && (
                  <button
                    type="button"
                    className="btn ghost"
                    aria-label={copy.developers.remove(field)}
                    onClick={() => {
                      focusLast.current = true;
                      onChange(fields.filter((_, at) => at !== index));
                    }}
                  >
                    {copy.developers.removeShort}
                  </button>
                )}
              </div>
              {error !== null && (
                <p className="error" id={`${id}-error`}>
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {fields.length < MAX_DEVELOPER_INVITES_PER_PROJECT ? (
        <div>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              focusLast.current = true;
              onChange([...fields, ""]);
            }}
          >
            {copy.developers.add}
          </button>
        </div>
      ) : (
        <p className="note">{copy.developers.atLimit(MAX_DEVELOPER_INVITES_PER_PROJECT)}</p>
      )}
    </div>
  );
}
