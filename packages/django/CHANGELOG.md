# critiqs-django

## 0.5.0

No changes in this release.

## 0.4.0

### Minor Changes

- 957ce10: Add Critiqs for Django (`pip install django-critiqs`, then `{% critiqs %}` in your base template) and Flask (`pip install flask-critiqs`, then `Critiqs(app)` and `{{ critiqs() }}`), which read the project ID from `CRITIQS_PROJECT_ID` on each request and report each page's route as its screen, and setup that adds either to an existing app.

### Patch Changes

- 5c83648: `critiqs init` now gives Django, Flask and Rails apps their project for development, so Critiqs shows on the next page load with no environment variable to set by hand. Django gets `os.environ.setdefault("CRITIQS_PROJECT_ID", …)` in `manage.py`, beside Django's own default; Rails gets `ENV["CRITIQS_PROJECT_ID"] ||= …` at the end of `config/environments/development.rb` (or `.env` when the app uses dotenv); Flask gets `.env`, and flask-critiqs reads `CRITIQS_PROJECT_ID`, and only that key, from it when Flask's development server (`flask run`, `app.run()`) serves the page; it puts nothing in `os.environ`, adds no dependency, and production servers such as Gunicorn and Waitress never read it. An older plain `ENV["CRITIQS_PROJECT_ID"] = …` line in `development.rb` now gets the new ID instead of silently overriding it. A `CRITIQS_PROJECT_ID` set in the environment still wins, and deployments still show Critiqs only where they set it. Init's output also names installing the package and what each deployment sets once each, not twice.
