---
"critiqs-react": patch
---

Setup emails to a project's developers, and the backend's setup steps for a project, now give every framework with a Critiqs package its own commands: install the framework's package (`critiqs-vue`, `critiqs-rails`, `django-critiqs`, and the others), then `npx critiqs init <projectId>`. A project whose framework wasn't confirmed gets `npx critiqs init <projectId>` alone, which finds the framework. Stacks with no Critiqs package, such as WordPress or Laravel, get the script tag's guide and the project ID instead of "support is coming".
