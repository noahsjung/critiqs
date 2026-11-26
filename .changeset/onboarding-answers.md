---
"critiqs-react": minor
---

Backends store onboarding's answers for the Critiqs website. `saveAboutYou` (`onboarding:saveAboutYou` on Convex) saves the signed-in person's role and team size; values it doesn't know are dropped, and a skipped answer changes nothing. Creating a project also takes optional `onboarding` answers (who changes the code, who leaves feedback, what it's for) and a `stack`, which the project keeps; what it's for picks the starting tags, and without it a project starts with the default tags as before. `/critiqs/config` reports `onboardingAnswers: true`. Existing calls and arguments are unchanged. A self-hosted SQLite database upgrades on start.
