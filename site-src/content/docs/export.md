---
title: Export threads
description: Select feedback threads in the Critiqs sidebar and export them as Markdown for teammates or structured JSON for scripts and agents.
section: Agents
order: 3
---

Exporting lets you bundle selected threads into one Markdown document for people or one JSON file for tools and coding agents. Use export when you want a quick handoff to an issue tracker, a pull request description, or an agent session without configuring [MCP](/docs/mcp).

## Export selected threads

1. Press `C` or click **Comment mode** on the toolbar and open the comments list in the sidebar.
2. Optional: filter the list by status, unread, screen, tags, or tag groups so only relevant threads appear.
3. Click **Select threads to export**.
4. Tick the threads you want to include, or click **Select all**. You can export up to 200 threads at once.
5. Click **Export…**.
6. Edit the collection title if needed (it defaults to `Feedback handoff, <date>`).
7. Choose a format:
   - **Markdown, for people**: readable headings, metadata bullet points, and quoted messages.
   - **JSON, for tools**: structured JSON with `schemaVersion: 1`.
8. Click **Copy** to copy the preview to your clipboard, or **Download** to save it as a `.md` or `.json` file.

> **Note:** Export collections are created on demand and are not saved in Critiqs. Mockup threads are separate from feedback threads; read mockups through [MCP](/docs/mcp).

## What each export includes

Every exported thread keeps its full discussion without merging separate conversations:

- Thread ID, shareable link, status (`open` or `resolved`), and tags
- Screen, view state, scope (`shared` or `record`), and whether the thread was reattached
- Target details: `purposeId` (`data-critiqs-id`), `recordKey` (`data-critiqs-record`), and element label
- Page URL, browser viewport size, prototype revision, demo persona, and whether a capture exists (`hasCapture`)
- Every message with its author, timestamp, edited timestamp, revision, direct link, text, and `via: "agent"` when posted by a coding agent

Exports exclude sign-in details, unrelated app data, deleted threads, and capture images. Open any thread's link in the export to view its saved capture.

If a thread's discussion fails to load while preparing the export, Critiqs stops the export instead of producing a partial handoff.

## Format examples

### Markdown, for people

```markdown
# Feedback handoff, 11/24/2026

Project: Acme console
Exported: 2026-11-24T18:30:00.000Z
Threads: 1

## Spell out the department here.

- Link: https://staging.acme.example/customers/harbor?critiqs=thr_123
- Status: open
- Tags: UX copy change, #wording
- Screen: customer-details
- Target: `customer.department`, "Ops", record customer:harbor
- Scope: this record only
- Revision: staging-2026.11.24
- Page: https://staging.acme.example/customers/harbor at 1440×900
- View state: tab=team
- Capture: saved; open the link to view it

### Discussion

**Priya**, 2026-11-24T18:10:00.000Z, revision staging-2026.11.24:

> Spell out the department here. #wording
```

### JSON, for tools

```json
{
  "schemaVersion": 1,
  "title": "Feedback handoff, 11/24/2026",
  "projectName": "Acme console",
  "exportedAt": 1795458600000,
  "threads": [
    {
      "id": "thr_123",
      "link": "https://staging.acme.example/customers/harbor?critiqs=thr_123",
      "status": "open",
      "tags": ["UX copy change", "#wording"],
      "screen": "customer-details",
      "viewState": { "tab": "team" },
      "scope": "record",
      "target": {
        "purposeId": "customer.department",
        "recordKey": "customer:harbor",
        "label": "Ops"
      },
      "revision": "staging-2026.11.24",
      "pageUrl": "https://staging.acme.example/customers/harbor",
      "viewport": { "width": 1440, "height": 900 },
      "persona": null,
      "reattached": false,
      "hasCapture": true,
      "messages": [
        {
          "id": "msg_456",
          "link": "https://staging.acme.example/customers/harbor?critiqs=thr_123.msg_456",
          "author": "Priya",
          "createdAt": 1795457400000,
          "editedAt": null,
          "body": "Spell out the department here. #wording",
          "revision": "staging-2026.11.24"
        }
      ]
    }
  ]
}
```
