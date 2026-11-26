import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectApp, FRAMEWORKS } from "../bin/frameworks/index.mjs";
import type { Plan, Settings } from "../bin/frameworks/types.d.mts";

const flask = FRAMEWORKS.find((adapter) => adapter.id === "flask")!;
const PROJECT = "j12345678901234567890123456789012";

// Flask's quickstart application, with a page that extends a base template.
const QUICKSTART = `from flask import Flask, render_template

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")
`;
const BASE = `<!doctype html>
<html lang="en">
  <head>
    <title>{% block title %}{% endblock %} - My app</title>
  </head>
  <body>
    {% block content %}{% endblock %}
  </body>
</html>
`;
const INDEX = `{% extends "base.html" %}
{% block content %}<h1>Hello</h1>{% endblock %}
`;

// The application factory and base template from Flask's tutorial (flaskr).
const FACTORY = `import os

from flask import Flask


def create_app(test_config=None):
    # create and configure the app
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_mapping(
        SECRET_KEY='dev',
        DATABASE=os.path.join(app.instance_path, 'flaskr.sqlite'),
    )

    if test_config is None:
        # load the instance config, if it exists, when not testing
        app.config.from_pyfile('config.py', silent=True)
    else:
        # load the test config if passed in
        app.config.from_mapping(test_config)

    # ensure the instance folder exists
    try:
        os.makedirs(app.instance_path)
    except OSError:
        pass

    from . import db
    db.init_app(app)

    from . import auth
    app.register_blueprint(auth.bp)

    from . import blog
    app.register_blueprint(blog.bp)
    app.add_url_rule('/', endpoint='index')

    return app
`;
const TUTORIAL_BASE = `<!doctype html>
<title>{% block title %}{% endblock %} - Flaskr</title>
<link rel="stylesheet" href="{{ url_for('static', filename='style.css') }}">
<nav>
  <h1>Flaskr</h1>
</nav>
<section class="content">
  <header>
    {% block header %}{% endblock %}
  </header>
  {% block content %}{% endblock %}
</section>
`;

function app(files: Record<string, string | null>) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "critiqs-flask-"));
  for (const [name, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const quickstart = (files: Record<string, string | null> = {}) =>
  app({ "requirements.txt": "Flask==3.1.3\n", "app.py": QUICKSTART, "templates/base.html": BASE, "templates/index.html": INDEX, ...files });
const tutorial = () =>
  app({
    "pyproject.toml": '[project]\nname = "flaskr"\nversion = "1.0.0"\ndependencies = [\n    "flask",\n]\n',
    "flaskr/__init__.py": FACTORY,
    "flaskr/templates/base.html": TUTORIAL_BASE,
    "flaskr/templates/blog/index.html": '{% extends \'base.html\' %}\n',
    "flaskr/templates/auth/login.html": '{% extends \'base.html\' %}\n',
    "tests/conftest.py": "from flaskr import create_app\n",
  });
const read = (root: string, name: string) => readFileSync(join(root, name), "utf8");
const env = (root: string, suffix = ""): Settings => ({ projectId: { env: flask.env(root, suffix)! }, requireProjectId: true });
const options = { entry: null };

function apply(plan: Plan) {
  if (!plan.ok) throw new Error(plan.message);
  for (const write of plan.writes) writeFileSync(write.file, write.source);
  return plan;
}

test("reads the project ID from CRITIQS_PROJECT_ID on each request; .env when python-dotenv loads it", () => {
  expect(flask.env(quickstart(), "")).toMatchObject({ variable: "CRITIQS_PROJECT_ID", expression: 'os.environ.get("CRITIQS_PROJECT_ID")', readsAt: "runtime", localFile: null });
  expect(flask.env(quickstart({ "requirements.txt": "flask\npython-dotenv>=1\n" }), "_WEB")).toMatchObject({ variable: "CRITIQS_PROJECT_ID_WEB", localFile: ".env" });
});

test("adds the extension where the app is created and the call to templates/base.html", () => {
  const root = quickstart();
  const plan = apply(flask.plan(root, env(root), options));
  expect(plan).toMatchObject({ action: "install", file: join(root, "templates/base.html"), line: 8, changed: ["projectId", "requireProjectId"] });
  expect(plan.ok && plan.next.join("\n")).toContain("pip install flask-critiqs");
  expect(read(root, "app.py")).toBe(
    QUICKSTART.replace("render_template\n", "render_template\nfrom flask_critiqs import Critiqs\n").replace("app = Flask(__name__)\n", "app = Flask(__name__)\nCritiqs(app)\n"),
  );
  expect(read(root, "templates/base.html")).toBe(BASE.replace("  </body>", "    {{ critiqs() }}\n  </body>"));
  expect(flask.find(root)).toEqual([
    { file: join(root, "templates/base.html"), line: 8, projectId: { kind: "env", variable: "CRITIQS_PROJECT_ID" }, backend: null, requireProjectId: true },
  ]);
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: true, action: "unchanged", writes: [], changed: [] });
});

