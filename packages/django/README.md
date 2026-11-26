# Critiqs for Django

Reviewers comment directly on a running prototype, discuss feedback, and find
its original context as the prototype changes. Critiqs brings its own toolbar,
sidebar, sign-in, and styles; it draws above your pages in its own shadow root
and needs no JavaScript build. Django 5.2 or later, Python 3.10 or later.

## Set up

```sh
pip install django-critiqs
```

Add the app, after `django.contrib.staticfiles`:

```python
INSTALLED_APPS = [
    # ...
    "django.contrib.staticfiles",
    "django_critiqs",
]
```

Render Critiqs in the template every page extends, usually
`templates/base.html`, just before `</body>`:

```django
{% load critiqs %}
<!DOCTYPE html>
<html>
  <body>
    {% block content %}{% endblock %}
    {% critiqs %}
  </body>
</html>
```

Set the project ID in each deployment's environment:

```sh
CRITIQS_PROJECT_ID=<project ID>
```

Django reads it on each request. Where it is unset, `{% critiqs %}` renders
nothing, so production or any copy without a project shows no Critiqs. The
project ID is public configuration, not a secret. For the development server,
`npx critiqs init` adds a default to `manage.py`, beside Django's own
`DJANGO_SETTINGS_MODULE` one, which an environment variable still overrides:

```python
os.environ.setdefault("CRITIQS_PROJECT_ID", "<project ID>")
```

A deployment's WSGI or ASGI server doesn't run `manage.py`, so it still
shows Critiqs only where `CRITIQS_PROJECT_ID` is set.

Critiqs's script is a static file (`critiqs/element.js`), so run
`python manage.py collectstatic` when you deploy, as for your own static files.

## Settings

All optional, in a `CRITIQS` dict in your settings:

```python
CRITIQS = {
    "PROJECT_ID": "<project ID>",         # instead of CRITIQS_PROJECT_ID
    "REQUIRE_PROJECT_ID": True,           # False: show project setup where no ID is set
    "BACKEND": "https://<deployment>.convex.cloud",  # your team's own backend
    "VERSION": "v1.4.0",                  # recorded with each message, such as a Git commit
}
```

`PROJECT_ID` set to `None` means no project, even when `CRITIQS_PROJECT_ID`
is set. Django's system checks warn about keys Critiqs doesn't read.

## Screens and routes

Each page tells Critiqs which screen it shows, so a thread left on one user's
page names the page `users/:id` rather than `/users/42`. By default the screen
is the matched `path()` pattern with converters as `:name` (`<path:…>` as
`:name*`), the root is `/`, and the route's parameters become view state, such
as `route.id = "42"`. Name the screen yourself when the pattern isn't the right
one, or for `re_path()` routes, which report no screen of their own:

```django
{% critiqs screen="user-details" %}
```

An empty or undefined `screen` falls back to the pattern.

Opening a thread on a server-rendered app is a full page load, so there is
nothing to set up for it. An app that wants the page's path back from a thread
can build it with `routePath` from the `critiqs` npm package.

## Content Security Policy

Critiqs's two scripts (its bundle, and the inline one that reports the
screen) carry your page's nonce when you use Django's own CSP support (Django
6.0 or later, with the `csp` context processor or the CSP middleware) or
django-csp. Without a nonce, a policy that blocks inline scripts stops only
the screen report: threads then name the URL path. Allow `connect-src` to your
Critiqs backend.

## License

MIT
