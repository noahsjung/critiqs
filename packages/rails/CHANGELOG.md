# critiqs-rails

## 0.4.0

### Minor Changes

- 639ea04: Add Critiqs to Ruby on Rails apps with the new critiqs-rails gem: `<%= critiqs_tag %>` in the layout shows Critiqs wherever CRITIQS_PROJECT_ID is set and reports each page's route, and `bin/rails generate critiqs:install` or `critiqs init` adds it for you.

### Patch Changes

- 5c83648: `critiqs init` now gives Django, Flask and Rails apps their project for development, so Critiqs shows on the next page load with no environment variable to set by hand. Django gets `os.environ.setdefault("CRITIQS_PROJECT_ID", …)` in `manage.py`, beside Django's own default; Rails gets `ENV["CRITIQS_PROJECT_ID"] ||= …` at the end of `config/environments/development.rb` (or `.env` when the app uses dotenv); Flask gets `.env`, and flask-critiqs reads `CRITIQS_PROJECT_ID`, and only that key, from it when Flask's development server (`flask run`, `app.run()`) serves the page; it puts nothing in `os.environ`, adds no dependency, and production servers such as Gunicorn and Waitress never read it. An older plain `ENV["CRITIQS_PROJECT_ID"] = …` line in `development.rb` now gets the new ID instead of silently overriding it. A `CRITIQS_PROJECT_ID` set in the environment still wins, and deployments still show Critiqs only where they set it. Init's output also names installing the package and what each deployment sets once each, not twice.
- 7d9071c: `npx critiqs init` on Rails and Django rewrites a hand-written line that sets the project ID only when the line sets one string, with at most a comment after it (the comment stays) and no condition around it. Any other line (a condition, an expression, a block around it) is left as written: `init` sets the ID where the framework reads it first (`.env` with dotenv, otherwise its own default just before that line) and says which value the app uses and why. In a Rails app with dotenv, a plain `ENV["CRITIQS_PROJECT_ID"] = "…"` line in `config/environments/development.rb` runs after dotenv and wins over `.env`, so `init` updates that line. When `--project-env-file` names a `.env` file the app doesn't load (Django, or Rails without dotenv), `init` and setup warn that the app reads it only if its own code loads it; with dotenv they warn instead when a line in `development.rb` still wins over `.env`.