test("sets up the tutorial's application factory, whose base template has no </body>", () => {
  const root = tutorial();
  expect(detectApp(root)?.id).toBe("flask");
  apply(flask.plan(root, env(root), options));
  expect(read(root, "flaskr/__init__.py")).toBe(
    FACTORY.replace("from flask import Flask\n", "from flask import Flask\nfrom flask_critiqs import Critiqs\n").replace(
      "    app = Flask(__name__, instance_relative_config=True)\n",
      "    app = Flask(__name__, instance_relative_config=True)\n    Critiqs(app)\n",
    ),
  );
  expect(read(root, "flaskr/templates/base.html")).toBe(`${TUTORIAL_BASE}{{ critiqs() }}\n`);
  expect(flask.plan(root, env(root), options)).toMatchObject({ action: "unchanged" });
});

test("writes a project ID and backend as config in the file's own quotes, then updates them", () => {
  const root = tutorial();
  const settings: Settings = { projectId: { literal: PROJECT }, requireProjectId: true, backend: "https://example.convex.cloud" };
  apply(flask.plan(root, settings, options));
  expect(read(root, "flaskr/__init__.py")).toContain(
    "    app = Flask(__name__, instance_relative_config=True)\n" +
      `    app.config['CRITIQS_PROJECT_ID'] = '${PROJECT}'\n` +
      "    app.config['CRITIQS_BACKEND'] = 'https://example.convex.cloud'\n" +
      "    Critiqs(app)\n",
  );
  expect(flask.find(root)).toMatchObject([{ projectId: { kind: "literal", value: PROJECT }, backend: { kind: "literal", value: "https://example.convex.cloud" } }]);
  expect(flask.plan(root, settings, options)).toMatchObject({ action: "unchanged" });

  const moved = apply(flask.plan(root, { ...env(root), backend: "https://new.convex.cloud" }, options));
  expect(moved).toMatchObject({ action: "update", changed: ["projectId", "backend"] });
  expect(read(root, "flaskr/__init__.py")).toContain(
    "    app = Flask(__name__, instance_relative_config=True)\n    app.config['CRITIQS_BACKEND'] = 'https://new.convex.cloud'\n    Critiqs(app)\n",
  );
  expect(read(root, "flaskr/__init__.py").match(/Critiqs\(app\)/g)).toHaveLength(1);
});

test("a variable for one app of a workspace is read with os.environ", () => {
  const root = quickstart();
  apply(flask.plan(root, env(root, "_WEB"), options));
  expect(read(root, "app.py")).toStartWith(
    'from flask import Flask, render_template\nimport os\nfrom flask_critiqs import Critiqs\n\napp = Flask(__name__)\napp.config["CRITIQS_PROJECT_ID"] = os.environ.get("CRITIQS_PROJECT_ID_WEB")\nCritiqs(app)\n',
  );
  expect(flask.find(root)).toMatchObject([{ projectId: { kind: "env", variable: "CRITIQS_PROJECT_ID_WEB" } }]);
  expect(flask.plan(root, env(root, "_WEB"), options)).toMatchObject({ action: "unchanged" });
});

