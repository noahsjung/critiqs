import json
import re

from django import template
from django.templatetags.static import static
from django.urls import get_resolver
from django.utils.html import format_html, format_html_join
from django.utils.safestring import mark_safe

from ..conf import _text, read_settings

try:  # Django 6.0 and later: the built-in Content Security Policy support.
    from django.middleware.csp import get_nonce
except ImportError:  # Django 5.2
    get_nonce = None

register = template.Library()

# A path() parameter, such as <int:id>, as Django's own pattern reads it, so a
# custom converter's name may hold any character but > and :. <path:…> spans segments.
CONVERTER = re.compile(r"<(?:([^>:]+):)?([^>]+)>")


def _nonce(context):
    nonce = _text(context.get("csp_nonce"))
    request = context.get("request")
    if nonce is None and request is not None:
        nonce = _text(get_nonce(request)) if get_nonce is not None else None
        # django-csp keeps its nonce on the request.
        nonce = nonce if nonce is not None else _text(getattr(request, "csp_nonce", None))
    return nonce


def _captured(request, match):
    """Every parameter the URL captured, at every level of include(). Django's
    own captured_kwargs holds only the last pattern's, and its kwargs mix in
    each level's extra kwargs, so this matches the path again along the chain
    of patterns that resolved it (the last entry of `tried`), deeper levels
    winning as they do in Django."""
    if not match.tried:
        return match.captured_kwargs
    found = get_resolver(getattr(request, "urlconf", None)).pattern.match(request.path_info)
    captured = {}
    for pattern in match.tried[-1]:
        found = pattern.pattern.match(found[0]) if found is not None else None
        if found is None:
            return match.captured_kwargs
        captured.update(found[2])
    return captured


def route_context(request, screen=None):
    """The view this page shows, in Critiqs's route convention: the screen is
    the matched path() pattern in :name form (users/<int:id>/ -> users/:id,
    the root -> /), and its parameters are view state keys route.<name>.
    `screen` replaces the pattern unless it is empty. None when there is neither.
    Only parameters the URL captured are reported, at every level of include(),
    never the extra kwargs path() or include() pass at any level."""
    screen = _text(screen)
    match = getattr(request, "resolver_match", None)
    params = {f"route.{name}": str(value) for name, value in (_captured(request, match) if match else {}).items()}
    if screen is None and match is not None and match.route is not None and not re.search(r"[\^$()\[\]\\?*+|]", match.route):
        pattern = CONVERTER.sub(lambda m: f":{m.group(2)}{'*' if m.group(1) == 'path' else ''}", match.route)
        screen = pattern.strip("/") or "/"
    if screen is None:
        return None
    return {"screen": screen, "viewState": params}


def _json(value):
    # Safe inside <script>: no </script>, <!--, or & can end or change it.
    return json.dumps(value).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


@register.simple_tag(takes_context=True)
def critiqs(context, screen=None):
    """<critiqs-app> with this site's settings and the script that defines it,
    then a script that reports this page's screen; nothing when a project ID
    is required and none is set."""
    config = read_settings()
    if config.require_project_id and config.project_id is None:
        return ""
    attributes = [("project-id", config.project_id), ("backend", config.backend), ("version", config.version)]
    nonce = _nonce(context)
    nonce_attribute = format_html(' nonce="{}"', nonce) if nonce is not None else ""
    view = route_context(context.get("request"), screen)
    report = (
        format_html(
            '<script type="module"{}>customElements.whenDefined("critiqs-app").then(() => document.querySelector("critiqs-app")?.setContext({}));</script>',
            nonce_attribute,
            mark_safe(_json(view)),
        )
        if view is not None
        else ""
    )
    return format_html(
        '<critiqs-app{}{}></critiqs-app><script type="module" src="{}"{}></script>{}',
        format_html_join("", ' {}="{}"', ((name, value) for name, value in attributes if value is not None)),
        mark_safe(" require-project-id") if config.require_project_id else "",
        static("critiqs/element.js"),
        nonce_attribute,
        report,
    )
