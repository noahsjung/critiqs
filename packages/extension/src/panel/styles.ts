// The side panel's own screens, on Critiqs's design system tokens (styles.ts).
// Each screen: a short heading, at most one line under it, one primary
// action, and quiet secondary actions.
export const PANEL_STYLES = `
.xt { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--surface);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); }
.xt-screen { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-6) var(--space-4); }
.xt-screen h1 { font-size: var(--text-l); font-weight: 600; margin: 0; line-height: 1.3; }
.xt-screen .xt-line { margin: calc(var(--space-2) * -1) 0 0; color: var(--muted); overflow-wrap: anywhere; }
.xt-screen form { display: flex; flex-direction: column; gap: var(--space-3); margin: 0; }
.xt-screen label { display: flex; flex-direction: column; gap: var(--space-1); font-weight: 500; }
.xt-screen .ds-actions { display: flex; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; }
.xt-quiet { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-left: calc(var(--space-2) * -1); }
.xt-quiet .btn.ghost { color: var(--muted); font-weight: 400; }
.xt-list { display: flex; flex-direction: column; }
.xt-list .ds-nav-row .value { overflow: hidden; text-overflow: ellipsis; }
.xt-site { font-weight: 500; color: var(--text); }
.xt-header { display: flex; align-items: center; gap: var(--space-2); min-height: 44px; padding: 0 var(--space-2) 0 var(--space-4);
  border-bottom: 1px solid var(--border); flex: none; }
.xt-header .xt-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xt-notice { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--border);
  color: var(--muted); font-size: var(--text-s); flex: none; }
.xt-notice span { flex: 1; }
/* Critiqs's panel, drawn inside this box instead of over the whole window. */
.xt-review { position: relative; flex: 1; min-height: 0; transform: translateZ(0); overflow: hidden; }
.xt-settings { position: absolute; inset: 0; z-index: 1; overflow: auto; background: var(--surface); }
.xt-settings .ds-dialog-header { padding: var(--space-3) var(--space-2); border-bottom: 1px solid var(--border); }
.xt-settings .ds-page { padding: var(--space-2) var(--space-4); }
.xt-who { color: var(--muted); font-size: var(--text-s); padding: var(--space-3) 0 0; overflow-wrap: anywhere; }
`;
