import json
import re

import django
import pytest
from django.core import checks
from django.template import engines
from django.test import Client, override_settings

PROJECT = "j12345678901234567890123456789012"
SCRIPT = '<script type="module" src="/static/critiqs/element.js"></script>'


def render(context=None):
    return engines["django"].from_string("{% load critiqs %}{% critiqs %}").render(context or {})


@pytest.fixture(autouse=True)
def no_env(monkeypatch):
    monkeypatch.delenv("CRITIQS_PROJECT_ID", raising=False)


def test_renders_nothing_without_a_project_id():
    assert render() == ""


def test_reads_the_project_id_from_the_environment(monkeypatch):
    monkeypatch.setenv("CRITIQS_PROJECT_ID", PROJECT)
    assert render() == f'<critiqs-app project-id="{PROJECT}" require-project-id></critiqs-app>{SCRIPT}'


def test_treats_an_empty_variable_as_unset(monkeypatch):
    monkeypatch.setenv("CRITIQS_PROJECT_ID", "")
    assert render() == ""


@override_settings(CRITIQS={"PROJECT_ID": "jfromsettings", "BACKEND": "https://convex.example", "VERSION": "v1.2"})
def test_settings_name_the_project_backend_and_version(monkeypatch):
    monkeypatch.setenv("CRITIQS_PROJECT_ID", PROJECT)
    assert render() == (
        '<critiqs-app project-id="jfromsettings" backend="https://convex.example" version="v1.2" require-project-id>'
        f"</critiqs-app>{SCRIPT}"
    )


@override_settings(CRITIQS={"PROJECT_ID": None})
def test_a_project_id_setting_of_none_is_unset_even_with_the_variable(monkeypatch):
    monkeypatch.setenv("CRITIQS_PROJECT_ID", PROJECT)
    assert render() == ""


@override_settings(CRITIQS={"REQUIRE_PROJECT_ID": False})
def test_without_require_project_id_an_app_with_no_project_shows_setup():
    assert render() == f"<critiqs-app></critiqs-app>{SCRIPT}"


@override_settings(CRITIQS={"PROJECT_ID": PROJECT, "VERSION": '"><script>alert(1)</script>'})
def test_escapes_values():
    assert 'version="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"' in render()


@override_settings(STATIC_URL="https://cdn.example/assets/", CRITIQS={"PROJECT_ID": PROJECT})
def test_loads_the_bundle_from_static_files():
    assert 'src="https://cdn.example/assets/critiqs/element.js"' in render()


@override_settings(CRITIQS={"PROJECT_ID": PROJECT})
def test_uses_the_csp_nonce_in_the_context():
    assert f'{SCRIPT[:-10]} nonce="abc123"></script>' in render({"csp_nonce": "abc123"})


@override_settings(CRITIQS={"PROJECT_ID": PROJECT})
def test_an_empty_nonce_is_left_out():
    assert "nonce" not in render({"csp_nonce": ""})


@pytest.mark.skipif(django.VERSION < (6, 0), reason="Django's own CSP support arrived in 6.0")
def test_the_script_carries_the_nonce_djangos_csp_middleware_sends():
    from django.utils.csp import CSP

    with override_settings(
        CRITIQS={"PROJECT_ID": PROJECT},
        MIDDLEWARE=["django.middleware.csp.ContentSecurityPolicyMiddleware"],
        SECURE_CSP={"script-src": [CSP.SELF, CSP.NONCE]},
    ):
        response = Client().get("/")
    header = re.search(r"'nonce-([^']+)'", response.headers["Content-Security-Policy"]).group(1)
    # Both scripts: the bundle and the inline one that reports the screen.
    assert response.content.decode().count(f'nonce="{header}"') == 2


def page(path, **query):
    with override_settings(CRITIQS={"PROJECT_ID": PROJECT}):
        return Client().get(path, query).content.decode()


def reported(html):
    match = re.search(r"setContext\((.*)\)\);</script>", html)
    return None if match is None else json.loads(match.group(1))


def test_reports_the_matched_route_as_the_screen_and_its_parameters_as_view_state():
    assert reported(page("/users/42/")) == {"screen": "users/:id", "viewState": {"route.id": "42"}}
    assert reported(page("/")) == {"screen": "/", "viewState": {}}
    assert reported(page("/docs/guides/setup")) == {"screen": "docs/:rest*", "viewState": {"route.rest": "guides/setup"}}


def test_a_custom_converter_with_a_hyphen_reports_its_pattern():
    assert reported(page("/items/7/")) == {"screen": "items/:id", "viewState": {"route.id": "7"}}


def test_extra_arguments_from_urls_py_stay_out_of_the_page():
    html = page("/teams/3/")
    assert "do-not-publish" not in html
    assert reported(html) == {"screen": "teams/:id", "viewState": {"route.id": "3"}}


def test_parameters_captured_by_include_prefixes_are_reported_without_any_levels_extra_kwargs():
    html = page("/orgs/acme/teams/5/items/42/")
    assert "do-not-publish" not in html
    assert reported(html) == {
        "screen": "orgs/:org/teams/:team/items/:id",
        "viewState": {"route.org": "acme", "route.team": "5", "route.id": "42"},
    }


def test_an_empty_screen_falls_back_to_the_route():
    template = "{% load critiqs %}{% critiqs screen=missing %}"
    assert reported(page("/users/42/", template=template)) == {"screen": "users/:id", "viewState": {"route.id": "42"}}
    template = '{% load critiqs %}{% critiqs screen="" %}'
    assert reported(page("/users/42/", template=template)) == {"screen": "users/:id", "viewState": {"route.id": "42"}}


def test_the_report_does_nothing_when_the_element_is_gone():
    assert 'document.querySelector("critiqs-app")?.setContext(' in page("/users/42/")


def test_the_report_runs_once_the_element_is_defined():
    html = page("/users/42/")
    assert html.index('src="/static/critiqs/element.js"') < html.index('customElements.whenDefined("critiqs-app")')


def test_a_regular_expression_route_reports_only_its_parameters_with_a_screen_given():
    assert reported(page("/archive/2026/")) is None
    template = '{% load critiqs %}{% critiqs screen="archive/:year" %}'
    assert reported(page("/archive/2026/", template=template)) == {"screen": "archive/:year", "viewState": {"route.year": "2026"}}


def test_the_screen_option_replaces_the_pattern_and_stays_inside_the_script():
    template = '{% load critiqs %}{% critiqs screen="</script><script>alert(1)" %}'
    html = page("/users/42/", template=template)
    assert "</script><script>alert(1)" not in html
    assert reported(html) == {"screen": "</script><script>alert(1)", "viewState": {"route.id": "42"}}


@override_settings(CRITIQS={"PROJECT_ID": PROJECT, "PROJECTID": "typo"})
def test_warns_about_unknown_keys():
    messages = checks.run_checks()
    assert [message.id for message in messages] == ["django_critiqs.W001"]
    assert "'PROJECTID'" in messages[0].msg


@override_settings(CRITIQS=[("PROJECT_ID", PROJECT)])
def test_rejects_settings_that_are_not_a_dict():
    assert [message.id for message in checks.run_checks()] == ["django_critiqs.E001"]