test("keeps config that already reads the variable", () => {
  const source = QUICKSTART.replace("app = Flask(__name__)\n", 'app = Flask(__name__)\napp.config["CRITIQS_PROJECT_ID"] = os.environ.get("CRITIQS_PROJECT_ID")\n');
  const root = quickstart({ "app.py": `import os\n${source}` });
  const plan = apply(flask.plan(root, env(root), options));
  expect(plan.ok && plan.writes.map((write) => write.file)).toEqual([join(root, "app.py"), join(root, "templates/base.html")]);
  expect(read(root, "app.py")).toContain('app.config["CRITIQS_PROJECT_ID"] = os.environ.get("CRITIQS_PROJECT_ID")\nCritiqs(app)\n');
});

test("turning requireProjectId off and on again", () => {
  const root = quickstart();
  const literal = (requireProjectId: boolean): Settings => ({ projectId: { literal: PROJECT }, requireProjectId });
  apply(flask.plan(root, literal(false), options));
  expect(read(root, "app.py")).toContain('app.config["CRITIQS_REQUIRE_PROJECT_ID"] = False\n');
  expect(flask.find(root)).toMatchObject([{ requireProjectId: false }]);
  expect(apply(flask.plan(root, literal(true), options))).toMatchObject({ action: "update", changed: ["requireProjectId"] });
  expect(read(root, "app.py")).not.toContain("CRITIQS_REQUIRE_PROJECT_ID");
});

test("honours a file the person names", () => {
  const root = quickstart({ "wsgi.py": "from flask import Flask\napplication = Flask(__name__)\n", "templates/layout.html": BASE });
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: false, reason: "ambiguous" });
  apply(flask.plan(root, env(root), { entry: "app.py" }));
  expect(read(root, "wsgi.py")).not.toContain("Critiqs");
  const other = quickstart();
  expect(flask.plan(other, env(other), { entry: "templates/index.html" })).toMatchObject({ ok: false, reason: "unreadable" });
  const named = quickstart({ "templates/layout.html": BASE });
  expect(apply(flask.plan(named, env(named), { entry: "templates/layout.html" }))).toMatchObject({ file: join(named, "templates/layout.html") });
});

const refusals: [string, Record<string, string | null>, string][] = [
  ["an app with no Flask(__name__)", { "app.py": "from flask import Flask\n" }, "manual"],
  ["an app returned without a name", { "app.py": "from flask import Flask\n\ndef create_app():\n    return Flask(__name__)\n" }, "manual"],
  ["settings set some other way", { "app.py": QUICKSTART.replace("app = Flask(__name__)\n", "app = Flask(__name__)\napp.config.update(CRITIQS_BACKEND='x')\n") }, "expression"],
  ["no template other templates extend", { "templates/base.html": null, "templates/index.html": "<body></body>" }, "manual"],
  ["a base template with two </body>", { "templates/base.html": `${BASE}<!-- </body> -->` }, "unreadable"],
  ["Critiqs in two templates", { "templates/index.html": "{{ critiqs() }}", "templates/base.html": BASE.replace("</body>", "{{ critiqs() }}</body>") }, "ambiguous"],
];
test.each(refusals)("refuses %s, with complete instructions", (_, files, reason) => {
  const root = quickstart(files);
  const plan = flask.plan(root, { ...env(root), backend: "https://example.convex.cloud" }, options);
  expect(plan).toMatchObject({ ok: false, reason });
  const message = plan.ok ? "" : plan.message;
  expect(message).toContain("from flask_critiqs import Critiqs");
  expect(message).toContain('app.config["CRITIQS_BACKEND"] = "https://example.convex.cloud"');
  expect(message).toContain("{{ critiqs() }}");
  expect(message).toContain("Set CRITIQS_PROJECT_ID in each deployment's environment");
});

