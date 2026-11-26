---
"critiqs-react": minor
"critiqs": minor
---

Project setup shows a project's owners its address list, the sites where the Critiqs extension finds the project, on backends that report `addressEdits`. Each address has **Remove**, and a field adds an origin or a pattern such as `https://*-acme.vercel.app`; each change saves at once. The transport adds `useProjectAddresses`, `addProjectAddress`, and `removeProjectAddress`. `parseProjectAddress` in `@critiqs/core` now reads a pattern the same in every browser: Chrome writes a `*` in a host as `%2A`, which made it refuse every pattern there. Backends now refuse a pattern that covers a whole shared domain or public suffix, such as `https://*.vercel.app`, `https://*.github.io`, or `https://*.co.uk`, using the Public Suffix List with its private section; `https://*-acme.vercel.app` and `https://*.acme.com` are still accepted. A pattern like that saved earlier stays on the list for its owners to remove, but the extension's lookup no longer finds any project by it, and a match reached only through a pattern of a project the person merely opened is offered as a choice, never shown at once.
