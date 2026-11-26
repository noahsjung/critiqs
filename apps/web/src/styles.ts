// The website app's own styles, after the design system's (critiqs-react's
// STYLES, kept for the Select menu) in the same shadow root. The look is the
// landing page's (site/styles.css): Geist, an off-white page with a faint dot
// grid, near-black buttons, one blue, and the reviewers' cursor colours.

export const APP_STYLES = `
:host {
  --bg: #fbfbfa;
  --surface: #ffffff;
  --surface-2: #f3f3f1;
  --text: #111111;
  --muted: #5c5c5c;
  --faint: #707070;
  --line: #e6e6e2;
  --line-strong: #cfcfca;
  --border: var(--line);
  --hover: var(--surface-2);
  --accent: #0d63f3;
  --accent-soft: #e8f0fe;
  --success: #1a7f4b;
  --danger: #c62828;
  --priya: #e0457b;
  --daniel: #0f9d6b;
  --mei: #e8811a;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --font: "Geist", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  display: block;
}

.app {
  min-height: 100vh; display: flex; flex-direction: column;
  font: 15px/22px var(--font); color: var(--text); -webkit-font-smoothing: antialiased;
  background-color: var(--bg);
  background-image: radial-gradient(circle at 1px 1px, rgb(17 17 17 / 0.06) 1px, transparent 0);
  background-size: 24px 24px;
}
.app p, .app h1, .app figure { margin: 0; }
.app h1 { text-wrap: balance; }
.app p { text-wrap: pretty; }
.app button { font-family: var(--font); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.icon { width: 16px; height: 16px; flex: none; }

/* Top bar: the mark, and who's signed in. */
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 32px; }
.brand { display: inline-flex; align-items: center; gap: 8px; color: var(--text); text-decoration: none; font-weight: 600; font-size: 16px; }
.brand .logo { width: 24px; height: 24px; }
.account { display: flex; align-items: center; gap: 12px; min-width: 0; font-size: 14px; color: var(--muted); }
.account-email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.page { box-sizing: border-box; flex: 1; width: 100%; max-width: 1120px; margin: 0 auto; padding: 40px 32px 96px; display: flex; flex-direction: column; gap: 20px; }
.page.narrow { max-width: 600px; }

/* Onboarding: the form, and beside it the preview. */
.flow { display: grid; grid-template-columns: minmax(0, 440px) minmax(0, 1fr); gap: 80px; align-items: start; }
.flow-main { display: flex; flex-direction: column; gap: 24px; padding-top: 24px; }
.stacked { display: flex; flex-direction: column; gap: 12px; }
.panels, .panel { display: flex; flex-direction: column; gap: 24px; }
.panel[hidden] { display: none; }

.progress { display: flex; gap: 6px; }
.progress span { width: 28px; height: 4px; border-radius: 2px; background: var(--line); transition: background-color 400ms var(--ease); }
.progress span.done { background: var(--text); }

.heading { display: flex; flex-direction: column; gap: 8px; }
.heading h1 { font-size: 32px; line-height: 40px; font-weight: 600; letter-spacing: -0.025em; }
.heading h1:focus { outline: none; }
.lead { font-size: 16px; line-height: 24px; color: var(--muted); }
.note { font-size: 14px; line-height: 20px; color: var(--muted); }
.error { font-size: 14px; line-height: 20px; color: var(--danger); }
.caution { padding: 12px 16px; border-radius: 12px; background: #fff7e0; color: #7a5300; font-size: 14px; line-height: 20px; }
.then { color: var(--text); }
/* Typed links and addresses can be one long word: they wrap instead of widening the page. */
.app p, .app li, .facts dd { overflow-wrap: anywhere; }

/* Fields */
.field { box-sizing: border-box; width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface);
  font: 15px/22px var(--font); color: var(--text); transition: border-color 200ms var(--ease), box-shadow 200ms var(--ease); }
.field.large { height: 52px; padding: 0 16px; border-radius: 12px; font-size: 17px; }
.field::placeholder { color: #9a9a96; }
.field:hover { border-color: var(--line-strong); }
.field:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.field[aria-invalid="true"] { border-color: var(--danger); }
.field-row { display: flex; align-items: center; gap: 8px; }

/* Buttons: black for the one action, white for others, and quiet text for the rest. */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box; height: 40px; padding: 0 16px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text);
  font: 600 14px/20px var(--font); text-decoration: none; cursor: pointer; white-space: nowrap;
  transition: background-color 300ms var(--ease), border-color 300ms var(--ease), transform 500ms var(--ease); }
.btn:hover { border-color: var(--line-strong); background: var(--surface-2); }
.btn:active { transform: scale(0.98); }
.btn:disabled { opacity: 0.45; cursor: default; transform: none; }
.btn.primary { border-color: var(--text); background: var(--text); color: #fff; }
.btn.primary:hover { border-color: #2b2b2b; background: #2b2b2b; }
.btn.large { height: 48px; padding: 0 22px; border-radius: 10px; font-size: 15px; }
.btn.small { height: 32px; padding: 0 12px; font-size: 13px; }
.quiet { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0; border: 0; background: none; color: var(--muted);
  font: 500 14px/20px var(--font); cursor: pointer; text-align: left;
  text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; transition: color 200ms var(--ease), text-decoration-color 200ms var(--ease); }
.quiet:hover { color: var(--text); text-decoration-color: currentColor; }
.quiet:disabled { opacity: 0.5; cursor: default; }
.quiet.back { align-self: flex-start; margin: -12px 0 -12px -2px; }
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 24px; margin-top: 4px; }

/* Who will add Critiqs: the recommended way first, each a single tap. */
.choices { display: flex; flex-direction: column; gap: 12px; }
.choice { display: flex; align-items: center; gap: 16px; width: 100%; padding: 18px 20px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface);
  color: var(--text); text-align: left; cursor: pointer; transition: border-color 300ms var(--ease), background-color 300ms var(--ease), transform 500ms var(--ease); }
.choice:hover { border-color: var(--line-strong); }
.choice:active { transform: scale(0.99); }
.choice:disabled { cursor: default; transform: none; }
.choice:disabled:not([aria-busy="true"]) { opacity: 0.5; }
.choice[aria-busy="true"] { border-color: var(--text); }
.choice-icon { display: grid; place-items: center; flex: none; width: 44px; height: 44px; border-radius: 12px; background: var(--surface-2); }
.choice-icon svg { width: 22px; height: 22px; }
.choice-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.choice-label { font-size: 17px; line-height: 24px; font-weight: 600; }
.choice-detail { font-size: 14px; line-height: 20px; color: var(--muted); }
.choice.recommended { border-color: var(--line-strong); }
.choice-label .badge { display: inline-block; margin-left: 8px; padding: 0 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent);
  font-size: 12px; line-height: 20px; font-weight: 500; vertical-align: 2px; }
.other-ways { display: flex; flex-direction: column; align-items: flex-start; gap: 0; }
/* The extension's steps, numbered. */
.steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 12px; }
.steps li { padding-left: 4px; }
.steps a { color: var(--accent); }
.spinner { width: 18px; height: 18px; flex: none; border: 2px solid var(--line); border-top-color: var(--text); border-radius: 50%; animation: spin 800ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.organization { display: flex; align-items: center; gap: 12px; }
.limit-recovery { gap: 12px; }
.project-list { display: flex; flex-direction: column; gap: 8px; }
.project-list button { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px;
  background: var(--surface); cursor: pointer; text-align: left; overflow-wrap: anywhere; font: inherit; }
.project-list button:hover { border-color: var(--line-strong); }
.project-name { font-weight: 600; }

/* The one command, each part on its own line, and a pasted property. */
.command { margin: 0; padding: 16px 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); white-space: pre-wrap; overflow-wrap: anywhere; }
.command code { font: 14px/24px var(--mono); }
.btn .i-check, .btn.copied .i-copy { display: none; }
.btn.copied .i-check { display: block; }
.property { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 8px 8px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.property code { flex: 1 1 200px; min-width: 0; font: 13px/20px var(--mono); overflow-wrap: anywhere; }
.copy-fallback { flex-basis: 100%; display: flex; flex-direction: column; gap: 4px; }
.copy-fallback textarea { width: 100%; box-sizing: border-box; height: auto; padding: 8px 12px; resize: vertical; font: 12px/1.5 var(--mono); }

/* Developer emails */
.developers { display: flex; flex-direction: column; gap: 4px; }
.developer-field { display: flex; flex-direction: column; gap: 4px; }
.quiet.add { margin-top: 4px; }
.deliveries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.deliveries li { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; overflow-wrap: anywhere; }
.deliveries li.success { color: var(--success); }
.deliveries li.error { color: var(--danger); }
.deliveries li.note { color: var(--muted); }
.delivery-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.delivery-main { display: inline-flex; align-items: center; gap: 8px; font-weight: 500; }
.request-failure { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }

/* While you're here: one question at a time, after the setup. */
.about { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; padding: 20px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface);
  animation: arrive 400ms var(--ease) both; }
.about-heading { font-size: 13px; line-height: 18px; color: var(--muted); font-weight: 500; }
.about-title { font-size: 16px; line-height: 24px; font-weight: 600; margin-top: -8px !important; }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.chips .chip { height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--text);
  font: 500 14px/20px var(--font); cursor: pointer; transition: border-color 200ms var(--ease), background-color 200ms var(--ease); }
.chips .chip:hover { border-color: var(--line-strong); background: var(--surface-2); }
.chips .quiet { margin-left: 4px; }
.about-done { margin-top: 8px; animation: arrive 400ms var(--ease) both; }
@keyframes arrive { from { opacity: 0; transform: translateY(6px); } }

/* The developer's setup page */
.facts { margin: 0; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
.fact { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; text-align: right; overflow-wrap: anywhere; min-width: 0; }

/* The preview: the person's own link in a browser window, sketched. */
.preview { position: sticky; top: 32px; }
.window { border: 1px solid var(--line); border-radius: 16px; background: var(--surface); overflow: hidden; box-shadow: 0 32px 64px -32px rgb(17 17 17 / 0.22), 0 2px 6px -2px rgb(17 17 17 / 0.06); }
.window-bar { display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 14px; border-bottom: 1px solid var(--line); background: #fafaf9; }
.lights { display: flex; gap: 6px; flex: none; }
.lights i { width: 10px; height: 10px; border-radius: 50%; background: #e2e2de; }
.url { display: flex; align-items: center; justify-content: center; gap: 6px; flex: 1; min-width: 0; max-width: 340px; height: 28px; margin: 0 auto; padding: 0 12px;
  border-radius: 8px; background: var(--surface-2); font-size: 13px; line-height: 18px; color: var(--text); transform: translateX(-24px); }
.url svg { width: 11px; height: 11px; flex: none; color: var(--faint); }
.url.url-none { color: var(--faint); }
.url-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.page-sketch { position: relative; height: 460px; padding: 22px 28px; box-sizing: border-box; overflow: hidden; }
.page-sketch i { display: block; }
.sk-nav { display: flex; align-items: center; gap: 18px; }
.sk-nav i { width: 44px; height: 8px; border-radius: 4px; background: #ececea; }
.sk-nav .sk-logo { width: 24px; height: 24px; border-radius: 7px; background: #e4e4e0; margin-right: auto; }
.sk-hero { display: flex; flex-direction: column; gap: 12px; margin-top: 52px; }
.sk-title { width: 72%; height: 24px; border-radius: 6px; background: #e4e4e0; }
.sk-line { width: 88%; height: 10px; border-radius: 5px; background: #efefec; }
.sk-line.short { width: 58%; }
.sk-button { width: 120px; height: 34px; margin-top: 8px; border-radius: 8px; background: #dcdcd8; }
.sk-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 44px; }
.sk-cards i { height: 104px; border: 1px solid #eeeeea; border-radius: 10px; background: #f6f6f4; }

/* Once Critiqs is set up: the toolbar, the team's cursors, and their comments arrive, once. */
.cur, .pv-pin, .pv-toolbar { position: absolute; opacity: 0; pointer-events: none; }
.cur { display: flex; align-items: flex-start; --c: var(--priya); --l: #c2305f; }
.cur.daniel { --c: var(--daniel); --l: #0b7a53; }
.cur.mei { --c: var(--mei); --l: #b45f06; }
.cur svg { width: 18px; height: 18px; fill: var(--c); stroke: #fff; stroke-width: 1.2; filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.35)); }
.cur b { margin: 14px 0 0 -4px; padding: 1px 6px; border-radius: 4px; background: var(--l); color: #fff; font-size: 11px; line-height: 16px; font-weight: 600; white-space: nowrap; }
.cur.priya { top: 104px; left: 64%; }
.cur.daniel { top: 352px; left: 40%; }
.cur.mei { top: 232px; left: 82%; }
.pv-pin { display: flex; align-items: center; gap: 8px; }
.pin-dot { display: grid; place-items: center; width: 26px; height: 26px; border: 2px solid #fff; border-radius: 50% 50% 50% 4px; color: #fff; font-size: 11px; font-weight: 600;
  box-shadow: 0 4px 10px -2px rgb(0 0 0 / 0.25); }
.pin-dot.priya { background: #c2305f; } .pin-dot.daniel { background: #0b7a53; } .pin-dot.mei { background: #b45f06; }
.pin-text { padding: 6px 10px; border-radius: 10px; background: var(--surface); box-shadow: 0 8px 20px -8px rgb(0 0 0 / 0.3), 0 0 0 1px rgb(17 17 17 / 0.05); font-size: 12px; line-height: 16px; white-space: nowrap; }
.pv-pin.pin-1 { top: 74px; left: 70%; }
.pv-pin.pin-2 { top: 300px; left: 12%; }
.pv-pin.pin-3 { top: 196px; left: 50%; }
.pv-toolbar { left: 50%; bottom: 18px; display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 12px; border-radius: 999px; background: #111; transform: translateX(-50%);
  box-shadow: 0 10px 24px -10px rgb(0 0 0 / 0.5); }
.pv-toolbar .logo { width: 18px; height: 18px; }
.pv-toolbar i { width: 14px; height: 14px; border-radius: 4px; background: #4a4a4a; }
.live .pv-toolbar { animation: rise 500ms var(--ease) 100ms both; }
.live .cur, .live .pv-pin { animation: arrive 500ms var(--ease) both; }
.live .cur.priya { animation-delay: 500ms; } .live .pv-pin.pin-1 { animation-delay: 800ms; }
.live .cur.mei { animation-delay: 1000ms; } .live .pv-pin.pin-3 { animation-delay: 1300ms; }
.live .cur.daniel { animation-delay: 1500ms; } .live .pv-pin.pin-2 { animation-delay: 1800ms; }
@keyframes rise { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translateX(-50%); } }
.live .cur, .live .pv-pin { opacity: 1; }
.live .pv-toolbar { opacity: 1; }

/* A thread page: one comment's capture, discussion, and reply box. */
.page.thread { max-width: 720px; }
.reasons { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; color: var(--muted); font-size: 15px; line-height: 22px; }
.thread-page { display: flex; flex-direction: column; gap: 24px; }
.thread-head { display: flex; flex-direction: column; gap: 12px; }
.thread-head .heading h1 { font-size: 28px; line-height: 36px; }
.thread-head .lead { font-size: 15px; line-height: 22px; overflow-wrap: anywhere; }
.thread-head .lead code { font: 14px/20px var(--mono); color: var(--text); }
.thread-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.thread-actions .copy-fallback { flex-basis: 100%; }
.resolved { padding: 10px 14px; border-radius: 10px; background: #ecfdf3; color: var(--success); font-size: 14px; line-height: 20px; }
.thread-capture { position: relative; display: grid; place-items: center; width: 100%; max-height: 480px; margin: 0; overflow: hidden;
  border: 1px solid var(--line); border-radius: 12px; background: var(--surface-2); }
.thread-capture img { display: block; width: 100%; height: auto; max-height: 480px; object-fit: contain; background: var(--surface); }
.thread-capture figcaption { position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 12px; background: rgb(255 255 255 / 0.92); }
.capture-failed { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px; text-align: center; }
.capture-none { padding: 12px 14px; border: 1px dashed var(--line-strong); border-radius: 12px; }
.thread-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: -8px 0 0; padding: 0; list-style: none; }
.thread-tags .tag-chip { font-size: 13px; line-height: 20px; padding: 1px 9px; }
.discussion { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); overflow: hidden; }
.thread-messages { list-style: none; margin: 0; padding: 8px 0; }
.thread-page .message { padding: 12px 20px; gap: 12px; font-size: 15px; line-height: 22px; }
.thread-page .message .avatar.large { width: 32px; height: 32px; font-size: 12px; }
.thread-page .message .meta { padding-right: 0; line-height: 22px; column-gap: 8px; }
.thread-page .message .time, .thread-page .message .edited, .thread-page .message .via { font-size: 13px; }
.thread-page .message .body { margin-top: 2px; }
.thread-page .grow { flex: 1; min-width: 0; }
.reply { display: flex; flex-direction: column; gap: 10px; padding: 16px 20px 20px; border-top: 1px solid var(--line); }
.reply textarea.field { height: auto; min-height: 88px; padding: 10px 12px; resize: vertical; line-height: 22px; }
.reply-actions { display: flex; justify-content: flex-end; }

@media (prefers-reduced-motion: reduce) {
  .live .cur, .live .pv-pin, .live .pv-toolbar, .about, .about-done { animation: none; }
  .spinner { animation: none; border-top-color: var(--line); }
}

@media (max-width: 960px) {
  .flow { grid-template-columns: minmax(0, 1fr); }
  .flow-main { max-width: 520px; }
  .preview { display: none; }
}
@media (max-width: 520px) {
  .topbar { padding: 16px; }
  .page { padding: 16px 16px 64px; }
  .flow-main { padding-top: 8px; gap: 20px; }
  .heading h1 { font-size: 26px; line-height: 32px; }
  .actions .btn.large { width: 100%; }
  .thread-head .heading h1 { font-size: 24px; line-height: 30px; }
  .thread-actions .btn { flex: 1 1 0; }
  .thread-page .message { padding: 12px 16px; }
  .reply { padding: 12px 16px 16px; }
  .reply-actions .btn { width: 100%; height: 44px; }
  .account-email { display: none; }
  /* Phones zoom into fields with smaller text. */
  .field { font-size: 16px; }
  .field.large { font-size: 17px; }
}
`;