test.each([
  ["requirements.txt", "Flask[async]>=3.1\n"],
  ["requirements/base.txt", "flask==3.1.3  # web\n"],
  ["pyproject.toml", '[project]\ndependencies = ["flask>=3"]\n'],
  ["pyproject.toml", '[tool.poetry.dependencies]\npython = "^3.12"\nflask = "^3.1"\n'],
  ["Pipfile", '[packages]\nflask = "*"\n'],
  ["app.py", QUICKSTART],
])("detects Flask from %s", (name, text) => {
  expect(detectApp(app({ [name]: text }))?.id).toBe("flask");
});

test("an extension alone isn't Flask", () => {
  expect(detectApp(app({ "requirements.txt": "flask-sqlalchemy\n" }))).toBeNull();
});

test("refuses a project ID config it can't read, changing nothing", () => {
  const root = quickstart({ "app.py": QUICKSTART.replace("app = Flask(__name__)\n", 'app = Flask(__name__)\napp.config["CRITIQS_PROJECT_ID"] = get_id()\n') });
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: false, reason: "expression" });
  expect(flask.plan(root, { projectId: { literal: PROJECT }, requireProjectId: true }, options)).toMatchObject({ ok: false, reason: "expression" });
});

test("with only from os import path, import os is added for the variable", () => {
  const root = quickstart({ "app.py": `from os import path\n${QUICKSTART}` });
  apply(flask.plan(root, env(root, "_WEB"), options));
  expect(read(root, "app.py")).toStartWith("from os import path\nfrom flask import Flask, render_template\nimport os\n");
});

// The README's application factory, with the extension made in its own module.
const EXTENSIONS = "from flask_critiqs import Critiqs\n\ncritiqs = Critiqs()\n";
const INIT_APP = FACTORY.replace("    from . import db\n", "    from .extensions import critiqs\n    critiqs.init_app(app)\n\n    from . import db\n");

test("an app factory that already calls critiqs.init_app(app) isn't registered twice", () => {
  const root = tutorial();
  writeFileSync(join(root, "flaskr/extensions.py"), EXTENSIONS);
  writeFileSync(join(root, "flaskr/__init__.py"), INIT_APP);
  const plan = apply(flask.plan(root, env(root), options));
  expect(plan.ok && plan.writes.map((write) => write.file)).toEqual([join(root, "flaskr/templates/base.html")]);
  expect(read(root, "flaskr/__init__.py")).toBe(INIT_APP);
});

test("uses the app's own template_folder", () => {
  const root = quickstart({
    "app.py": QUICKSTART.replace("Flask(__name__)", 'Flask(__name__, template_folder="views")'),
    "templates/base.html": null,
    "templates/index.html": null,
    "views/base.html": BASE,
    "views/index.html": INDEX,
  });
  expect(apply(flask.plan(root, env(root), options))).toMatchObject({ action: "install", file: join(root, "views/base.html") });
  expect(read(root, "views/base.html")).toContain("{{ critiqs() }}");
  expect(flask.find(root)).toMatchObject([{ file: join(root, "views/base.html") }]);
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: true, action: "unchanged" });
});

test("only the app's own template_folder is searched when it sets one", () => {
  const stale = BASE.replace("</body>", "  {{ critiqs() }}\n  </body>");
  const root = quickstart({
    "app.py": QUICKSTART.replace("Flask(__name__)", 'Flask(__name__, template_folder="views")'),
    "templates/base.html": stale,
    "views/base.html": BASE,
    "views/index.html": INDEX,
  });
  expect(flask.find(root)).toEqual([]);
  expect(apply(flask.plan(root, env(root), options))).toMatchObject({ action: "install", file: join(root, "views/base.html") });
  expect(read(root, "views/base.html")).toContain("{{ critiqs() }}");
  expect(read(root, "templates/base.html")).toBe(stale);
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: true, action: "unchanged" });
});

