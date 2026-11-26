# Critiqs for Flask

Reviewers comment directly on a running prototype, discuss feedback, and find
its original context as the prototype changes. Critiqs brings its own toolbar,
sidebar, sign-in, and styles; it draws above your pages in its own shadow root
and needs no JavaScript build. Flask 3.0 or later, Python 3.10 or later.

## Set up

```sh
pip install flask-critiqs
```

Add the extension where the app is created:

```python
from flask import Flask
from flask_critiqs import Critiqs

app = Flask(__name__)
Critiqs(app)
```

In an application factory, call `Critiqs(app)` inside `create_app()`, or
create `critiqs = Critiqs()` once and call `critiqs.init_app(app)`.

Render Critiqs in the template every page extends, usually
`templates/base.html`, just before `</body>`:

```jinja
<body>
  {% block content %}{% endblock %}
  {{ critiqs() }}
</body>
```

Set the project ID in each deployment's environment:

```sh
CRITIQS_PROJECT_ID=<project ID>
```

Flask reads it on each request. Where it is unset, `critiqs()` renders
nothing, so production or any copy without a project shows no Critiqs. The
project ID is public configuration, not a secret. With python-dotenv
installed, `flask run` also reads it from `.env`.

The extension serves Critiqs's script at `/_critiqs/element.js`.

## Config

All optional:

| Key | Meaning |
| --- | --- |
| `CRITIQS_PROJECT_ID` | The project, instead of the environment variable. |
| `CRITIQS_REQUIRE_PROJECT_ID` | Default `True`. `False` shows project setup where no ID is set. |
| `CRITIQS_BACKEND` | Your team's own backend, such as `https://<deployment>.convex.cloud`. |
| `CRITIQS_VERSION` | Recorded with each message, such as a release or Git commit. |

`CRITIQS_PROJECT_ID` set to `None` or `""` means no project, even when the
`CRITIQS_PROJECT_ID` environment variable is set: the variable applies only
when the key isn't in the config at all. So
`app.config["CRITIQS_PROJECT_ID"] = os.environ.get("CRITIQS_PROJECT_ID_WEB")`
shows no Critiqs where `CRITIQS_PROJECT_ID_WEB` is unset.

## Screens and routes

Each page tells Critiqs which screen it shows, so a thread left on one user's
page names the page `users/:id` rather than `/users/42`. By default the screen
is the matched URL rule with variables as `:name` (`<path:…>` as `:name*`),
the root is `/`, and the rule's variables become view state, such as
`route.id = "42"`. Name the screen yourself when the rule isn't the right one:

```jinja
{{ critiqs(screen="user-details") }}
```

An empty or undefined `screen` falls back to the rule.

Opening a thread on a server-rendered app is a full page load, so there is
nothing to set up for it. An app that wants the page's path back from a thread
can build it with `routePath` from the `critiqs` npm package.

## Content Security Policy

Critiqs's two scripts (its bundle, and the inline one that reports the
screen) carry the nonce you pass with `{{ critiqs(nonce=...) }}`, or
Flask-Talisman's request nonce on its own. Without a nonce, a policy that
blocks inline scripts stops only the screen report: threads then name the URL
path. Allow `connect-src` to your Critiqs backend.

## License

MIT
