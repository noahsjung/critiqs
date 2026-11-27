import json
import os
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


# On this computer `npx critiqs init` writes CRITIQS_PROJECT_ID to .env. The
# extension reads that one key there itself, only for Flask's development server.

DEV_SERVER = {"SERVER_SOFTWARE": "Werkzeug/3.1.0"}
OTHER_KEYS = ("DATABASE_URL", "FLASK_DEBUG", "GREETING")
ENV_FILE = f"DATABASE_URL=postgres://db:5432/app\nFLASK_DEBUG=1\nGREETING=hello\nCRITIQS_PROJECT_ID={PROJECT}\n"
SHOWN = f'<critiqs-app project-id="{PROJECT}" require-project-id>'


@pytest.fixture
def app_folder(tmp_path, monkeypatch):
    """A working directory holding the app's .env, with none of its keys in the environment."""
    for key in (*OTHER_KEYS, "FLASK_SKIP_DOTENV"):
        monkeypatch.delenv(key, raising=False)
    (tmp_path / ".env").write_text(ENV_FILE)
    monkeypatch.chdir(tmp_path)
    return tmp_path


def served(environ_base, template="<body>{{ critiqs() }}</body>"):
    app = make_app()
    app.add_url_rule("/", "home", lambda: render_template_string(template))
    return app.test_client().get("/", environ_base=environ_base).get_data(as_text=True)


def test_the_development_server_reads_the_project_id_from_env_and_nothing_else(app_folder):
    import threading
    import urllib.request

    from werkzeug.serving import make_server

    app = make_app()
    app.add_url_rule("/", "home", lambda: render_template_string("<body>{{ critiqs() }}</body>"))
    app.add_url_rule("/env", "env", lambda: json.dumps({key: os.environ.get(key) for key in (*OTHER_KEYS, "CRITIQS_PROJECT_ID")}))
    # The server `flask run` and app.run() start.
    server = make_server("127.0.0.1", 0, app)
    port = server.server_port
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        home = urllib.request.urlopen(f"http://127.0.0.1:{port}/").read().decode()
        seen = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/env").read())
    finally:
        server.shutdown()
        thread.join()
    assert SHOWN in home
    # The app's other .env keys, and Critiqs's own, stay out of its environment.
    assert seen == {key: None for key in (*OTHER_KEYS, "CRITIQS_PROJECT_ID")}
    assert all(key not in os.environ for key in (*OTHER_KEYS, "CRITIQS_PROJECT_ID"))


def test_production_servers_never_read_env(app_folder):
    for software in ("gunicorn/23.0.0", "waitress", None):
        assert served({} if software is None else {"SERVER_SOFTWARE": software}) == "<body></body>"
    assert all(key not in os.environ for key in OTHER_KEYS)


def test_an_environment_variable_wins_over_env(app_folder, monkeypatch):
    other = "j99999999999999999999999999999999"
    monkeypatch.setenv("CRITIQS_PROJECT_ID", other)
    assert f'project-id="{other}"' in served(DEV_SERVER)
    # An empty variable means no project, as when python-dotenv loads .env.
    monkeypatch.setenv("CRITIQS_PROJECT_ID", "")
    assert served(DEV_SERVER) == "<body></body>"


def test_the_config_wins_over_env(app_folder):
    app = make_app(CRITIQS_PROJECT_ID=None)
    app.add_url_rule("/", "home", lambda: render_template_string("<body>{{ critiqs() }}</body>"))
    assert app.test_client().get("/", environ_base=DEV_SERVER).get_data(as_text=True) == "<body></body>"


def test_flask_skip_dotenv_turns_it_off(app_folder, monkeypatch):
    monkeypatch.setenv("FLASK_SKIP_DOTENV", "1")
    assert served(DEV_SERVER) == "<body></body>"


def test_finds_env_above_the_working_directory_as_flask_run_does(app_folder, monkeypatch):
    (app_folder / "src").mkdir()
    monkeypatch.chdir(app_folder / "src")
    assert SHOWN in served(DEV_SERVER)


@pytest.mark.parametrize(
    "line",
    [f"CRITIQS_PROJECT_ID={PROJECT}", f'export CRITIQS_PROJECT_ID="{PROJECT}"', f"CRITIQS_PROJECT_ID = '{PROJECT}'  # Critiqs", f"CRITIQS_PROJECT_ID={PROJECT} # set by init"],
)
def test_reads_the_forms_a_env_file_writes(app_folder, line):
    (app_folder / ".env").write_text(f"# Critiqs\nCRITIQS_PROJECT_ID_WEB=other\n{line}\n")
    assert SHOWN in served(DEV_SERVER)


def test_a_byte_order_mark_does_not_hide_the_first_line(app_folder):
    (app_folder / ".env").write_bytes(b"\xef\xbb\xbf" + f"CRITIQS_PROJECT_ID={PROJECT}\n".encode())
    assert SHOWN in served(DEV_SERVER)


def test_a_deleted_working_directory_means_no_project_not_an_error(app_folder, monkeypatch):
    gone = app_folder / "gone"
    gone.mkdir()
    monkeypatch.chdir(gone)
    gone.rmdir()
    assert served(DEV_SERVER) == "<body></body>"


def test_no_env_file_or_no_key_means_no_project(app_folder):
    (app_folder / ".env").write_text("DATABASE_URL=postgres://db:5432/app\nCRITIQS_PROJECT_ID_WEB=other\n")
    assert served(DEV_SERVER) == "<body></body>"
    (app_folder / ".env").unlink()
    assert served(DEV_SERVER) == "<body></body>"
