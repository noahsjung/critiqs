---
"critiqs": minor
"critiqs-vue": minor
"critiqs-nuxt": minor
---

Add Critiqs to Vue and Nuxt apps: `critiqs-vue` adds a `<Critiqs>` component for Vue 3, `critiqs-nuxt` is a Nuxt module that only needs adding to `modules` (with the project ID from `NUXT_PUBLIC_CRITIQS_PROJECT_ID`), both report each Vue Router route as the screen and open a thread's route again (Nuxt apps can pass their own `getContext` and `restoreContext` through the `critiqs:options` hook), and setup can now add either to an app.
