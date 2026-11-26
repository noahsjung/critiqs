---
"critiqs-react": minor
"critiqs": minor
---

Backends refuse an address pattern over a shared domain unless at least four letters or digits of the site's own name sit beside its `*`: `https://*a.vercel.app` and `https://*-app.vercel.app` are refused, `https://*-acme.vercel.app` is still accepted. Shared hosts the Public Suffix List misses, such as `glitch.me` and `koyeb.app`, now count as shared domains. Backends that report `addressNotes` answer `projectAddressNotes` with the addresses in a project's list that match no site now, and project setup marks each one, saying to remove it and what to add instead; its example pattern is now one the list accepts.
