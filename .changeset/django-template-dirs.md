---
"critiqs": patch
---

`npx critiqs init` and `doctor` on Django also look for `{% critiqs %}` in the folders `TEMPLATES["DIRS"]` lists (written as `BASE_DIR / "folder"`, `os.path.join(BASE_DIR, "folder")` or a string), so a run without `--entry` after one with it no longer adds a second tag to another template.
