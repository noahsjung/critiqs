---
"critiqs": patch
"critiqs-rails": patch
---

`npx critiqs init` on Rails and Django keeps the rest of a hand-written line when it replaces the project ID in it, such as a trailing `if` condition or comment. In a Rails app with dotenv, a plain `ENV["CRITIQS_PROJECT_ID"] = …` line in `config/environments/development.rb` runs after dotenv and wins over `.env`, so `init` updates that line instead of writing a `.env` value the app would ignore. When `--project-env-file` names a `.env` file for Django, or for Rails without dotenv, which load no `.env` file, `init` and setup warn that the app reads it only if its own code loads it.
