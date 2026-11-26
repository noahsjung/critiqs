"""Critiqs for Flask: `Critiqs(app)`, then `{{ critiqs() }}` in the base template.

Config: CRITIQS_PROJECT_ID (else, when the key is absent, the CRITIQS_PROJECT_ID
environment variable; None or "" means no project),
CRITIQS_REQUIRE_PROJECT_ID (default True), CRITIQS_BACKEND, CRITIQS_VERSION.
"""

import json
import os
import re

from flask import Blueprint, Flask, current_app, has_request_context, request, url_for
from jinja2 import Undefined
from markupsafe import Markup

__all__ = ["Critiqs", "critiqs"]

ENV_VARIABLE = "CRITIQS_PROJECT_ID"
# A rule's variable, such as <int:id>; <path:…> spans segments.
VARIABLE = re.compile(r"<(?:(\w+)(?:\([^)]*\))?:)?(\w+)>")

# Serves Critiqs's browser bundle at /_critiqs/element.js.
blueprint = Blueprint("critiqs", __name__, static_folder="static", static_url_path="/_critiqs")


class Critiqs:
    """The extension: `Critiqs(app)`, or `Critiqs()` then `init_app(app)` in an app factory."""

    def __init__(self, app: Flask | None = None):
        if app is not None:
            self.init_app(app)

    def init_app(self, app: Flask) -> None:
        app.config.setdefault("CRITIQS_REQUIRE_PROJECT_ID", True)
        app.register_blueprint(blueprint)
        app.add_template_global(critiqs, "critiqs")
        app.extensions["critiqs"] = self


def _text(value):
    # None, "" and Jinja's Undefined all mean "not given". Undefined is checked
    # first: StrictUndefined raises when it is turned into a string.
    if value is None or isinstance(value, Undefined) or str(value) == "":
        return None
    return str(value)


def route_context(screen: str | None = None) -> dict | None:
    """The view this request shows, in Critiqs's route convention: the screen
    is the matched URL rule in :name form (/users/<int:id> -> users/:id, the
    root -> /), and its variables are view state keys route.<name>. `screen`
    replaces the rule unless it is empty. None when there is neither. Only the
    rule's own URL variables are reported, never its server-side defaults."""
    screen = _text(screen)
    # Outside a request (an app context alone, say) there is no route to report.
    rule = request.url_rule if has_request_context() else None
    params = {}
    if rule is not None:
        # A rule's arguments include the keys of its defaults; those never appear in the URL.
        variables = rule.arguments - set(rule.defaults or ())
        params = {f"route.{name}": str(value) for name, value in (request.view_args or {}).items() if name in variables}
    if screen is None and rule is not None:
        pattern = VARIABLE.sub(lambda m: f":{m.group(2)}{'*' if m.group(1) == 'path' else ''}", rule.rule)
        screen = pattern.strip("/") or "/"
    return None if screen is None else {"screen": screen, "viewState": params}


def _json(value):
    # Safe inside <script>: no </script>, <!--, or & can end or change it.
    return json.dumps(value).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def critiqs(nonce: str | None = None, screen: str | None = None) -> Markup:
    """<critiqs-app> with the app's settings and the script that defines it,
    then a script that reports this page's screen (the matched URL rule, or
    `screen`); nothing when a project ID is required and none is set. The
    scripts carry `nonce`, or Flask-Talisman's request nonce, for a Content
    Security Policy."""
    config = current_app.config
    # As in Django: the variable applies only when the config doesn't have the key at all.
    project_id = _text(config["CRITIQS_PROJECT_ID"] if "CRITIQS_PROJECT_ID" in config else os.environ.get(ENV_VARIABLE))
    require = bool(config.get("CRITIQS_REQUIRE_PROJECT_ID", True))
    if require and project_id is None:
        return Markup("")
    nonce = _text(nonce)
    if nonce is None and has_request_context():
        nonce = _text(getattr(request, "csp_nonce", None))
    nonce_attribute = Markup(' nonce="{}"').format(nonce) if nonce is not None else ""
    view = route_context(screen)
    report = (
        Markup(
            '<script type="module"{}>customElements.whenDefined("critiqs-app").then(() => document.querySelector("critiqs-app")?.setContext({}));</script>'
        ).format(nonce_attribute, Markup(_json(view)))
        if view is not None
        else ""
    )
    attributes = [("project-id", project_id), ("backend", _text(config.get("CRITIQS_BACKEND"))), ("version", _text(config.get("CRITIQS_VERSION")))]
    return Markup('<critiqs-app{}{}></critiqs-app><script type="module" src="{}"{}></script>{}').format(
        Markup("").join(Markup(' {}="{}"').format(name, value) for name, value in attributes if value is not None),
        Markup(" require-project-id") if require else "",
        url_for("critiqs.static", filename="element.js"),
        nonce_attribute,
        report,
    )
