"""Critiqs's settings: the CRITIQS dict in Django settings, with the project
ID read from the CRITIQS_PROJECT_ID environment variable when the dict doesn't
name one."""

import os
from dataclasses import dataclass

from django.conf import settings
from django.core import checks

ENV_VARIABLE = "CRITIQS_PROJECT_ID"
KEYS = {"PROJECT_ID", "REQUIRE_PROJECT_ID", "BACKEND", "VERSION"}


@dataclass(frozen=True)
class CritiqsSettings:
    # None renders nothing when required, and project setup otherwise.
    project_id: str | None
    require_project_id: bool
    backend: str | None
    version: str | None


def _text(value):
    return None if value is None or str(value) == "" else str(value)


def read_settings():
    configured = getattr(settings, "CRITIQS", None) or {}
    project_id = configured["PROJECT_ID"] if "PROJECT_ID" in configured else os.environ.get(ENV_VARIABLE)
    return CritiqsSettings(
        project_id=_text(project_id),
        require_project_id=bool(configured.get("REQUIRE_PROJECT_ID", True)),
        backend=_text(configured.get("BACKEND")),
        version=_text(configured.get("VERSION")),
    )


def check_settings(app_configs=None, **kwargs):
    configured = getattr(settings, "CRITIQS", None)
    if configured is None:
        return []
    if not isinstance(configured, dict):
        return [checks.Error("CRITIQS must be a dict.", id="django_critiqs.E001")]
    return [
        checks.Warning(
            f"CRITIQS has an unknown key {key!r}.",
            hint=f"Critiqs reads {', '.join(sorted(KEYS))}.",
            id="django_critiqs.W001",
        )
        for key in sorted(set(configured) - KEYS, key=str)
    ]
