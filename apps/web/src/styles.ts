// The website app's own styles, after the design system's (critiqs-react's
// STYLES) in the same shadow root. Page-level sizes are tokens here, since
// the design system's are for dialogs on top of a prototype.

export const APP_STYLES = `
:host {
  display: block;
  --text-xl: 22px;
  --page-width: 520px;
}
.page { box-sizing: border-box; max-width: var(--page-width); margin: 0 auto; padding: var(--space-6) var(--space-4) 64px;
  display: flex; flex-direction: column; gap: var(--space-4);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--surface); }
.page p { margin: 0; }
.brand { font-weight: 700; font-size: var(--text-l); letter-spacing: -0.01em; margin-bottom: var(--space-4) !important; }
.ds-dialog-header h1, .page > h1 { flex: 1; min-width: 0; margin: 0; font-size: var(--text-xl); font-weight: 600; line-height: 1.25; }
.ds-dialog-header h1:focus { outline: none; }
.ds-dialog-header { align-items: flex-start; }
.ds-dialog-header .ds-steps { margin-top: 10px; }
.ds-dialog-header > .icon-btn:first-child { margin-top: 0; }
.lead { color: var(--muted); }
.field-label { font-size: var(--text-m); }
.stacked { display: flex; flex-direction: column; gap: var(--space-2); }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ds-actions { margin-top: var(--space-2); flex-wrap: wrap; }
.btn { min-height: var(--control-height); }
.link-btn { min-height: 28px; text-align: left; }

/* One question's options: rows to tap, not boxes. */
.options { display: flex; flex-direction: column; }
.option { display: flex; align-items: center; gap: var(--space-3); min-height: var(--row-height); padding: 0 var(--space-2);
  margin: 0 calc(-1 * var(--space-2)); border-radius: var(--radius-m); cursor: pointer; }
.option:hover { background: var(--hover); }
.option input { margin: 0; width: 16px; height: 16px; accent-color: var(--accent); flex: none; }

.quiet-choices { column-gap: var(--space-4); }
.check-status:empty { display: none; }
.check-result { display: flex; flex-direction: column; gap: 2px; }
.stack-found { column-gap: var(--space-3); }
.stack-picker .ds-select { min-width: 220px; }
/* A long menu, such as the frameworks, scrolls inside the window. */
.menu { max-height: calc(100vh - 16px); overflow-y: auto; }

.developers { gap: var(--space-2); }
.developers .ds-group-label { margin: 0; }
.developer-fields { display: flex; flex-direction: column; gap: var(--space-2); }
.developer-field { display: flex; flex-direction: column; gap: var(--space-1); }

/* The recommendation: one card for the recommended way, the others below it. */
.recommended { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-l); }
.badge { align-self: flex-start; font-size: var(--text-xs); font-weight: 600; color: var(--accent-strong); background: var(--accent-soft); border-radius: 999px; padding: 1px 8px; }
.reason { color: var(--text); }
.other-ways { display: flex; flex-direction: column; gap: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--border); }
.other-ways h2 { font-size: var(--text-s); }
.way { display: flex; flex-direction: column; gap: var(--space-3); }
.way-title { margin: 0; font-size: var(--text-l); font-weight: 600; }
.way-title.large { font-size: 17px; }
.commands { display: flex; flex-direction: column; gap: var(--space-2); }
/* The whole command stays visible on a phone, wrapping inside its project ID if it must. */
.code code { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.code .btn { font: 500 var(--text-s)/18px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; flex: none; }
.agent { column-gap: var(--space-3); row-gap: var(--space-1); }
/* Copying refused: the text to select, on its own line below the button. */
.commands .code { flex-wrap: wrap; }
.copy-fallback { flex-basis: 100%; display: flex; flex-direction: column; gap: var(--space-1); color: var(--text); }
.copy-fallback textarea { width: 100%; box-sizing: border-box; resize: vertical; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.deliveries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.deliveries li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; font-size: var(--text-m); overflow-wrap: anywhere; }
.deliveries li.success { color: var(--success); }
.deliveries li.error { color: var(--danger); }
.deliveries li.note { color: var(--muted); }
.delivery-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.invite-outcome { color: var(--muted); }
.request-failure { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); }
.limit-recovery { gap: var(--space-3); }
/* Same-named projects tell apart by their organization and address, or creation date, under the name. */
.project-list button { display: flex; flex-direction: column; gap: 2px; overflow-wrap: anywhere; }
.project-list .project-name { color: var(--text); }
.start-over { justify-content: flex-start; margin-top: var(--space-6); }

.facts { margin: 0; display: flex; flex-direction: column; }
.facts .ds-row { border-bottom: 1px solid var(--border); }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; text-align: right; overflow-wrap: anywhere; min-width: 0; }

@media (max-width: 480px) {
  /* Phones zoom into fields with smaller text. */
  input.field { font-size: 16px; }
  .ds-actions { justify-content: stretch; }
  .ds-actions .btn.primary { flex: 1; justify-content: center; }
}
`;