test.each([
  ["a comment", "# Critiqs(app)\n"],
  ["a string", 'NOTE = "Critiqs(app)"\n'],
  ["a commented init_app", "# critiqs.init_app(app)\n"],
])("Critiqs(app) in %s isn't a registration", (_, line) => {
  const root = quickstart({ "app.py": `${QUICKSTART}\n${line}` });
  apply(flask.plan(root, env(root), options));
  const source = read(root, "app.py");
  expect(source).toContain("app = Flask(__name__)\nCritiqs(app)\n");
  expect(source.match(/^from flask_critiqs import Critiqs$/gm)).toHaveLength(1);
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: true, action: "unchanged" });
});

test("an existing import of the extension isn't repeated when setup adds Critiqs(app)", () => {
  const root = quickstart({ "app.py": `from flask_critiqs import Critiqs\n${QUICKSTART}` });
  apply(flask.plan(root, env(root), options));
  expect(read(root, "app.py").match(/flask_critiqs/g)).toHaveLength(1);
  expect(read(root, "app.py")).toContain("app = Flask(__name__)\nCritiqs(app)\n");
});

/** Python's own parser's verdict on `source`: true, or its error. */
function parses(source: string) {
  const run = Bun.spawnSync(["python3", "-I", "-c", "import ast,sys; ast.parse(sys.stdin.buffer.read())"], { stdin: new TextEncoder().encode(source) });
  return run.exitCode === 0 || run.stderr.toString();
}

test("adds import os after an import continued with a backslash in a file with CRLF line endings", () => {
  const crlf = QUICKSTART.replace("from flask import Flask, render_template\n", "from flask import Flask, \\\n    render_template\n").replaceAll("\n", "\r\n");
  const root = quickstart({ "app.py": crlf });
  const settings = { ...env(root, "_WEB"), requireProjectId: false };
  apply(flask.plan(root, settings, options));
  const source = read(root, "app.py");
  expect(parses(source)).toBe(true);
  expect(source).toContain("from flask import Flask, \\\r\n    render_template\r\nimport os\r\nfrom flask_critiqs import Critiqs\r\n");
  expect(source).not.toMatch(/[^\r]\n/);
  expect(flask.find(root)).toMatchObject([{ projectId: { kind: "env", variable: "CRITIQS_PROJECT_ID_WEB" }, requireProjectId: false }]);
  expect(flask.plan(root, settings, options)).toMatchObject({ action: "unchanged" });

  // Turning requireProjectId back on removes its line whole.
  apply(flask.plan(root, { ...settings, requireProjectId: true }, options));
  expect(parses(read(root, "app.py"))).toBe(true);
  expect(read(root, "app.py")).toContain('app = Flask(__name__)\r\napp.config["CRITIQS_PROJECT_ID"] = os.environ.get("CRITIQS_PROJECT_ID_WEB")\r\nCritiqs(app)\r\n');
});

// Stand-ins for flask and flask_critiqs, so Python can run a written app and say whether it registers the extension.
const STUBS = {
  "flask/__init__.py": `class Config(dict):
    def from_mapping(self, *args, **kwargs): pass

class Flask:
    def __init__(self, name, **kwargs):
        self.config = Config()
        self.extensions = {}
        self.blueprints = []
    def route(self, *args, **kwargs): return lambda view: view
    def register_blueprint(self, blueprint, **kwargs): self.blueprints.append(blueprint)

class Blueprint:
    def __init__(self, *args, **kwargs): pass
    def route(self, *args, **kwargs): return lambda view: view

def render_template(*args, **kwargs): return ""
`,
  "flask_critiqs/__init__.py": `class Critiqs:
    def __init__(self, app=None):
        if app is not None:
            self.init_app(app)
    def init_app(self, app):
        app.extensions.setdefault("critiqs", []).append(self)
`,
};

/** Imports `module` from `root` (calling create_app() when it has one) and returns how many times the app registered Critiqs, or Python's error. */
function registrations(root: string, module: string) {
  const stubs = app(STUBS);
  const script = `import importlib, sys
sys.path[:0] = [sys.argv[1], sys.argv[2]]
module = importlib.import_module(sys.argv[3])
app = module.create_app() if hasattr(module, "create_app") else module.app
print(len(app.extensions.get("critiqs", [])))`;
  const run = Bun.spawnSync(["python3", "-I", "-B", "-c", script, stubs, root, module]);
  return run.exitCode === 0 ? Number(run.stdout.toString()) : run.stderr.toString();
}

