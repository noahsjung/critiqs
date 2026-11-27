// Critiqs's styles live inside its shadow root, isolated from the host app's.
export const STYLES = `
:host {
  all: initial;
  --accent: #0d63f3;
  --accent-soft: #e8f0fe;
  --accent-strong: #0b4fc2;
  /* One look for a tag wherever it appears: typed, posted, or listed. */
  --tag-bg: #edf3fe;
  --tag-border: #c3d5f8;
  --tag-text: var(--accent-strong);
  --tag-hover-bg: #dde8fc;
  --text: #1a1a1a;
  --muted: #6b7280;
  --faint: #9ca3af;
  --border: #e5e7eb;
  --hover: #f3f4f6;
  --surface: #ffffff;
  --danger: #c62828;
  --success: #15803d;
  --warning-bg: #fff7e0;
  --warning-text: #7a5300;
  --shadow: 0 8px 24px rgb(0 0 0 / 0.14), 0 1px 3px rgb(0 0 0 / 0.1);
  /* Design system scales (docs/design-system.md). */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --radius-s: 6px;
  --radius-m: 8px;
  --radius-l: 12px;
  --text-xs: 11px;
  --text-s: 12px;
  --text-m: 13px;
  --text-l: 15px;
  --control-height: 32px;
  --row-height: 40px;
  --caution: #d97706;
  --switch-off: #d1d5db;
}
/* The host element is reset inline (see Critiqs.tsx), so the base font is set here. */
.layer { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text);
  text-align: left; letter-spacing: normal; text-transform: none; }
*, *::before, *::after { box-sizing: border-box; }
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; }
.layer > * { pointer-events: auto; }
.layer > .passive { pointer-events: none; }
/* What the page layer draws (pins, outlines, Comment mode's selection) stays under the panel's toolbar, sidebar, and windows. */
.layer.page-layer { z-index: 2147482999; }

/* Buttons */
.btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--surface);
  border-radius: 6px; padding: 5px 10px; font-weight: 500; line-height: 18px; white-space: nowrap; }
.btn:hover { background: var(--hover); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.primary:hover { filter: brightness(1.08); }
.btn.danger { color: var(--danger); }
.btn.danger.solid { background: var(--danger); border-color: var(--danger); color: #fff; }
.btn.ghost { border-color: transparent; background: transparent; }
.btn.ghost:hover { background: var(--hover); }
.btn.small { padding: 2px 8px; font-size: 12px; }
a.btn { color: var(--text); text-decoration: none; }
a.link-btn { text-decoration: none; }
a.link-btn:hover { text-decoration: underline; }
.icon-btn { display: inline-grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 6px;
  background: transparent; color: var(--muted); padding: 0; }
.icon-btn:hover { background: var(--hover); color: var(--text); }
.icon-btn[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
.link-btn { border: 0; background: none; padding: 0; color: var(--accent); font-weight: 500; }
.link-btn:hover { text-decoration: underline; }

/* Toolbar */
.toolbar { position: fixed; display: flex; align-items: center; gap: 2px; padding: 4px; background: #1f2023; color: #f3f4f6;
  border-radius: 12px; box-shadow: var(--shadow); user-select: none; transition: top 0.2s, bottom 0.2s; }
.toolbar .icon-btn { color: #c7c9cf; width: 32px; height: 32px; border-radius: 8px; position: relative; }
.toolbar .icon-btn:hover { background: #34363b; color: #fff; }
.toolbar .icon-btn[aria-pressed="true"] { background: #fff; color: #1f2023; }
.toolbar .divider { width: 1px; align-self: stretch; margin: 4px 3px; background: #3a3c42; }
.toolbar .handle { width: 14px; height: 32px; display: grid; place-items: center; cursor: grab; color: #6b6e76; }
.toolbar .handle:active { cursor: grabbing; }
.toolbar .badge { position: absolute; top: 3px; right: 3px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px;
  background: var(--accent); color: #fff; font-size: 10px; font-weight: 700; line-height: 15px; text-align: center; }
.toolbar .setup-btn { border: 0; background: var(--accent); color: #fff; border-radius: 8px; height: 32px; padding: 0 12px; font-weight: 600; }
.toolbar .who { display: inline-grid; place-items: center; width: 32px; height: 32px; border: 0; background: transparent; border-radius: 8px; padding: 0; }
.toolbar .who:hover { background: #34363b; }
.toolbar .sign-in { border: 0; background: transparent; color: #f3f4f6; height: 32px; padding: 0 10px; border-radius: 8px; font-weight: 500; }
.toolbar .sign-in:hover { background: #34363b; }
.toolbar .hint { padding: 0 8px; color: #c7c9cf; font-size: 12px; }
.toolbar.collapsed { padding: 4px; border-radius: 22px; }

.menu { position: fixed; min-width: 220px; background: var(--surface); color: var(--text); border: 1px solid var(--border);
  border-radius: 10px; box-shadow: var(--shadow); padding: 6px; z-index: 2; }
.menu .menu-label { padding: 6px 8px 4px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.menu .menu-item { display: flex; width: 100%; align-items: center; gap: 8px; border: 0; background: none; text-align: left;
  padding: 6px 8px; border-radius: 6px; }
.menu .menu-item:hover { background: var(--hover); }
.menu .menu-item .check { width: 14px; color: var(--accent); }
.menu .menu-item .detail { margin-left: auto; padding-left: var(--space-4); color: var(--muted); font-size: var(--text-s); white-space: nowrap; }
.menu .menu-item.danger { color: var(--danger); }
.menu hr { border: 0; border-top: 1px solid var(--border); margin: 6px 0; }
.menu .identity { padding: 6px 8px; }
.menu .identity .name { font-weight: 600; }
.menu .identity .email { color: var(--muted); font-size: 12px; }

/* Avatars */
.avatar { display: inline-grid; place-items: center; flex: none; width: 24px; height: 24px; border-radius: 50%;
  color: #fff; font-size: 11px; font-weight: 700; overflow: hidden; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.avatar.large { width: 28px; height: 28px; font-size: 12px; }

/* Picking a target in Comment mode */
.target-box { position: fixed; border: 2px solid var(--accent); border-radius: 4px; background: rgb(13 99 243 / 0.06);
  pointer-events: none; transition: all 60ms ease-out; }
.target-label { position: fixed; transform: translateY(-100%); background: var(--accent); color: #fff; font-size: 11px;
  font-weight: 600; padding: 1px 6px; border-radius: 4px 4px 0 0; pointer-events: none; white-space: nowrap; max-width: 320px;
  overflow: hidden; text-overflow: ellipsis; }
.highlight { position: fixed; border: 2px solid var(--accent); border-radius: 6px; pointer-events: none;
  box-shadow: 0 0 0 4px rgb(13 99 243 / 0.2); animation: critiqs-pulse 1.2s ease-out 2; }
@keyframes critiqs-pulse { 0% { box-shadow: 0 0 0 0 rgb(13 99 243 / 0.45); } 100% { box-shadow: 0 0 0 12px rgb(13 99 243 / 0); } }
.mode-hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #1f2023; color: #fff; padding: 6px 12px;
  border-radius: 8px; font-size: 12px; box-shadow: var(--shadow); pointer-events: none; text-align: center; }

/* Pins */
.pin { position: fixed; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50% 50% 50% 4px; border: 2px solid #fff;
  background: #1f2023; color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 700; padding: 0;
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.3); transform-origin: bottom left; transition: transform 0.1s; }
.pin:hover { transform: scale(1.12); }
.pin.unread { background: var(--accent); }
.pin.resolved { background: #8b8f97; }
.pin.selected { outline: 3px solid rgb(13 99 243 / 0.35); transform: scale(1.12); }

/* Popover composer */
.popover { position: fixed; width: 320px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--shadow); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.popover .context-line { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
textarea.field, input.field, .tag-field.field { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--surface);
  resize: vertical; min-height: 36px; }
textarea.field, .tag-field.field { min-height: 64px; }
textarea.field:focus, input.field:focus, .tag-field.field:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.row { display: flex; align-items: center; gap: 8px; }
.row.end { justify-content: flex-end; }
.row.between { justify-content: space-between; }
.wrap { flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }
.chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px;
  font-size: 12px; background: var(--surface); color: var(--muted); }
button.chip:hover { background: var(--hover); }
.chip[aria-pressed="true"] { background: var(--accent-soft); border-color: #b9d0fb; color: var(--accent); }
.segmented { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; padding: 2px; gap: 2px; }
.segmented button { border: 0; background: none; border-radius: 6px; padding: 3px 8px; font-size: 12px; color: var(--muted); }
.segmented button[aria-pressed="true"] { background: var(--hover); color: var(--text); font-weight: 600; }
.note { font-size: 12px; color: var(--muted); }
.warning { background: var(--warning-bg); color: var(--warning-text); border-radius: 8px; padding: 8px 10px; font-size: 12px; }
.error { color: var(--danger); font-size: 12px; }
.caution { color: var(--warning-text); font-size: 12px; }
kbd { font: 11px ui-monospace, monospace; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; color: var(--muted); }

/* Sidebar */
.sidebar { position: fixed; top: 0; right: 0; bottom: 0; width: 360px; max-width: 100vw; background: var(--surface);
  border-left: 1px solid var(--border); box-shadow: -8px 0 24px rgb(0 0 0 / 0.08); display: flex; flex-direction: column; }
.sidebar[hidden] { display: none; }
/* A review link's page on a narrow screen: the sidebar is a sheet over the frame's lower part. */
.sidebar.sheet { top: auto; left: 0; width: auto; max-width: none; height: min(70vh, 600px); border-left: 0; border-top: 1px solid var(--border);
  border-radius: 14px 14px 0 0; box-shadow: 0 -12px 32px rgb(0 0 0 / 0.18); }
/* The sidebar's left edge, dragged to resize it (sidebar-width.tsx). */
.sidebar-resize { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; z-index: 2; cursor: col-resize; touch-action: none; }
.sidebar-resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: transparent; transition: background 0.15s; }
.sidebar-resize:hover::after, .sidebar-resize.dragging::after, .sidebar-resize:focus-visible::after { background: var(--accent); }
.sidebar-resize:focus-visible { outline: none; }
@media (prefers-reduced-motion: reduce) { .sidebar-resize::after { transition: none; } }
.sidebar-header { display: flex; align-items: center; gap: 4px; padding: 10px 10px 10px 16px; border-bottom: 1px solid var(--border); min-height: 49px; }
.sidebar-header h2 { font-size: 14px; font-weight: 600; margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-panel .people { list-style: none; margin: 6px 0 2px; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.docs { padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 8px; }
.docs .field { width: 100%; box-sizing: border-box; }
.doc-topic { border: 1px solid var(--border); border-radius: 8px; padding: 0 12px; }
.doc-topic summary { cursor: pointer; font-weight: 600; padding: 10px 0; }
.doc-topic p { margin: 0 0 6px; color: var(--muted); }
.doc-topic ul { margin: 0 0 12px; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.code.light { background: var(--hover); color: var(--text); border: 1px solid var(--border); }
.code.light .btn { background: var(--surface); border-color: var(--border); color: var(--text); }
.project-panel .people li { display: flex; align-items: center; gap: 8px; min-width: 0; }
.project-panel .people li > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-body { flex: 1; overflow-y: auto; }
.sidebar-footer { border-top: 1px solid var(--border); padding: 10px 12px; }
.filter-summary { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 16px; border-bottom: 1px solid var(--border);
  font-size: 12px; color: var(--muted); }
.group-title { padding: 12px 16px 4px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.entry { display: flex; gap: 10px; width: 100%; padding: 10px 16px; border: 0; border-bottom: 1px solid var(--border); background: none;
  text-align: left; position: relative; }
.entry:hover { background: #fafafa; }
.entry.selected { background: var(--accent-soft); }
.entry .meta { display: flex; align-items: baseline; gap: 6px; }
.entry .author { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry .time { color: var(--faint); font-size: 12px; white-space: nowrap; }
.entry .excerpt { margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.entry .details { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; font-size: 12px; color: var(--muted); }
.entry .status-tag { color: var(--warning-text); }
.entry .resolved-tag { color: var(--success); }
.unread-dot { position: absolute; top: 16px; right: 12px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.entry.unread .author { color: var(--text); }
.entry input[type="checkbox"] { margin: 4px 0 0; flex: none; accent-color: var(--accent); }
.empty { padding: 40px 24px; text-align: center; color: var(--muted); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.empty strong { color: var(--text); font-size: 14px; }

/* Thread window: beside its pin, or beside the sidebar when the target can't be shown */
.thread-window { position: fixed; width: 340px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--shadow); display: flex; flex-direction: column; overflow: hidden; z-index: 1; }
.thread-window:focus { outline: none; }
.thread-window.panel { width: auto; border-radius: 12px 12px 0 0; border-bottom: 0; }
.window-header { display: flex; align-items: center; gap: 4px; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--border); min-height: 45px; flex: none; }
.window-header h2 { font-size: 14px; font-weight: 600; margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.window-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.window-footer { flex: none; border-top: 1px solid var(--border); padding: 10px 12px; }
.window-footer .tag-field.field { min-height: 48px; max-height: 160px; }
.saved-context { margin: 10px 14px 0; }
.saved-context summary { cursor: pointer; font-size: 12px; color: var(--muted); padding: 2px 0; }
.saved-context .thread-context { margin: 6px 0 0; }
.thread-window .thread-context .capture { max-height: 140px; }
.context-details summary { cursor: pointer; padding: 8px 12px; font-size: 12px; color: var(--muted); }
.context-details[open] summary { padding-bottom: 0; }

/* Mentions */
.mention-input { position: relative; }
.tag-editor { position: relative; }
/* An editable box holding plain text; a little more line height leaves room between wrapped pills. */
.tag-field { display: block; overflow-x: hidden; overflow-y: auto; max-height: 240px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere;
  cursor: text; }
.tag-placeholder { position: absolute; top: 9px; left: 11px; right: 11px; line-height: 20px; color: var(--faint);
  pointer-events: none; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* Draft hashtags: pills with real side padding, in the same tag colors as posted tags and sidebar chips;
   mentions stay plain bold text. The weight matches the surrounding text so a word never reflows as it
   becomes a tag. A tag too long for its line breaks open-ended rather than padding past the box's edge. */
.tag-pill { padding: 1px 6px; margin: 0 1px; border-radius: 999px; background: var(--tag-bg); color: var(--tag-text);
  box-shadow: inset 0 0 0 1px var(--tag-border); }
.mention-suggestions { position: fixed; z-index: 3; list-style: none; margin: 0; padding: 4px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); max-height: 220px; overflow-y: auto; }
.mention-suggestions li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.mention-suggestions li[aria-selected="true"] { background: var(--accent-soft); }
.mention { color: var(--accent); font-weight: 600; }
/* Tags in lists and posted text: the same pill and colors as while typing. */
.tag-chip { display: inline-block; border: 0; border-radius: 999px; padding: 1px 7px; font-size: 12px; font-weight: 500;
  line-height: 18px; background: var(--tag-bg); color: var(--tag-text); box-shadow: inset 0 0 0 1px var(--tag-border);
  white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.tag-chip.clickable { cursor: pointer; }
.tag-chip.clickable:hover, button.hashtag:hover { background: var(--tag-hover-bg); }
.hashtag { display: inline; border: 0; border-radius: 999px; padding: 1px 6px; margin: 0 1px; font: inherit; font-weight: 500;
  background: var(--tag-bg); color: var(--tag-text); box-shadow: inset 0 0 0 1px var(--tag-border); }
button.hashtag { cursor: pointer; }
@media (forced-colors: active) { .tag-pill, .tag-chip, .hashtag { border: 1px solid CanvasText; } }
.tag-limit { margin-top: 6px; }
/* Two placement choices, each with its help button on its right. Labels never wrap; where the
   fonts are too wide for one row, the second choice takes its own. The chosen one is filled in the
   accent with a ring drawn inside it, so choosing changes neither size nor weight. Keyboard focus
   rings the whole choice, just outside that edge. */
.scope-choice { display: flex; flex-wrap: wrap; border: 1px solid var(--border); border-radius: 8px; padding: 2px; gap: 2px; }
.scope-option { flex: 1 1 auto; display: flex; align-items: center; border-radius: 6px; }
.scope-option.selected { background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.scope-option > button { flex: 1; border: 0; background: none; border-radius: 6px; padding: 3px 2px 3px 8px;
  font-size: 12px; font-weight: 500; color: var(--muted); text-align: left; white-space: nowrap; }
.scope-option.selected > button { color: var(--accent-strong); }
.scope-option.selected .scope-info .icon-btn { color: var(--accent-strong); }
.scope-option.selected .scope-info .icon-btn:hover { background: rgb(13 99 243 / 0.12); }
@supports selector(:has(*)) {
  .scope-option > button:focus-visible { outline: none; }
  .scope-option:has(> button:focus-visible) { outline: 2px solid var(--accent); outline-offset: 0; }
}
@media (forced-colors: active) { .scope-option.selected { outline: 2px solid Highlight; outline-offset: -2px; } }
.scope-info { display: inline-flex; flex: none; }
.scope-info .icon-btn { width: 24px; height: 24px; }
.scope-help { position: fixed; z-index: 4; width: 280px; max-width: calc(100vw - 48px); overflow-y: auto;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
  box-shadow: var(--shadow); font-size: 12px; color: var(--text); }
.scope-help p { margin: 0; }
.scope-help p + p { margin-top: 8px; }
/* Search */
.search-box { display: flex; align-items: center; gap: 6px; padding: 8px 12px 8px 16px; border-bottom: 1px solid var(--border); color: var(--muted); }
.search-box input.field { padding: 5px 8px; min-height: 30px; }
.search-box input::-webkit-search-cancel-button { display: none; }
.search-results .search-summary { display: flex; align-items: center; gap: 8px; padding: 10px 16px 0; font-size: 12px; color: var(--muted); }
.badge { border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
.badge.ai { background: var(--accent-soft); color: var(--accent); }
.badge.basic { background: var(--hover); color: var(--text); }
.search-notice { margin: 8px 16px 0; padding: 6px 10px; border-radius: 8px; background: var(--warning-bg); color: var(--warning-text); font-size: 12px; }
.search-filters { padding: 6px 16px 0; overflow-wrap: anywhere; }
.search-insight-note { padding: 4px 16px 0; }
.insights { padding-bottom: 4px; }
.insight { margin: 4px 16px 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; gap: 4px; }
.insight p { margin: 0; color: #444; }
.insight .sources { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.insight .source { border: 0; background: none; padding: 2px 0; text-align: left; color: var(--accent); font-size: 12px; }
.insight .source:hover { text-decoration: underline; }
.entry .match { margin-top: 2px; font-size: 12px; color: var(--muted); font-style: italic; overflow-wrap: anywhere; }
/* Tags and AI settings */
.dialog-scroll { max-height: min(60vh, 560px); overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
.group-list, .tag-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.group-list li { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.tag-list li { gap: 8px; }
.stacked { display: flex; flex-direction: column; gap: 4px; }
.choices { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.choices input, .settings input[type="radio"] { accent-color: var(--accent); }
/* A choice with a line explaining it, such as who pays for AI. */
.choices .row.top { align-items: flex-start; }
.choices .row.top input { margin-top: 3px; }
.choices .row.top .stacked { gap: 1px; }
.success { color: var(--success); font-size: 12px; margin: 0; }
.dialog .error, .dialog .warning, .dialog .note { margin: 0; }
/* Dialog paragraphs are dark gray; notices keep their own color. */
.dialog .error { color: var(--danger); }
.dialog .note { color: var(--muted); }
.dialog .warning { color: var(--warning-text); }
.menu-scroll { max-height: 240px; overflow-y: auto; }
.shortcuts dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 0; padding: 2px 8px 6px; font-size: 12px; }
.shortcuts dd { margin: 0; color: var(--muted); }
.review-address { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; }
.review-address .note { overflow-wrap: anywhere; }
.setup-form { display: flex; flex-direction: column; gap: 10px; }
.review-address-page { overflow-wrap: anywhere; }
.setup-section { display: flex; flex-direction: column; gap: var(--space-1); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.setup-section .row.between { flex-wrap: wrap; column-gap: var(--space-3); }
.setup-section .note { overflow-wrap: anywhere; }
.address-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.address-rows li { min-height: 32px; border-bottom: 1px solid var(--border); }
.address-rows code { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
.address-rows li.inert code { color: var(--muted); text-decoration: line-through; }
.address-rows .address-note { flex-basis: 100%; padding-bottom: 6px; color: var(--warning-text); }
.setup-details { display: flex; flex-direction: column; gap: var(--space-2); }
.step.done .row.between { column-gap: var(--space-3); }
.plan-usage-rows { display: flex; flex-direction: column; }
.plan-usage-rows .note { margin: var(--space-1) 0 0; }
.usage-meter { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-1) 0; font-size: var(--text-s); }
.usage-meter .row { flex-wrap: wrap; column-gap: var(--space-3); row-gap: 0; }
.usage-unlimited { font-size: var(--text-s); flex-wrap: wrap; column-gap: var(--space-3); padding: var(--space-1) 0; }
.settings { display: flex; flex-direction: column; gap: 8px; }
/* A provider's models to tick, with the picked ones first. */
.model-list { max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }
.model-list .note { overflow-wrap: anywhere; }
.settings input[type="checkbox"] { accent-color: var(--accent); }
.field-label { font-size: var(--text-s); font-weight: 600; color: var(--text); padding: 0; }

/* Design system (docs/design-system.md): settings rows, selects, switches, meters, and dialog headers. */
.ds-dialog-header { display: flex; align-items: center; gap: var(--space-2); min-height: 28px; }
.ds-dialog-header h3 { flex: 1; min-width: 0; margin: 0; font-size: var(--text-l); }
.ds-dialog-header > .icon-btn:first-child { margin-left: calc(-1 * var(--space-2)); }
.ds-dialog-header > .icon-btn:last-child { margin-right: calc(-1 * var(--space-2)); }
.ds-page { display: flex; flex-direction: column; gap: var(--space-4); }
.ds-group { display: flex; flex-direction: column; }
.ds-divider { border: 0; border-top: 1px solid var(--border); margin: 0; }
.ds-divider + .warning { margin-top: var(--space-2); }
.ds-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: var(--row-height); }
.ds-row-label { min-width: 0; }
.ds-row-control { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.ds-nav-row { display: flex; align-items: center; gap: var(--space-2); min-height: var(--row-height); width: calc(100% + 2 * var(--space-2));
  margin: 0 calc(-1 * var(--space-2)); padding: 0 var(--space-2); border: 0; border-radius: var(--radius-m); background: none; text-align: left; }
.ds-nav-row:hover:not(:disabled) { background: var(--hover); }
.ds-nav-row:disabled { opacity: 0.5; cursor: default; }
.ds-nav-row .label { flex: 1; min-width: 0; }
.ds-nav-row .value { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-nav-row svg { flex: none; color: var(--faint); }
.ds-select { display: inline-flex; align-items: center; justify-content: space-between; gap: var(--space-2); height: var(--control-height);
  min-width: 176px; max-width: 100%; padding: 0 var(--space-2) 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-m);
  background: var(--surface); font-weight: 500; }
.ds-select:hover:not(:disabled) { background: var(--hover); }
.ds-select:disabled { opacity: 0.5; cursor: default; }
.ds-select span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-select svg { flex: none; color: var(--muted); }
.ds-switch { position: relative; flex: none; width: 32px; height: 18px; padding: 2px; border: 0; border-radius: 9px; background: var(--switch-off); }
.ds-switch span { display: block; width: 14px; height: 14px; border-radius: 50%; background: var(--surface); box-shadow: 0 1px 2px rgb(0 0 0 / 0.2); transition: transform 0.15s; }
.ds-switch[aria-checked="true"] { background: var(--accent); }
.ds-switch[aria-checked="true"] span { transform: translateX(14px); }
.ds-switch:disabled { opacity: 0.5; cursor: default; }
@media (prefers-reduced-motion: reduce) { .ds-switch span { transition: none; } }
.ds-meter { height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
.ds-meter span { display: block; height: 100%; border-radius: 2px; background: var(--accent); }
.ds-meter.high span { background: var(--caution); }
.ds-meter.full span { background: var(--danger); }
.ds-steps { display: inline-flex; gap: var(--space-1); }
.ds-steps i { width: 6px; height: 6px; border-radius: 50%; background: var(--border); }
.ds-steps i.on { background: var(--accent); }
.ds-group-label { margin: 0 0 var(--space-1); font-size: var(--text-s); font-weight: 600; color: var(--muted); }
.ds-person { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.ds-person .stacked { gap: 0; min-width: 0; }
.ds-person .ellipsis, .ds-row .ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
.ds-actions.between { justify-content: space-between; }
.billing-usage { gap: var(--space-1); }
.billing-usage-row { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-2) 0; }
.billing-usage-row .row { flex-wrap: wrap; column-gap: var(--space-3); row-gap: 0; }
.billing-plan { gap: 1px; padding: var(--space-2) 0; }
.billing-plans .ds-row-control { flex: none; }
.billing-confirm { margin: 0; line-height: 1.5; }
.billing-cap-field { width: 120px; text-align: right; }

/* Thread view */
.thread-context { margin: 12px 16px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.thread-context .capture { display: block; width: 100%; max-height: 220px; object-fit: contain; background: #f6f7f9; border-bottom: 1px solid var(--border); cursor: zoom-in; }
.thread-context .capture-missing { padding: 10px 12px; border-bottom: 1px solid var(--border); background: #fafafa; }
.thread-context dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; padding: 10px 12px; font-size: 12px; }
.thread-context dt { color: var(--muted); }
.thread-context dd { margin: 0; overflow-wrap: anywhere; }
.target-status { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); font-size: 12px; }
.target-status .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; background: var(--faint); }
.target-status .dot.live { background: var(--success); }
.target-status .dot.warn { background: #d97706; }
.messages { padding: 4px 0 8px; }
.message { padding: 10px 16px; display: flex; gap: 10px; position: relative; }
.message.focused { background: #fff8db; transition: background 2s; }
.message .body { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
/* The author line starts at the avatar's top: the message's actions float over the row's end rather than sizing it. */
.message .meta { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 6px; line-height: 18px; padding-right: 60px; min-height: 18px; }
.message .author { font-weight: 600; }
.message .time, .message .edited { color: var(--faint); font-size: 12px; }
.message .via { color: var(--muted); font-size: 12px; white-space: nowrap; }
.message .actions { position: absolute; top: 6px; right: 10px; gap: 2px; opacity: 0; background: var(--surface); border-radius: 6px; }
.message.focused .actions { background: #fff8db; }
.message:hover .actions, .message:focus-within .actions { opacity: 1; }
.reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.reaction { border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; background: var(--surface); font-size: 12px; line-height: 20px; }
.reaction[aria-pressed="true"] { background: var(--accent-soft); border-color: #b9d0fb; color: var(--accent); }
.emoji-picker { display: flex; gap: 2px; padding: 4px; }
.emoji-picker button { border: 0; background: none; font-size: 16px; padding: 2px 4px; border-radius: 6px; }
.emoji-picker button:hover { background: var(--hover); }
.new-divider { display: flex; align-items: center; gap: 8px; padding: 4px 16px; color: var(--danger); font-size: 11px; font-weight: 600; }
.new-divider::after { content: ""; flex: 1; border-top: 1px solid var(--danger); }
.status-banner { margin: 12px 16px 0; padding: 8px 10px; border-radius: 8px; background: #ecfdf3; color: var(--success); font-size: 12px; }

/* Mockup mode: the page copy covers the prototype beneath Critiqs's panels */
.mockup-canvas { position: fixed; inset: 0; background: #fff; }
.mockup-canvas iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; visibility: hidden; background: #fff; }
.mockup-canvas iframe.shown { visibility: visible; }
/* Holding Original shows the live prototype through the copy, which still takes the pointer. */
.mockup-canvas.original { background: transparent; }
.mockup-canvas.original iframe { visibility: hidden; }
.target-box.chosen { transition: none; }
.mockup-panel .sidebar-header { gap: 6px; }
.thread-heading { min-width: 0; display: flex; flex-direction: column; }
.thread-heading h2 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread-heading .note { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mockup-tools { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 12px 8px 16px; border-bottom: 1px solid var(--border); }
.copy-tabs button { white-space: nowrap; }
.btn.hold { user-select: none; touch-action: none; }
.btn.hold:active { background: var(--accent-soft); border-color: #b9d0fb; color: var(--accent); }
.mockup-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 16px; font-size: 12px;
  background: var(--accent-soft); color: var(--accent-strong); border-bottom: 1px solid #c3d5f8; }
.mockup-banner.hint { background: var(--warning-bg); color: var(--warning-text); border-bottom-color: #f3e1b0; }
.mockup-banner .link-btn { font-size: 12px; }
.linked-mockups { margin: 10px 14px 0; }

/* Tickets linked to threads: chips in the thread window, badges on list rows and pins, and their dialogs. */
.ticket-chips { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-1) 6px; margin: 10px 14px 0; padding: 0; }
.ticket-chip { display: inline-flex; align-items: center; max-width: 100%; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); font-size: var(--text-s); }
.ticket-chip a { display: inline-flex; align-items: center; gap: 5px; min-width: 0; padding: 2px var(--space-2); border-radius: 999px; color: var(--text); text-decoration: none; }
.ticket-chip a:hover { background: var(--hover); }
.ticket-chip a svg { flex: none; color: var(--muted); }
.ticket-chip .key { font-weight: 600; white-space: nowrap; }
.ticket-chip .status { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ticket-chip .status.stale .ticket-dot { opacity: 0.45; }
.ticket-chip .stale-note { color: var(--faint); }
.ticket-chip .icon-btn { width: 20px; height: 20px; margin: 0 2px 0 -4px; border-radius: 50%; }
.ticket-chip .icon-btn svg { width: 12px; height: 12px; }
.ticket-chip .link-btn { padding: 2px var(--space-2) 2px 2px; font-size: var(--text-s); white-space: nowrap; }
.ticket-chip .link-btn:disabled { color: var(--muted); text-decoration: none; }
.ticket-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--faint); }
.ticket-dot.open { box-shadow: inset 0 0 0 1.5px var(--muted); }
.ticket-dot.started { background: var(--accent); box-shadow: none; }
.ticket-dot.done { background: var(--success); box-shadow: none; }
.ticket-badge { display: inline-flex; align-items: center; gap: 3px; font-weight: 500; white-space: nowrap; }
.ticket-badge svg { flex: none; }
.pin-ticket { position: absolute; right: -6px; bottom: -6px; display: grid; place-items: center; width: 13px; height: 13px; border-radius: 50%;
  background: #fff; color: #1f2023; box-shadow: 0 1px 2px rgb(0 0 0 / 0.35); }
.ticket-dialog .ticket-body { min-height: 168px; font-size: var(--text-s); line-height: 1.45; resize: vertical; }
.ticket-ai { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.ticket-labels { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.ticket-labels ul { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-1) 6px; margin: 0; padding: 0; }
.ticket-label { display: inline-flex; align-items: center; gap: 2px; padding: 1px 2px 1px var(--space-2); border: 1px solid var(--border); border-radius: 999px; background: var(--surface); font-size: var(--text-s); }
.ticket-label .icon-btn { width: 20px; height: 20px; border-radius: 50%; }
.ticket-label .icon-btn svg { width: 12px; height: 12px; }
.ticket-check { display: flex; align-items: center; gap: var(--space-2); }
.ticket-fields { display: flex; flex-direction: column; gap: var(--space-2); }
.ticket-fields fieldset { border: 0; margin: 0; padding: 0; gap: var(--space-1); }
.ticket-check input { margin: 0; accent-color: var(--accent); }
.ticket-results { display: flex; flex-direction: column; max-height: 232px; overflow-y: auto; margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-2)) 0; }
.ticket-result { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2); min-height: var(--row-height);
  padding: 0 var(--space-2); border-radius: var(--radius-m); cursor: pointer; }
.ticket-result:hover { background: var(--hover); }
.ticket-result.chosen { background: var(--accent-soft); }
.ticket-result input { margin: 0; accent-color: var(--accent); }
.ticket-result .key { font-weight: 600; white-space: nowrap; }
.ticket-result .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ticket-result .status { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--muted); font-size: var(--text-s); white-space: nowrap; }
@media (forced-colors: active) { .ticket-dot { border: 1px solid CanvasText; } }
.note.pad { padding: 4px 16px 10px; }
.list-more { padding: 2px 10px 8px; }
.mockup-entry .page-label { font-weight: 500; }
/* Above the composer's field: "+ Add existing comment" and the comments added, as short chips, like a chat's added context. */
/* Many comments scroll here instead of growing the composer; the padding keeps focus rings inside the scroll area. */
.composer-context { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); min-width: 0; max-height: 84px; overflow-y: auto;
  padding: 3px; margin: -3px; }
.composer-context .chip { height: 24px; max-width: 100%; padding: 0 2px 0 8px; font-size: var(--text-s); }
.composer-context .chip.comment-chip { gap: var(--space-1); background: var(--accent-soft); border-color: var(--tag-border); color: var(--accent-strong); font-weight: 500; }
.composer-context .chip.comment-chip svg { flex: none; width: 13px; height: 13px; }
.composer-context .chip.comment-chip .chip-tickets { display: inline-flex; align-items: center; gap: 3px; flex: none; color: var(--muted); font-weight: 500; white-space: nowrap; }
.composer-context .chip.comment-chip .chip-tickets svg { width: 12px; height: 12px; }
.composer-context .chip.add-comment { padding: 0 8px; margin-right: var(--space-2); background: var(--surface); border: 1px dashed var(--border); color: var(--muted); }
.composer-context .chip.add-comment:hover { color: var(--text); border-color: var(--faint); }
.composer-context .chip-remove { color: var(--accent-strong); }
.composer-context .chip-remove:hover { background: var(--tag-hover-bg); }
.chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 104px; }
.chip-remove { border: 0; background: none; border-radius: 999px; width: 18px; height: 18px; line-height: 16px; padding: 0; color: var(--muted); }
.chip-remove:hover { background: var(--hover); color: var(--text); }
/* "+ Add existing comment" opens its picker above the composer, over the conversation. */
.mockup-panel .sidebar-footer { position: relative; }
.comment-picker { position: absolute; left: 12px; right: 12px; bottom: calc(100% + 6px); z-index: 1; display: flex; flex-direction: column;
  gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow); overflow: hidden; }
.comment-picker input.field { padding: 5px 8px; min-height: 30px; }
.comment-options { max-height: 240px; overflow-y: auto; margin: 0 -8px -8px; border-top: 1px solid var(--border); }
.comment-options .entry { padding: 8px 12px; }
.comment-options .entry:last-child { border-bottom: 0; }
.entry .ai-tag { color: var(--accent); }
.ask-composer { display: flex; flex-direction: column; gap: 8px; }
.ask-composer textarea.field { min-height: 56px; }
/* Which model Critiqs AI answers with, beside Send, when the connection offers several. */
.model-choice { min-width: 0; max-width: 150px; font-size: 12px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.subheader { display: flex; align-items: center; gap: 4px; padding: 8px 12px 4px 8px; }
.subheader h3 { margin: 0; font-size: 13px; font-weight: 600; }
.message .badge.ai { padding: 0 6px; font-size: 10px; line-height: 16px; }
/* Mockup threads read as a chat: people's messages on the right in a bubble, Critiqs AI's on the left. */
.mockup-thread .message .meta { padding-right: 0; }
.mockup-thread .message.from-person { justify-content: flex-end; padding-left: 48px; }
.mockup-thread .message.from-person .said { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-1); min-width: 0; }
.mockup-thread .message.from-person .meta { justify-content: flex-end; }
.mockup-thread .message.from-person .bubble { max-width: 100%; padding: var(--space-2) var(--space-3); border-radius: 14px 14px 4px 14px; background: var(--accent-soft);
  white-space: pre-wrap; overflow-wrap: anywhere; }
.version-card { display: inline-flex; align-items: center; gap: 8px; margin-top: 6px; padding: 4px 10px; border: 1px solid var(--border);
  border-radius: 8px; font-size: 12px; color: var(--muted); }
.version-card.shown { border-color: #b9d0fb; background: var(--accent-soft); color: var(--accent-strong); }
.version-card .link-btn, .version-card .note { font-size: 12px; }
.version-event { padding: 6px 16px 6px 54px; color: var(--muted); font-size: 12px; }
.version-event .meta { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.ai-status { display: flex; align-items: center; gap: 8px; margin: 0 16px 12px; font-size: 12px; color: var(--muted); }
.ai-status.failed { flex-direction: column; align-items: stretch; }
.spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--accent-soft); border-top-color: var(--accent);
  animation: critiqs-spin 0.8s linear infinite; flex: none; }
@keyframes critiqs-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
/* Critiqs AI at work: its steps where its answer will appear, and a light sweeping over the copy it is changing. */
.ai-steps { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.ai-steps li { display: flex; align-items: center; gap: 8px; color: var(--muted); }
.ai-steps li.now { color: var(--text); font-weight: 500; }
.ai-steps .step-done { width: 12px; flex: none; color: var(--accent); font-size: 12px; line-height: 12px; text-align: center; }
.ai-dots::after { content: "…"; display: inline-block; width: 1.2em; overflow: hidden; vertical-align: bottom; animation: critiqs-dots 1.2s steps(4, end) infinite; }
@keyframes critiqs-dots { from { width: 0; } to { width: 1.2em; } }
.mockup-canvas .ai-scan { position: absolute; top: 0; bottom: 0; left: 0; pointer-events: none; overflow: hidden;
  background: rgb(13 99 243 / 0.06); box-shadow: inset 0 0 0 2px rgb(13 99 243 / 0.55); }
.mockup-canvas .ai-scan::before { content: ""; position: absolute; left: 0; right: 0; height: 160px; top: -160px;
  background: linear-gradient(180deg, rgb(13 99 243 / 0) 0%, rgb(13 99 243 / 0.16) 85%, rgb(13 99 243 / 0.5) 100%);
  animation: critiqs-scan 2.4s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
@keyframes critiqs-scan { to { transform: translateY(calc(100vh + 160px)); } }
.ai-scan-chip { position: absolute; top: 52px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-radius: 999px; background: var(--surface); color: var(--text); font-size: 12px; font-weight: 500;
  box-shadow: var(--shadow); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .mockup-canvas .ai-scan::before, .ai-dots::after { animation: none; } .mockup-canvas .ai-scan::before { display: none; } .ai-dots::after { width: 1.2em; } }

/* Dialogs and toasts */
.scrim { position: fixed; inset: 0; z-index: 3; background: rgb(0 0 0 / 0.32); display: grid; place-items: center; }
.dialog { width: min(440px, calc(100vw - 32px)); background: var(--surface); border-radius: 12px; box-shadow: var(--shadow); padding: 20px;
  display: flex; flex-direction: column; gap: 12px; }
.dialog h3 { margin: 0; font-size: 15px; }
.dialog p { margin: 0; color: #444; }
.dialog pre { margin: 0; max-height: 200px; overflow: auto; background: #f6f7f9; border-radius: 8px; padding: 10px; font-size: 11px; white-space: pre-wrap; }
.lightbox img { max-width: calc(100vw - 48px); max-height: calc(100vh - 48px); border-radius: 8px; box-shadow: var(--shadow); background: #fff; }
.toasts { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast { display: flex; align-items: center; gap: 12px; background: #1f2023; color: #fff; border-radius: 8px; padding: 8px 12px; box-shadow: var(--shadow); }
.toast .link-btn { color: #8ab4ff; }

/* Setup */
.setup { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.setup h3 { margin: 0; font-size: 15px; }
.setup p { margin: 0; color: #444; }
.step { display: flex; gap: 10px; }
.step .num { flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--hover); color: var(--muted); display: grid; place-items: center; font-size: 12px; font-weight: 700; }
.step.done .num { background: #dcfce7; color: var(--success); }
.code { display: flex; align-items: center; gap: 8px; background: #1f2023; color: #e5e7eb; border-radius: 8px; padding: 8px 8px 8px 12px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.code code { flex: 1; overflow-x: auto; white-space: nowrap; }
.code .btn { background: #34363b; border-color: #34363b; color: #fff; }
.project-list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.project-list button { border: 0; border-bottom: 1px solid var(--border); background: none; text-align: left; padding: 8px 12px; }
.project-list button:last-child { border-bottom: 0; }
.project-list button:hover { background: var(--hover); }
.banner { margin: 0; padding: 8px 16px; background: var(--warning-bg); color: var(--warning-text); font-size: 12px; border-bottom: 1px solid #f3e1b0; }
`;
