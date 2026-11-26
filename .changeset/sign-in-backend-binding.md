---
"critiqs-react": patch
---

The CLI and MCP send a saved sign-in only to the backends it was signed in for, and to where each serves screenshots and page copies. For any other address they stop with a message that names the backend's origin and how to sign in for it (`npx critiqs-react sign-in --backend '<origin>'`, quoted for the shell); MCP tools return that as a tool error. The approval pages for `sign-in` and setup name the backend, and its download address unless it is a Convex Cloud deployment's own `.convex.site`, so you can check them before approving. Signing in, or `init --remote`, for a backend other than Critiqs Cloud needs a sign-in service that confirms it shows both addresses, when the approval starts and again when it is approved: deploy the current Critiqs backend there. Critiqs Cloud sign-ins work as before.

The approval address the CLI and MCP show and open is always the sign-in service's own `/auth/device` page, never an address the service suggests, and the browser opens it without a shell on every platform (on Windows, through `rundll32` rather than `cmd`).

Requests that carry a sign-in no longer follow redirects, and sign-ins go over plain http only to `localhost`, `127.0.0.1` to `127.255.255.255`, and `[::1]`, no longer to other `.localhost` names.

Sign-ins are now saved in `sign-in.v2.json`, beside the `sign-in.json` earlier versions use, so an earlier version can't write over them. Sign-ins saved by earlier versions move once: they keep working with Critiqs Cloud when they came from Critiqs Cloud, other backends need one fresh sign-in, and `sign-in.json` is left signed out. An earlier version of this package on the same computer, such as a pinned `npx` version or an MCP server started before the upgrade, asks to sign in again, and keeps its own new sign-ins to itself; upgrading it ends that. A move cut off partway, by a crash or a failed write, is finished by the next command. Signing out of Critiqs Cloud also signs out a Critiqs Cloud sign-in an earlier version saved, so the next command doesn't sign in as that person instead.

The lock beside the sign-in file is now a directory with a heartbeat. Processes take over an abandoned lock one at a time, and a process whose lock was taken over writes nothing until it holds the lock again, keeping the new sign-in token it was given.