test.each([
  ["an aliased import", "from flask_critiqs import Critiqs as Feedback\n", "Feedback(app)"],
  ["a parenthesised aliased import", "from flask_critiqs import (\n    Critiqs as Feedback,\n)\n", "Feedback(app)"],
  ["an import of the module", "import flask_critiqs\n", "flask_critiqs.Critiqs(app)"],
  ["an aliased import of the module", "import flask_critiqs as fc\n", "fc.Critiqs(app)"],
])("with %s of the extension, setup constructs it by the name the file binds", (_, imports, call) => {
  const root = quickstart({ "app.py": `${imports}${QUICKSTART}` });
  expect(registrations(root, "app")).toBe(0);
  apply(flask.plan(root, env(root), options));
  const source = read(root, "app.py");
  expect(source).toContain(`app = Flask(__name__)\n${call}\n`);
  expect(source.match(/^(?:from|import) flask_critiqs\b/gm)).toHaveLength(1);
  expect(registrations(root, "app")).toBe(1);
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: true, action: "unchanged" });
});

test("a later import of the extension inside a function isn't counted as binding the name", () => {
  const root = quickstart({ "app.py": `${QUICKSTART}\n\ndef later():\n    from flask_critiqs import Critiqs as Feedback\n    return Feedback\n` });
  apply(flask.plan(root, env(root), options));
  expect(read(root, "app.py")).toContain("app = Flask(__name__)\nCritiqs(app)\n");
  expect(registrations(root, "app")).toBe(1);
});

test.each([
  ["made before the app", "from flask_critiqs import Critiqs\n\ncritiqs = Critiqs()\n" + QUICKSTART, "app = Flask(__name__)\ncritiqs.init_app(app)\n"],
  ["made right after the app", "from flask_critiqs import Critiqs\n" + QUICKSTART.replace("app = Flask(__name__)\n", "app = Flask(__name__)\ncritiqs = Critiqs()\n"), "critiqs = Critiqs()\ncritiqs.init_app(app)\n"],
  ["made under an aliased name", "from flask_critiqs import Critiqs as Feedback\n\nfeedback = Feedback()\n" + QUICKSTART, "app = Flask(__name__)\nfeedback.init_app(app)\n"],
])("an extension %s without the app is registered with init_app", (_, source, expected) => {
  const root = quickstart({ "app.py": source });
  expect(registrations(root, "app")).toBe(0);
  apply(flask.plan(root, env(root), options));
  expect(read(root, "app.py")).toContain(expected);
  expect(read(root, "app.py")).not.toContain("Critiqs(app)");
  expect(registrations(root, "app")).toBe(1);
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: true, action: "unchanged" });
});

// A small application factory with the extension made in its own module, as the README shows.
const SMALL_FACTORY = `from flask import Flask

from .extensions import critiqs


def create_app():
    app = Flask(__name__)
    return app
`;

test("an app factory that imports the extension's instance but never registers it gets critiqs.init_app(app)", () => {
  const root = app({ "requirements.txt": "flask\n", "shop/__init__.py": SMALL_FACTORY, "shop/extensions.py": EXTENSIONS, "shop/templates/base.html": BASE });
  expect(registrations(root, "shop")).toBe(0);
  apply(flask.plan(root, env(root), options));
  expect(read(root, "shop/__init__.py")).toBe(SMALL_FACTORY.replace("    app = Flask(__name__)\n", "    app = Flask(__name__)\n    critiqs.init_app(app)\n"));
  expect(registrations(root, "shop")).toBe(1);
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: true, action: "unchanged" });
});

