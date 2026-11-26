---
"critiqs-angular": minor
"critiqs": minor
---

Angular apps can add Critiqs with `provideCritiqs()` from the new `critiqs-angular` package (setup adds it to `src/app/app.config.ts`); it runs only in the browser, outside Angular's zone, loads after the app starts, and with Angular Router names each thread's route (`users/:id`) and navigates back to it when a thread is opened (`router: false` turns this off).
