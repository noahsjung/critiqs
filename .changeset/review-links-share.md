---
"critiqs": minor
"critiqs-react": minor
---

`npx critiqs share <folder>` uploads a static build and prints a review link for it, so people can review a prototype that has no address they can reach, with nothing installed. Only the project's owners can share; `critiqs share list` and `critiqs share delete <id or link>` manage shared builds, which last 7 days by default (`--expires`, 1 to 30). The backend checks every file again (no source maps, hidden files, files in `__critiqs/`, or anything that isn't a static web file; at most 1,000 files and 50 MiB), stores each only when its size and SHA-256 match, and serves the build through the review proxy under the project's review access until it expires or is deleted. Comments on a shared build keep a `https://<id>.build.invalid` address that never contains the link.
