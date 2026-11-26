---
"critiqs": patch
"critiqs-rails": patch
---

`npx critiqs init` on Rails and Django rewrites a hand-written line that sets the project ID only when the line sets one string, with at most a comment after it (the comment stays) and no condition around it. Any other line (a condition, an expression, a block around it) is left as written: `init` sets the ID where the framework reads it first (`.env` with dotenv, otherwise its own default just before that line) and says which value the app uses and why. In a Rails app with dotenv, a plain `ENV["CRITIQS_PROJECT_ID"] = "…"` line in `config/environments/development.rb` runs after dotenv and wins over `.env`, so `init` updates that line. When `--project-env-file` names a `.env` file the app doesn't load (Django, or Rails without dotenv), `init` and setup warn that the app reads it only if its own code loads it; with dotenv they warn instead when a line in `development.rb` still wins over `.env`.
