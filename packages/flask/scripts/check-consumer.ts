// A real Flask app: the quickstart application with a home page and an item
// page (/items/<int:id>) that extend a base template, the built flask-critiqs wheel installed in a fresh virtual
// environment, and Critiqs added by the setup adapter's plan, served by
// Waitress as in production. With CRITIQS_PROJECT_ID set, Chrome checks that
// Critiqs's toolbar appears on both pages and that each reports its route; with
// it unset, the page carries no Critiqs at all. Then, as `npx critiqs init`
// leaves it on a developer's computer, the ID is in the app's own .env beside
// keys the app never loaded: `flask run` shows Critiqs and leaves those keys
// unset, and Waitress reads nothing from .env.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { FRAMEWORKS } from "../../critiqs/bin/frameworks/index.mjs";
import { expectToolbar, fakeBackend, PROJECT, scratch, waitForServer } from "../../../scripts/consumer-kit.ts";
import { packedFile } from "../../../scripts/package-tarball.ts";
import { PACKAGE, release, venv } from "./tasks.ts";

const flask = FRAMEWORKS.find((adapter) => adapter.id === "flask")!;
// The release's built wheel when CRITIQS_PACKED is set; otherwise one built here.
const wheel = packedFile("pypi", "flask-critiqs", (await Bun.file(join(PACKAGE, "package.json")).json()).version) ?? await release();
const dir = await scratch("flask");
await venv(join(dir, "venv"), [wheel, "waitress"]);
const root = join(dir, "app");
await mkdir(join(root, "templates"), { recursive: true });
await writeFile(join(root, "requirements.txt"), "Flask\nflask-critiqs\nwaitress\n");
await writeFile(
  join(root, "app.py"),
  'from flask import Flask, render_template\n\napp = Flask(__name__)\n\n\n@app.route("/")\ndef index():\n    return render_template("index.html")\n\n\n@app.route("/items/<int:id>")\ndef item(id):\n    return render_template("item.html", id=id)\n\n\n@app.route("/env")\ndef env():\n    import os\n\n    return {"loaded": sorted(key for key in os.environ if key in ("DATABASE_URL", "FLASK_DEBUG") or key.startswith("CRITIQS"))}\n',
);
await writeFile(
  join(root, "templates/base.html"),
  '<!doctype html>\n<html lang="en">\n  <head>\n    <title>{% block title %}{% endblock %} - My app</title>\n  </head>\n  <body>\n    {% block content %}{% endblock %}\n  </body>\n</html>\n',
);
await writeFile(join(root, "templates/index.html"), '{% extends "base.html" %}\n{% block content %}<h1>A Flask page</h1>{% endblock %}\n');
await writeFile(join(root, "templates/item.html"), '{% extends "base.html" %}\n{% block content %}<h1>Item {{ id }}</h1>{% endblock %}\n');

const backend = fakeBackend();
const settings = { projectId: { env: flask.env(root, "")! }, requireProjectId: true, backend: backend.url };
const plan = flask.plan(root, settings, { entry: null });
if (!plan.ok) throw new Error(plan.message);
assert.equal(plan.action, "install");
for (const write of plan.writes) await writeFile(write.file, write.source);
const again = flask.plan(root, settings, { entry: null });
assert.equal(again.ok && again.action, "unchanged");
console.log(plan.preview);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Serves the app with Waitress, or with `flask run`, and `env` until `check` finishes. */
async function serve<T>(env: Record<string, string | undefined>, check: (url: string) => Promise<T>, server: "waitress" | "flask run" = "waitress"): Promise<T> {
  const port = await freePort();
  const command =
    server === "waitress"
      ? [join(dir, "venv/bin/waitress-serve"), `--listen=127.0.0.1:${port}`, "app:app"]
      : [join(dir, "venv/bin/flask"), "--app", "app", "run", "--host", "127.0.0.1", "--port", String(port)];
  const child = Bun.spawn(command, { cwd: root, env, stdout: "ignore", stderr: "pipe" });
  try {
    await waitForServer(`http://127.0.0.1:${port}/`);
    return await check(`http://127.0.0.1:${port}/`);
  } finally {
    child.kill();
    await child.exited;
  }
}

try {
  const [configured, item, itemPage] = await serve({ ...process.env, CRITIQS_PROJECT_ID: PROJECT }, async (url) => [
    await expectToolbar(url, "flask"),
    await expectToolbar(`${url}items/7`, "flask-item"),
    await (await fetch(`${url}items/7`)).text(),
  ] as const);
  for (const result of [configured, item]) {
    assert.deepEqual(result.errors, []);
    assert.doesNotMatch(result.toolbar, /Set up Critiqs/);
  }
  assert.match(itemPage, /setContext\(\{"screen": "items\/:id", "viewState": \{"route\.id": "7"\}\}\)/);

  const { CRITIQS_PROJECT_ID: _, ...unset } = process.env;
  const page = await serve(unset, async (url) => (await fetch(url)).text());
  assert.match(page, /A Flask page/);
  assert.doesNotMatch(page, /critiqs-app|element\.js/);
  console.log(`Flask: Critiqs's toolbar appears with CRITIQS_PROJECT_ID set (${JSON.stringify(configured.toolbar)}), /items/7 reports the screen items/:id, and the page has no Critiqs without it.`);

  // This computer, after init: the ID in .env, next to keys the app never loaded. flask-critiqs doesn't install python-dotenv.
  await writeFile(join(root, ".env"), `DATABASE_URL=postgres://db:5432/app\nFLASK_DEBUG=1\nCRITIQS_PROJECT_ID=${PROJECT}\n`);
  // Nothing the app could have loaded from .env is inherited, so whatever /env lists came from .env. That includes every
  // CRITIQS_ setting of the process running this check, such as CRITIQS_PACKED in the Publish workflow.
  const clean = Object.fromEntries(Object.entries(unset).filter(([key]) => key !== "DATABASE_URL" && key !== "FLASK_DEBUG" && !key.startsWith("CRITIQS")));
  const [development, loaded] = await serve(clean, async (url) => [await expectToolbar(url, "flask-run"), await (await fetch(`${url}env`)).json()] as const, "flask run");
  assert.deepEqual(development.errors, []);
  assert.doesNotMatch(development.toolbar, /Set up Critiqs/);
  assert.deepEqual(loaded, { loaded: [] });
  const production = await serve(clean, async (url) => (await fetch(url)).text());
  assert.doesNotMatch(production, /critiqs-app|element\.js/);
  console.log("Flask: with the ID in .env, `flask run` shows Critiqs and leaves the app's other .env keys unset; Waitress shows none.");
} finally {
  backend.stop();
}
