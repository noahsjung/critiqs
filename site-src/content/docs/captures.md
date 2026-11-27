---
title: Captures and saved context
description: See what every Critiqs comment saves, how automatic captures work, how to mask sensitive data with data-critiqs-mask, and how capture access is checked.
section: Review
order: 3
---

Every new thread in Critiqs attempts an automatic capture and saves context metadata from the moment you posted it. Even if the UI changes in a later build or the original element disappears, reviewers and developers can still see what was on screen.

## What every comment saves

Open any thread and expand **Saved context** (expanded automatically when the target element is not on screen) and **Details** to see what was recorded:

1. **Capture:** Starting a new thread attempts an automatic PNG screenshot of your visible browser viewport with the commented element outlined in blue. Click the capture image to view it full size.
2. **Page and browser details:** The page URL (with Critiqs's `?critiqs=` link parameter stripped), browser viewport width and height, browser name, capture timestamp, and the prototype build version (shown as `Unknown` if your app does not pass the `version` prop).
3. **Screen, tab, and view state:** The logical screen name (the URL path by default, or the screen your app returns from `getContext`), active view state such as the selected tab, open dialog, filters, or step, and any demo persona your app reports.
4. **Element anchor:** Critiqs saves the element's `data-critiqs-id` purpose ID (if set), its `data-critiqs-record` key (if inside a record), fallback clues (HTML tag, accessible label, role, and DOM path), and whether the thread applies to **This record only** or **Every record showing this element**. Under **Details**, **Element** shows one description, chosen in order from the purpose ID, the label, or the HTML tag.

> **Note:** A demo persona reported by the host app is stored only as review context ("Viewing as"). It never replaces the signed-in reviewer's real identity or permissions.

## How automatic captures work

Critiqs renders captures directly from the browser's DOM using `modern-screenshot`, cropped to your current viewport and keeping nested scroll containers at their scroll position.

- **Critiqs stays out of the picture:** Critiqs skips every mounted `<Critiqs />` element while copying the page, so its toolbar, sidebar, pins, and windows never appear in captures and never flicker on screen.
- **The page stays responsive:** Copying yields to the browser in short slices so the page does not freeze while a capture runs.
- **No mismatched views:** If the screen or view state changes while a capture is running, Critiqs discards the capture instead of saving an image from the wrong view.

### When automatic capture fails

DOM capture can fail if a page contains cross-origin images or frames the browser blocks from reading, if the rendered PNG exceeds 8 MB, or if rendering takes longer than 10 seconds. Dimmed backdrops behind dialogs can also be omitted by DOM rendering.

When automatic capture fails, Critiqs still saves your comment along with the failure reason. Inside the thread, click **Attach a screenshot** to upload a PNG, JPEG, WebP, or GIF image (up to 10 MB). A manually supplied screenshot is stored as uploaded and may have no target outline.

## Privacy and masking sensitive content

### Mask regions with data-critiqs-mask

Add the `data-critiqs-mask` attribute to any element that displays sensitive information such as personal data, API keys, or billing numbers:

```tsx
<div data-critiqs-mask>
	<span>Account balance: $42,100.00</span>
</div>
```

During capture, Critiqs replaces the masked element's copy with a solid gray box of the same size and removes all of its child nodes, text, attributes, and CSS classes before rendering the image. The same attribute covers sensitive elements in **Mockup mode** page copies, and password inputs in page copies are automatically replaced with bullets.

A page copy leaves out values the page never shows, which only its scripts read (no script runs in a copy): the value of each hidden form field (`type="hidden"`, or a field with the `hidden` attribute that isn't displayed); HTML comments; the content of every meta tag except `viewport`, `color-scheme`, `supported-color-schemes`, `referrer` and `format-detection`, such as anti-forgery tokens; Inertia's `data-page`, Phoenix LiveView's `data-phx-session` and `data-phx-static`, Livewire's `wire:snapshot`, `wire:effects` and `wire:initial-data`, Turbo's `signed-stream-name` and Astro islands' `props`; and any other `data-*` or `prefix:name` attribute whose name contains `csrf` or `xsrf`, or whose value is JSON or a single token of 100 characters or more, unless the page's CSS names that attribute. These attributes and tags stay, empty, so the copy looks the same. A copy still holds everything else in the page's HTML: text and visible form values, shorter `data-*` values, other attributes such as a form's `action` address or a button's `value`, fields hidden only by CSS, and the addresses of the page's images and stylesheets. Mask anything sensitive the page shows or holds with `data-critiqs-mask`. Copies made by earlier versions keep what they held.

Masking covers rendered capture pixels and frozen page copies only. It does not redact saved thread metadata: the element's label is still read from its live `aria-label` or text content when someone clicks it, and the page URL and any app-supplied context (`getContext`, `data-critiqs-id`, and `data-critiqs-record`) are saved as well. Keep secrets and sensitive personal data out of element labels, URLs, and app-supplied context.

### Masking canvas, video, and iframe elements

Place `data-critiqs-mask` on a wrapper element around a `<canvas>`, `<video>`, or `<iframe>`, not directly on the media element itself:

```tsx
<div data-critiqs-mask>
	<canvas id="sensitive-chart" />
</div>
```

The DOM capture renderer replaces `<canvas>`, `<video>`, and `<iframe>` nodes without preserving their attributes. If one of those elements carries `data-critiqs-mask` directly, Critiqs refuses the automatic capture instead of risking an unmasked image, saves the comment with the reason, and lets you attach a safe screenshot manually.

### Access control and data boundaries

- **Authenticated capture delivery:** Captures are never served from public URLs. Critiqs serves every capture through its authenticated `/capture` endpoint, which checks the signed-in reviewer's access to the project on every request and returns a sandboxing `Content-Security-Policy` header.
- **Unused upload cleanup:** Uploaded screenshots must be attached to a thread within one hour and can be used only once. On deployments using Cloudflare R2 storage, unused R2 uploads are removed automatically.
- **Exports and AI:** Markdown and JSON exports include discussions, links, tags, targets, and metadata, but exclude sign-in credentials, unrelated app data, and capture images. AI requests for tag grouping, search, and mockups never receive captures or reviewer email addresses, and masked regions are left out of page descriptions sent to AI.
