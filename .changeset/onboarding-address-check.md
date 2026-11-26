---
"critiqs-react": minor
---

Add onboarding's address check to both backends: `addressCheck:check` on Convex and `checkPrototypeAddress` on the self-hosted server, with `addressCheck: true` in `/critiqs/config`. It tells a signed-in person whether their prototype's address loads publicly, needs a sign-in, is blocked, can't be reached, or is on their computer, and which stack it uses. It never connects to private, loopback, or link-local addresses or to ports other than 80 and 443, runs at most 16 checks at once per server process, and allows 20 checks per person and 500 per deployment each hour. A self-hosted server can turn it off with `createCritiqsHandler({ addressCheck: false })`, reported as `addressCheck: false`. Existing calls are unchanged; host apps don't need to do anything.