test("an imported instance, under any name, registered with init_app isn't registered again", () => {
  const source = SMALL_FACTORY.replace("import critiqs\n", "import critiqs as feedback\n").replace("    return app\n", "    feedback.init_app(app)\n    return app\n");
  const root = app({ "requirements.txt": "flask\n", "shop/__init__.py": source, "shop/extensions.py": EXTENSIONS, "shop/templates/base.html": BASE });
  const plan = apply(flask.plan(root, env(root), options));
  expect(plan.ok && plan.writes.map((write) => write.file)).toEqual([join(root, "shop/templates/base.html")]);
  expect(registrations(root, "shop")).toBe(1);
});

test("an instance imported after the app is made, in the same block, is registered after the import", () => {
  const source = SMALL_FACTORY.replace("from .extensions import critiqs\n", "").replace("    app = Flask(__name__)\n", "    app = Flask(__name__)\n    from .extensions import critiqs\n");
  const root = app({ "requirements.txt": "flask\n", "shop/__init__.py": source, "shop/extensions.py": EXTENSIONS, "shop/templates/base.html": BASE });
  apply(flask.plan(root, env(root), options));
  expect(read(root, "shop/__init__.py")).toContain("    from .extensions import critiqs\n    critiqs.init_app(app)\n    return app\n");
  expect(registrations(root, "shop")).toBe(1);
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: true, action: "unchanged" });
});

test.each([
  ["an instance imported only in another function", SMALL_FACTORY.replace("from .extensions import critiqs\n", "") + "\n\ndef later():\n    from .extensions import critiqs\n    return critiqs\n"],
  ["an instance setup can't trace", SMALL_FACTORY.replace("from .extensions import critiqs\n", "from .extensions import make\n").replace("    return app\n", "    make().init_app(app)\n    return app\n")],
])("refuses %s, changing nothing", (_, source) => {
  const root = app({ "requirements.txt": "flask\n", "shop/__init__.py": source, "shop/extensions.py": `${EXTENSIONS}\ndef make():\n    return critiqs\n`, "shop/templates/base.html": BASE });
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: false, reason: "ambiguous" });
});

// An app with its own template_folder and a blueprint with its own templates, whose pages extend the app's base.
const STORE = `from flask import Blueprint, render_template

bp = Blueprint("store", __name__, template_folder="store_views")


@bp.route("/store")
def index():
    return render_template("store/index.html")
`;
const SITE = `from flask import Flask
from flask_critiqs import Critiqs

from store import bp

app = Flask(__name__, template_folder="site_views")
Critiqs(app)
app.register_blueprint(bp)
`;
const STORE_INDEX = `{% extends "base.html" %}
{% block content %}<h1>Store</h1>{{ critiqs() }}{% endblock %}
`;

test("a call in a registered blueprint's own template folder is the existing one", () => {
  const root = app({ "requirements.txt": "flask\n", "app.py": SITE, "store/__init__.py": STORE, "store/store_views/store/index.html": STORE_INDEX, "site_views/base.html": BASE, "site_views/index.html": INDEX });
  expect(flask.find(root)).toMatchObject([{ file: join(root, "store/store_views/store/index.html"), line: 2 }]);
  const plan = flask.plan(root, env(root), options);
  expect(plan).toMatchObject({ ok: true, action: "unchanged", writes: [] });
  expect(read(root, "site_views/base.html")).toBe(BASE);
});

test("refuses a call in a blueprint folder setup can't tie to the app", () => {
  const root = app({
    "requirements.txt": "flask\n",
    "app.py": SITE.replace("from store import bp\n", "from store import register\n").replace("app.register_blueprint(bp)\n", "register(app)\n"),
    "store/__init__.py": `${STORE}\n\ndef register(app):\n    app.register_blueprint(bp)\n`,
    "store/store_views/store/index.html": STORE_INDEX,
    "site_views/base.html": BASE,
    "site_views/index.html": INDEX,
  });
  expect(flask.plan(root, env(root), options)).toMatchObject({ ok: false, reason: "ambiguous" });
  expect(read(root, "site_views/base.html")).toBe(BASE);
});
