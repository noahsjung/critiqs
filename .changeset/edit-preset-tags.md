---
"critiqs": minor
"critiqs-react": minor
---

A project's owner can now change its preset tags, which typing `#` suggests after the tags reviewers used most recently: in **Tags and AI**, the **Tags** tab (formerly **Tag groups**) lists them in order, with **Add preset**, and **Change…** on each to move it up or down, rename it, or remove it. Rename, move, and remove act on the preset chosen even when the list changed in another window meanwhile. Presets follow the tag rules (1 to 50 characters, starting with a letter, with letters, numbers, spaces, `-`, and `_`; no two alike; up to 50). Threads keep the tags they already have: a renamed or removed preset stays on them as an ordinary tag, still in filters. Among tags not used yet, `#` now suggests presets in the project's order instead of alphabetically. Backends gain `tags:setPresets` (Convex) and `setPresetTags` (self-hosted server), which require the list being changed as `previous`, and report `presetTags` at `/critiqs/config`; the editor appears only on backends that report it, the protocol stays 5, and older components keep working unchanged. Deploy the matching backend; the self-hosted database needs no migration.
