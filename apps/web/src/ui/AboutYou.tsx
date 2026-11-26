import type { Role, TeamSize } from "@critiqs/core";
import { useEffect, useRef } from "react";
import { useBackend } from "../backend.ts";
import { copy } from "../copy.ts";
import type { AboutQuestion } from "../flow.ts";

/**
 * "While you're here": team size, then role, one at a time, each a single
 * tap that saves at once. It comes after the person has done the setup, so
 * it never stands between them and Critiqs; Skip moves to the next one.
 */
export function AboutYou({ asking, onAnswered, onSkip }: { asking: AboutQuestion | null; onAnswered: () => void; onSkip: () => void }) {
  const backend = useBackend();
  // The tapped answer is gone once the next question shows, so focus moves to it, or to the thanks.
  const next = useRef<HTMLParagraphElement>(null);
  const shown = useRef(asking);
  useEffect(() => {
    if (shown.current === asking) return;
    shown.current = asking;
    next.current?.focus();
  }, [asking]);
  const save = (answer: { role: Role } | { teamSize: TeamSize }) => {
    backend.saveAboutYou(answer).catch((error) => console.warn("Critiqs couldn't save the answer.", error));
    onAnswered();
  };
  if (asking === null) {
    return (
      <aside className="about-done" aria-label={copy.about.heading}>
        <p ref={next} className="note" role="status" tabIndex={-1}>
          {copy.about.thanks}
        </p>
      </aside>
    );
  }
  const question = copy.about[asking];
  const titleId = `about-${asking}`;
  return (
    <aside className="about" aria-label={copy.about.heading}>
      <p className="about-heading">{copy.about.heading}</p>
      <p ref={next} className="about-title" id={titleId} tabIndex={-1}>
        {question.title}
      </p>
      <div className="chips" role="group" aria-labelledby={titleId}>
        {(Object.entries(question.options) as [string, string][]).map(([value, label]) => (
          <button key={value} type="button" className="chip" onClick={() => save(asking === "role" ? { role: value as Role } : { teamSize: value as TeamSize })}>
            {label}
          </button>
        ))}
        <button type="button" className="quiet" onClick={onSkip}>
          {copy.skip}
        </button>
      </div>
    </aside>
  );
}
