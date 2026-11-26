// A real Django app: `django-admin startproject` plus a home page and an item
// page (items/<int:id>/) that extend a base template, with the built django-critiqs wheel installed in a fresh
// virtual environment and Critiqs added by the setup adapter's plan. With
// CRITIQS_PROJECT_ID set, Chrome checks that Critiqs's toolbar appears on both
// pages and that each reports its route; with it unset, the page carries no
// Critiqs at all.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { FRAMEWORKS } from "../../critiqs/bin/frameworks/index.mjs";
import { expectToolbar, fakeBackend, PROJECT, run, scratch, waitForServer } from "../../../scripts/consumer-kit.ts";
import { packedFile } from "../../../scripts/package-tarball.ts";
import { PACKAGE, release, venv } from "./tasks.ts";

const django = FRAMEWORKS.find((adapter) => adapter.id === "django")!;
// The release's built wheel when CRITIQS_PACKED is set; otherwise one built here.
const wheel = packedFile("pypi", "django-critiqs", (await Bun.file(join(PACKAGE, "package.json")).json()).version) ?? await release();
const dir = await scratch("django");
const python = await venv(join(dir, "venv"), [wheel]);
const root = join(dir, "app");
await mkdir(root);
await run([join(dir, "venv/bin/django-admin"), "startproject", "mysite", root], dir);

// The person's own app before Critiqs: a home page extending templates/base.html, served as in production.
const edit = async (file: string, from: string, to: string) => {
  const source = await readFile(join(root, file), "utf8");
  assert.ok(source.includes(from), `${file} doesn't contain ${from}`);
  await writeFile(join(root, file), source.replace(from, to));
};
await edit("mysite/settings.py", "'DIRS': [],", "'DIRS': [BASE_DIR / 'templates'],");
await edit("mysite/settings.py", "DEBUG = True", "DEBUG = False");
await edit("mysite/settings.py", "ALLOWED_HOSTS = []", "ALLOWED_HOSTS = ['127.0.0.1', 'localhost']\nSTATIC_ROOT = BASE_DIR / 'staticfiles'");
await edit("mysite/urls.py", "from django.urls import path\n", "from django.urls import path\nfrom django.views.generic import TemplateView\n");
await edit("mysite/urls.py", "    path('admin/', admin.site.urls),\n", "    path('admin/', admin.site.urls),\n    path('', TemplateView.as_view(template_name='home.html')),\n    path('items/<int:id>/', TemplateView.as_view(template_name='item.html')),\n");
await mkdir(join(root, "templates"));
await writeFile(
  join(root, "templates/base.html"),
  '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>{% block title %}My site{% endblock %}</title>\n</head>\n<body>\n  {% block content %}{% endblock %}\n</body>\n</html>\n',
);
await writeFile(join(root, "templates/home.html"), '{% extends "base.html" %}\n\n{% block content %}<h1>A Django page</h1>{% endblock %}\n');
await writeFile(join(root, "templates/item.html"), '{% extends "base.html" %}\n\n{% block content %}<h1>Item {{ id }}</h1>{% endblock %}\n');

const backend = fakeBackend();
const settings = { projectId: { env: django.env(root, "")! }, requireProjectId: true, backend: backend.url };
const plan = django.plan(root, settings, { entry: null });
if (!plan.ok) throw new Error(plan.message);
assert.equal(plan.action, "install");
for (const write of plan.writes) await writeFile(write.file, write.source);
assert.equal(django.plan(root, settings, { entry: null }).ok && django.plan(root, settings, { entry: null }).action, "unchanged");
console.log(plan.preview);

await run([python, "manage.py", "check"], root);
await run([python, "manage.py", "collectstatic", "--noinput"], root);
assert.ok(existsSync(join(root, "staticfiles/critiqs/element.js")), "collectstatic didn't collect critiqs/element.js");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Serves the app with `env` (DEBUG is off; --insecure serves static files as a web server would) until `check` finishes. */
async function serve<T>(env: Record<string, string | undefined>, check: (url: string) => Promise<T>): Promise<T> {
  const port = await freePort();
  const server = Bun.spawn([python, "manage.py", "runserver", "--insecure", "--noreload", `127.0.0.1:${port}`], { cwd: root, env, stdout: "ignore", stderr: "pipe" });
  try {
    await waitForServer(`http://127.0.0.1:${port}/`);
    return await check(`http://127.0.0.1:${port}/`);
  } finally {
    server.kill();
    await server.exited;
  }
}

try {
  const [configured, item, itemPage] = await serve({ ...process.env, CRITIQS_PROJECT_ID: PROJECT }, async (url) => [
    await expectToolbar(url, "django"),
    await expectToolbar(`${url}items/7/`, "django-item"),
    await (await fetch(`${url}items/7/`)).text(),
  ] as const);
  for (const result of [configured, item]) {
    assert.deepEqual(result.errors, []);
    assert.doesNotMatch(result.toolbar, /Set up Critiqs/);
  }
  assert.match(itemPage, /setContext\(\{"screen": "items\/:id", "viewState": \{"route\.id": "7"\}\}\)/);

  const { CRITIQS_PROJECT_ID: _, ...unset } = process.env;
  const page = await serve(unset, async (url) => (await fetch(url)).text());
  assert.match(page, /A Django page/);
  assert.doesNotMatch(page, /critiqs-app|element\.js/);
  console.log(`Django: Critiqs's toolbar appears with CRITIQS_PROJECT_ID set (${JSON.stringify(configured.toolbar)}), items/7/ reports the screen items/:id, and the page has no Critiqs without it.`);
} finally {
  backend.stop();
}
