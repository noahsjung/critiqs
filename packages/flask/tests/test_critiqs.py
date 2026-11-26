import json
import re

import pytest
from flask import Flask, render_template_string, request

from flask_critiqs import Critiqs

PROJECT = "j12345678901234567890123456789012"
SCRIPT = '<script type="module" src="/_critiqs/element.js"></script>'


@pytest.fixture(autouse=True)
def no_env(monkeypatch):
    monkeypatch.delenv("CRITIQS_PROJECT_ID", raising=False)


def make_app(**config):
    app = Flask(__name__)
    app.config.update(config)
    Critiqs(app)
    return app


def render(app, **context):
    # "/" matches no rule here, so there is no screen to report.
    with app.test_request_context("/"):
        return render_template_string("{{ critiqs() }}", **context)


def page(path, template="{{ critiqs() }}"):
    app = make_app(CRITIQS_PROJECT_ID=PROJECT)
    for rule in ["/", "/users/<int:id>", "/docs/<path:rest>"]:
        app.add_url_rule(rule, rule, lambda **kwargs: render_template_string(f"<body>{template}</body>"))
    return app.test_client().get(path).get_data(as_text=True)


def reported(html):
    match = re.search(r"setContext\((.*)\)\);</script>", html)
    return None if match is None else json.loads(match.group(1))


def test_reports_the_matched_rule_as_the_screen_and_its_variables_as_view_state():
    assert reported(page("/users/42")) == {"screen": "users/:id", "viewState": {"route.id": "42"}}
    assert reported(page("/")) == {"screen": "/", "viewState": {}}
    assert reported(page("/docs/guides/setup")) == {"screen": "docs/:rest*", "viewState": {"route.rest": "guides/setup"}}


def test_server_only_rule_defaults_stay_out_of_the_page():
    app = make_app(CRITIQS_PROJECT_ID=PROJECT)

    @app.route("/items/<int:id>", defaults={"label": "internal-only"})
    def item(id, label):
        return render_template_string("<body>{{ critiqs() }}</body>")

    html = app.test_client().get("/items/7").get_data(as_text=True)
    assert "internal-only" not in html
    assert reported(html) == {"screen": "items/:id", "viewState": {"route.id": "7"}}


def test_undefined_arguments_work_with_strict_undefined():
    from jinja2 import StrictUndefined

    app = make_app(CRITIQS_PROJECT_ID=PROJECT)
    app.jinja_env.undefined = StrictUndefined
    app.add_url_rule("/users/<int:id>", "user", lambda id: render_template_string("<body>{{ critiqs(screen=missing, nonce=missing) }}</body>"))
    response = app.test_client().get("/users/42")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "nonce" not in html
    assert reported(html) == {"screen": "users/:id", "viewState": {"route.id": "42"}}


def test_the_report_runs_once_the_element_is_defined():
    html = page("/users/42")
    assert html.index('src="/_critiqs/element.js"') < html.index('customElements.whenDefined("critiqs-app")')


def test_the_screen_option_replaces_the_rule_and_stays_inside_the_script():
    html = page("/users/42", "{{ critiqs(screen='</script><script>alert(1)') }}")
    assert "</script><script>alert(1)" not in html
    assert reported(html) == {"screen": "</script><script>alert(1)", "viewState": {"route.id": "42"}}


def test_an_empty_or_undefined_screen_falls_back_to_the_rule():
    expected = {"screen": "users/:id", "viewState": {"route.id": "42"}}
    assert reported(page("/users/42", "{{ critiqs(screen='') }}")) == expected
    assert reported(page("/users/42", "{{ critiqs(screen=missing) }}")) == expected


def test_an_empty_or_undefined_nonce_is_left_out():
    html = page("/users/42", "{{ critiqs(nonce=missing) }}{{ critiqs(nonce='') }}")
    assert "nonce" not in html


def test_the_report_does_nothing_when_the_element_is_gone():
    assert 'document.querySelector("critiqs-app")?.setContext(' in page("/users/42")


def test_a_project_id_config_of_none_or_empty_is_unset_even_with_the_variable(monkeypatch):
    monkeypatch.setenv("CRITIQS_PROJECT_ID", PROJECT)
    assert render(make_app(CRITIQS_PROJECT_ID=None)) == ""
    assert render(make_app(CRITIQS_PROJECT_ID="")) == ""


def test_renders_nothing_without_a_project_id():
    assert render(make_app()) == ""


def test_reads_the_project_id_from_the_environment(monkeypatch):
    monkeypatch.setenv("CRITIQS_PROJECT_ID", PROJECT)
    assert render(make_app()) == f'<critiqs-app project-id="{PROJECT}" require-project-id></critiqs-app>{SCRIPT}'


def test_treats_an_empty_variable_as_unset(monkeypatch):
    monkeypatch.setenv("CRITIQS_PROJECT_ID", "")
    assert render(make_app()) == ""


def test_config_names_the_project_backend_and_version(monkeypatch):
    monkeypatch.setenv("CRITIQS_PROJECT_ID", PROJECT)
    app = make_app(CRITIQS_PROJECT_ID="jfromconfig", CRITIQS_BACKEND="https://convex.example", CRITIQS_VERSION="v1.2")
    assert render(app) == (
        '<critiqs-app project-id="jfromconfig" backend="https://convex.example" version="v1.2" require-project-id>'
        f"</critiqs-app>{SCRIPT}"
    )


def test_without_require_project_id_an_app_with_no_project_shows_setup():
    assert render(make_app(CRITIQS_REQUIRE_PROJECT_ID=False)) == f"<critiqs-app></critiqs-app>{SCRIPT}"


def test_escapes_values():
    app = make_app(CRITIQS_PROJECT_ID=PROJECT, CRITIQS_VERSION='"><script>alert(1)</script>')
    assert 'version="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"' in render(app)


def test_init_app_in_an_app_factory():
    extension = Critiqs()
    app = Flask(__name__)
    app.config["CRITIQS_PROJECT_ID"] = PROJECT
    extension.init_app(app)
    assert app.extensions["critiqs"] is extension
    assert f'project-id="{PROJECT}"' in render(app)


def test_the_script_carries_a_nonce():
    app = make_app(CRITIQS_PROJECT_ID=PROJECT)
    with app.test_request_context("/"):
        assert 'element.js" nonce="given"></script>' in render_template_string("{{ critiqs(nonce='given') }}")
        request.csp_nonce = "from-talisman"
        html = render_template_string("{{ critiqs(screen='home') }}")
        assert 'element.js" nonce="from-talisman"></script>' in html
        assert '<script type="module" nonce="from-talisman">customElements' in html


def test_serves_the_browser_bundle(tmp_path, monkeypatch):
    import flask_critiqs

    (tmp_path / "element.js").write_text("customElements.define('critiqs-app', class extends HTMLElement {});")
    monkeypatch.setattr(flask_critiqs.blueprint, "static_folder", str(tmp_path))
    response = make_app().test_client().get("/_critiqs/element.js")
    assert response.status_code == 200
    assert response.mimetype == "text/javascript"
    assert b"critiqs-app" in response.data


def test_renders_outside_a_request_with_the_screen_it_is_given():
    # With SERVER_NAME, url_for works in an app context alone, as for an email or a pre-rendered page.
    app = make_app(CRITIQS_PROJECT_ID=PROJECT, SERVER_NAME="example.com")
    with app.app_context():
        assert reported(render_template_string('{{ critiqs(screen="preview") }}')) == {"screen": "preview", "viewState": {}}
        assert reported(render_template_string("{{ critiqs() }}")) is None
