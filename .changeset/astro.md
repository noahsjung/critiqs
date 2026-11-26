---
"critiqs-astro": minor
"critiqs": minor
---

Astro sites get Critiqs on every page from one line in `astro.config` (`integrations: [critiqs()]` from the new `critiqs-astro` package), reading the project ID from `PUBLIC_CRITIQS_PROJECT_ID` or the config, staying open across `<ClientRouter />` navigations, naming each thread's page by its route (`items/:id`) and opening it again from a thread (`router: false` turns this off; your own `restoreContext` can fall back to `restoreRoute` from `critiqs-astro/client`); setup can add it to `astro.config`.
