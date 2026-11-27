import { planCovers, type Role, suggestedPlan, type TeamSize } from "@critiqs/core";
import { useEffect, useRef } from "react";
import { useBackend } from "../backend.ts";
import { copy } from "../copy.ts";
import type { AboutAnswer, AboutQuestion } from "../flow.ts";

/**
 * "While you're here": team size, then role, one at a time, each a single
 * tap that saves at once. It comes after the person has done the setup, so
 * it never stands between them and Critiqs; Skip moves to the next one.
 */
export function AboutYou({ asking, onAnswered, onSkip }: { asking: AboutQuestion | null; onAnswered: (answer: AboutAnswer) => void; onSkip: () => void }) {
  const backend = useBackend();
  // The tapped answer is gone once the next question shows, so focus moves to it, or to the thanks.
  const next = useRef<HTMLParagraphElement>(null);
  const shown = useRef(asking);
  useEffect(() => {
    if (shown.current === asking) return;
    shown.current = asking;
    next.current?.focus();
  }, [asking]);
  const save = (answer: AboutAnswer) => {
    backend.saveAboutYou(answer).catch((error) => console.warn("Critiqs couldn't save the answer.", error));
    onAnswered(answer);
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

/**
 * The plan that fits the team size the person gave, where the deployment
 * takes payment: what it includes and costs, and, when it's more than the
 * organization has, how to change. Nothing elsewhere, or before the
 * project's organization and its plans load.
 */
export function SuggestedPlan({ projectId, teamSize }: { projectId: string; teamSize: TeamSize }) {
  const backend = useBackend();
  const project = backend.useProject(projectId);
  const organization = project.status === "ready" ? (project.data.organization ?? null) : null;
  const billing = backend.useBillingStatus(organization?.id ?? null);
  const status = billing.status === "ready" ? billing.data : null;
  const upgrade = backend.useUpgradeUrl(status !== null && status.canManage);
  if (organization === null || status === null) return null;
  const plan = suggestedPlan(teamSize, status.plans);
  const includes = status.plans[plan];
  const max = (metric: string) => includes.limits.find((limit) => limit.metric === metric)?.max ?? null;
  const price = status.prices?.plans[plan]?.monthly;
  return (
    <aside className="about plan" aria-label={copy.about.plan.heading}>
      <p className="about-heading">{copy.about.plan.heading}</p>
      {planCovers(status.plan, plan) ? (
        <p className="about-title">{copy.about.plan.fits(status.plans[status.plan].label, organization.name)}</p>
      ) : (
        <>
          <p className="about-title">{copy.about.plan.suggest(includes.label)}</p>
          <p className="note">
            {copy.about.plan.includes(max("reviewers"), max("projects"))}
            {price === undefined ? "" : ` ${copy.about.plan.price(price)}`}
          </p>
          {!status.canManage ? (
            <p className="note">{copy.about.plan.askAdmin(organization.name)}</p>
          ) : upgrade.status === "ready" && upgrade.data !== null ? (
            <div>
              <a className="btn" href={upgrade.data} target="_blank" rel="noreferrer noopener">
                {copy.about.plan.seePlans}
              </a>
            </div>
          ) : (
            <p className="note">{copy.about.plan.changeInCritiqs}</p>
          )}
        </>
      )}
    </aside>
  );
}
