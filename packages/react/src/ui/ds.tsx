import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import { Menu, MenuItem, useMenu } from "./common.tsx";
import { BackIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon } from "./icons.tsx";

// Critiqs's design system: the shared pieces settings and setup screens are
// built from, so every screen looks and behaves the same. The rules for using
// them are in docs/design-system.md; their styles are the `ds-` rules in
// styles.ts.

/**
 * A dialog's title, with Back for a step after the first and Close. `step`
 * shows where a multi-step flow is, as dots.
 */
export function DialogHeader({
  title,
  onBack,
  onClose,
  step,
}: {
  title: string;
  onBack?: () => void;
  onClose?: () => void;
  step?: { current: number; count: number };
}) {
  return (
    <div className="ds-dialog-header">
      {onBack !== undefined && (
        <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
          <BackIcon />
        </button>
      )}
      <h3>{title}</h3>
      {step !== undefined && <StepDots current={step.current} count={step.count} />}
      {onClose !== undefined && (
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

/**
 * Moves focus into a page of a dialog when the page changes, since the
 * control that changed it is gone: to its first field, else its first row,
 * else its first button. Not on the first render, where the dialog places
 * focus itself, unless `initial`.
 */
export function usePageFocus(ref: RefObject<HTMLElement | null>, page: unknown, { initial = false }: { initial?: boolean } = {}) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current && !initial) {
      first.current = false;
      return;
    }
    first.current = false;
    const scope = ref.current;
    if (scope === null) return;
    const target =
      scope.querySelector<HTMLElement>("input:not(:disabled)") ??
      scope.querySelector<HTMLElement>(".ds-select:not(:disabled), [role='switch']:not(:disabled), .ds-nav-row:not(:disabled)") ??
      scope.querySelector<HTMLElement>("button:not(:disabled)");
    target?.focus({ preventScroll: true });
  }, [page]);
}

/** Where a multi-step flow is: one dot per step, the current one filled. */
export function StepDots({ current, count }: { current: number; count: number }) {
  return (
    <span className="ds-steps" role="img" aria-label={`Step ${current} of ${count}`}>
      {Array.from({ length: count }, (_, index) => (
        <i key={index} className={index + 1 === current ? "on" : undefined} />
      ))}
    </span>
  );
}

/**
 * One setting: its name on the left, its control on the right. The control
 * gets the name's id, to label itself with `aria-labelledby`.
 */
export function SettingRow({ label, children }: { label: ReactNode; children: (labelId: string) => ReactNode }) {
  const labelId = useId();
  return (
    <div className="ds-row">
      <span className="ds-row-label" id={labelId}>
        {label}
      </span>
      <div className="ds-row-control">{children(labelId)}</div>
    </div>
  );
}

/** A row that opens another page of the dialog, or does one thing, with its current value. */
export function NavRow({ label, value, onClick, disabled = false }: { label: ReactNode; value?: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="ds-nav-row" disabled={disabled} onClick={onClick}>
      <span className="label">{label}</span>
      {value !== undefined && <span className="value">{value}</span>}
      <ChevronRightIcon />
    </button>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  /** Quiet text beside the option in the open menu, never on the button, such as a model's cost. */
  detail?: string;
}

/**
 * Chooses one option from a menu. The button shows the chosen option's name;
 * the menu adds each option's detail. Choosing the chosen one again does
 * nothing.
 */
export function Select({
  value,
  options,
  onChange,
  labelledBy,
  disabled = false,
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** The id of the setting's name, such as `SettingRow` gives. */
  labelledBy: string;
  disabled?: boolean;
}) {
  const menu = useMenu();
  const buttonId = useId();
  const chosen = options.find((option) => option.value === value);
  return (
    <>
      <button
        id={buttonId}
        type="button"
        className="ds-select"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-labelledby={`${labelledBy} ${buttonId}`}
        disabled={disabled}
        onClick={menu.toggle}
      >
        <span>{chosen?.label ?? "Choose"}</span>
        <ChevronDownIcon />
      </button>
      {menu.open && (
        <Menu anchor={menu.anchor!} onClose={menu.close} matchWidth>
          {options.map((option) => (
            <MenuItem
              key={option.value}
              selected={option.value === value}
              detail={option.detail}
              onSelect={() => {
                menu.close();
                if (option.value !== value) onChange(option.value);
              }}
            >
              {option.label}
            </MenuItem>
          ))}
        </Menu>
      )}
    </>
  );
}

/** Turns one setting on or off, taking effect at once. */
export function Switch({ checked, onChange, labelledBy, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; labelledBy: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className="ds-switch" aria-checked={checked} aria-labelledby={labelledBy} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export const NEAR_LIMIT = 0.8;

/** How much of a limit is used: a thin bar that turns amber near the limit and red at the ceiling, which is the limit unless extra is allowed past it. */
export function Meter({ value, max, label, ceiling = max, valueText }: { value: number; max: number; label: string; ceiling?: number; valueText?: string }) {
  const share = max <= 0 ? 1 : Math.min(1, value / max);
  return (
    <div
      className={`ds-meter${value >= ceiling ? " full" : share >= NEAR_LIMIT ? " high" : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      aria-valuetext={valueText}
    >
      {value > 0 && <span style={{ width: `${Math.round(share * 100)}%` }} />}
    </div>
  );
}
