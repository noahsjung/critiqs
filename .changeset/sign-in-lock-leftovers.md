---
"critiqs": patch
---

A Critiqs process that stopped while removing its sign-in lock could leave a `sign-in.v2.json.lock.<token>.gone` folder behind in Critiqs's config folder. The next process to take the lock now removes any such leftovers.
