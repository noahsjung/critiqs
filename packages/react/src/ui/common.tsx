import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { avatarColor, initials } from "./format.ts";
import { useHidden } from "./hidden.ts";
import { eventPath, madeUp, useCritiqsRoot } from "../root.ts";

export function Avatar({ name, imageUrl, large }: { name: string; imageUrl?: string | null; large?: boolean }) {
  return (
    <span className={`avatar${large ? " large" : ""}`} style={{ background: avatarColor(name) }} title={name}>
      {imageUrl ? <img src={imageUrl} alt="" referrerPolicy="no-referrer" /> : initials(name)}
    </span>
  );
}

/**
 * A menu anchored to a button. Closes on outside click or Escape. Positioned
 * with fixed coordinates so it can leave the sidebar's scroll area.
 */
export function Menu({
  anchor,
  onClose,
  children,
  placement = "below",
  matchWidth = false,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  children: ReactNode;
  placement?: "below" | "above";
  /** At least as wide as its button, as a select's menu is. */
  matchWidth?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (menu === null) return;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    // A select's menu lines up with its button; one wider than the button keeps the button's right edge.
    const start = matchWidth ? Math.min(rect.left, rect.right - width) : rect.right - width;
    const left = Math.min(Math.max(8, start), window.innerWidth - width - 8);
    const top = placement === "above" ? rect.top - height - 6 : Math.min(rect.bottom + 6, window.innerHeight - height - 8);
    setPosition({ left, top: Math.max(8, top) });
  }, [anchor, placement, matchWidth]);

  // Once placed (and so visible), move focus into the menu for keyboard use.
  const placed = position !== null;
  useEffect(() => {
    if (!placed) return;
    // A select's menu starts at its chosen option.
    const chosen = ref.current?.querySelector<HTMLElement>("[role='menuitemradio'][aria-checked='true']");
    (chosen ?? ref.current?.querySelector<HTMLElement>("[role^='menuitem'], button"))?.focus({ preventScroll: true });
  }, [placed]);

  // Closing returns focus to the menu's button, unless the reviewer clicked elsewhere.
  const clickedAway = useRef(false);
  useEffect(
    () => () => {
      if (clickedAway.current || !anchor.isConnected) return;
      // A choice may have focused something else, such as an editor; keep that.
      const root = anchor.getRootNode();
      const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
      if (active !== null && active !== document.body && active.isConnected) return;
      anchor.focus({ preventScroll: true });
    },
    [anchor],
  );

  const hidden = useHidden();
  const { shadow, trustedEventsOnly } = useCritiqsRoot();
  useEffect(() => {
    // Hidden, the host page's clicks and keys are its own.
    if (hidden) return;
    const onPointer = (event: PointerEvent) => {
      const path = eventPath(event, shadow);
      if (!path.includes(ref.current!) && !path.includes(anchor)) {
        clickedAway.current = true;
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !madeUp(event, trustedEventsOnly)) {
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose, hidden, shadow, trustedEventsOnly]);

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={position === null ? { visibility: "hidden", left: 0, top: 0, ...(matchWidth ? { minWidth: anchor.offsetWidth } : {}) } : { ...position, ...(matchWidth ? { minWidth: anchor.offsetWidth } : {}) }}
      onKeyDown={(event) => {
        // Arrow keys, Home, and End move between the items.
        const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)") ?? [])];
        const at = items.indexOf(event.target as HTMLElement);
        const next =
          event.key === "ArrowDown" ? (at + 1) % items.length : event.key === "ArrowUp" ? (at - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
        if (next === null || items.length === 0) return;
        event.preventDefault();
        items[next]!.focus();
      }}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  onSelect,
  checked,
  selected,
  detail,
  danger,
  children,
}: {
  onSelect: () => void;
  /** A choice that toggles, such as a tag's group. */
  checked?: boolean;
  /** One choice among several, as a select's option. */
  selected?: boolean;
  /** Quiet text at the end of the item, such as a model's cost. */
  detail?: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  const mark = checked ?? selected;
  return (
    <button
      type="button"
      role={selected !== undefined ? "menuitemradio" : checked !== undefined ? "menuitemcheckbox" : "menuitem"}
      aria-checked={mark}
      className={`menu-item${danger ? " danger" : ""}`}
      onClick={onSelect}
    >
      {mark !== undefined && <span className="check">{mark ? "✓" : ""}</span>}
      {children}
      {detail !== undefined && <span className="detail">{detail}</span>}
    </button>
  );
}

/** Opens a menu from a button; returns the button props and the menu's open state. */
export function useMenu() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const toggle = useCallback(
    (event: { currentTarget: HTMLElement }) => {
      const target = event.currentTarget;
      setAnchor((current) => (current === null ? target : null));
    },
    [],
  );
  return { anchor, open: anchor !== null, toggle, close };
}

