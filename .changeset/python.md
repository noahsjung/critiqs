---
"critiqs": minor
"critiqs-django": minor
"critiqs-flask": minor
---

Add Critiqs for Django (`pip install django-critiqs`, then `{% critiqs %}` in your base template) and Flask (`pip install flask-critiqs`, then `Critiqs(app)` and `{{ critiqs() }}`), which read the project ID from `CRITIQS_PROJECT_ID` on each request and report each page's route as its screen, and setup that adds either to an existing app.
