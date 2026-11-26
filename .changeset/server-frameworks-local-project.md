---
"critiqs": patch
"critiqs-django": patch
"critiqs-flask": patch
"critiqs-rails": patch
---

`critiqs init` now gives Django, Flask and Rails apps their project for development, so Critiqs shows on the next page load with no environment variable to set by hand. Django gets `os.environ.setdefault("CRITIQS_PROJECT_ID", …)` in `manage.py`, beside Django's own default; Rails gets `ENV["CRITIQS_PROJECT_ID"] ||= …` at the end of `config/environments/development.rb` (or `.env` when the app uses dotenv); Flask gets `.env`, and flask-critiqs reads `CRITIQS_PROJECT_ID`, and only that key, from it when Flask's development server (`flask run`, `app.run()`) serves the page; it puts nothing in `os.environ`, adds no dependency, and production servers such as Gunicorn and Waitress never read it. An older plain `ENV["CRITIQS_PROJECT_ID"] = …` line in `development.rb` now gets the new ID instead of silently overriding it. A `CRITIQS_PROJECT_ID` set in the environment still wins, and deployments still show Critiqs only where they set it. Init's output also names installing the package and what each deployment sets once each, not twice.