export function Dialog({
  label,
  onClose,
  bare,
  returnFocus,
  children,
}: {
  label: string;
  onClose: () => void;
  /** No dialog card, for an enlarged image. */
  bare?: boolean;
  /** Where focus returns when the control that opened the dialog is gone, such as a menu item. */
  returnFocus?: HTMLElement | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fallback = useRef(returnFocus);
  // Read when focus leaves: hidden, Critiqs holds no focus.
  const hiddenNow = useRef(false);
  useEffect(() => {
    // Move focus into the dialog and give it back afterwards.
    const card = ref.current;
    // Critiqs's controls live in a shadow root, so ask it which one had focus.
    const root = card?.getRootNode();
    const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    const previous = active instanceof HTMLElement ? active : null;
    const first = card?.querySelector<HTMLElement>("button, input, textarea, [tabindex]");
    (first ?? card)?.focus();
    return () => (previous?.isConnected ? previous : fallback.current)?.focus();
  }, []);
  const hidden = useHidden();
  hiddenNow.current = hidden;
  const { trustedEventsOnly } = useCritiqsRoot();
  useEffect(() => {
    if (hidden) return;
    const onKey = (event: KeyboardEvent) => {
      // A menu open inside the dialog closes first.
      if (event.key === "Escape" && !madeUp(event, trustedEventsOnly) && ref.current?.querySelector(".menu") == null) {
        event.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, hidden, trustedEventsOnly]);
  return (
    <div className={`scrim${bare ? " lightbox" : ""}`} onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={ref}
        className={bare ? undefined : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onBlur={(event) => {
          // Focus lost to nothing, as when the focused button is removed or
          // disabled while saving, stays in the dialog, so its keys still work.
          if (event.relatedTarget !== null || hiddenNow.current) return;
          const card = event.currentTarget;
          setTimeout(() => {
            if (hiddenNow.current || !card.isConnected) return;
            const root = card.getRootNode();
            const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
            if (active === null || active === document.body || !card.contains(active)) card.focus({ preventScroll: true });
          });
        }}
      >
        {children}
      </div>
    </div>
  );
}

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback(
    (message: string, action?: Toast["action"], durationMs = 5000) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-2), { id, message, action }]);
      setTimeout(() => dismiss(id), durationMs);
    },
    [dismiss],
  );
  return { toasts, show, dismiss };
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                toast.action!.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Copies text, and says whether the browser let it: false when it refused.
 * Text still on its way, such as a link the backend makes, fails the copy
 * with its own error if it fails. Where the clipboard refuses, such as under
 * a page's `Permissions-Policy`, a hidden field copies it instead, inside
 * Critiqs's own `shadow` root when given, out of the page's sight.
 */
export async function copyText(text: string | Promise<string>, shadow: ShadowRoot | null = null): Promise<boolean> {
  if (typeof text !== "string") {
    // Safari copies only while the click is being handled, so the clipboard is handed the text as a promise there.
    if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function") {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      // The text's own failure is reported below, from `text`.
      blob.catch(() => undefined);
      try {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
        return true;
      } catch {
        // A browser that takes no promise: copy once the text is here, below.
      }
    }
    text = await text;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.style.position = "fixed";
    field.style.opacity = "0";
    (shadow ?? document.body).appendChild(field);
    field.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    field.remove();
    return copied;
  }
}

/**
 * Whether a Critiqs menu, dialog, or confirmation is open and shown; one in a
 * hidden panel, such as the list behind an open thread, doesn't count.
 */
export function openLayer(root: ShadowRoot | null): boolean {
  return [...(root?.querySelectorAll(".menu, [role='dialog'], [role='alertdialog']") ?? [])].some((layer) => layer.closest("[hidden]") === null);
}
