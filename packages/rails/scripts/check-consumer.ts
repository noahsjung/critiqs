// A real `rails new` app (importmap, Propshaft, Turbo) with the built
// critiqs-rails gem installed from its .gem file and Critiqs added by the
// setup adapter's plan. In production, with Rails's suggested CSP (nonces for
// scripts and styles), Chrome checks that Critiqs's toolbar appears where
// CRITIQS_PROJECT_ID is set, that Turbo Drive visits, turbo-frame visits that
// advance the URL, full page loads and Back keep one Critiqs, that each page
// reports its route, that a morph refresh of the same URL reports the screen
// the page now names, and that the page has no Critiqs where it's unset. Then
// the same app moves to Sprockets and is checked again.
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expectToolbar, fakeBackend, inChrome, PROJECT, scratch, waitForServer } from "../../../scripts/consumer-kit.ts";
import { rails } from "../../critiqs/bin/frameworks/rails.mjs";
import { buildGem, ruby } from "./ruby.ts";

const dir = await scratch("rails");
const appDir = join(dir, "app");
const backend = fakeBackend();
const PORT = 3000;
const env = await ruby([dir], { ports: [PORT] });
// Puma in production, without SSL (no certificate here) and with a throwaway secret.
const production = { RAILS_ENV: "production", SECRET_KEY_BASE: "0".repeat(64), RAILS_LOG_LEVEL: "warn" };

const HOME = { screen: "/", viewState: {} };
const ITEM = { screen: "items/:id", viewState: { "route.id": "42" } };
// The screen the home page names after the morph refresh (the layout passes `screen: @critiqs_screen`).
const DASHBOARD = { screen: "dashboard", viewState: {} };

/**
 * Opens the home page and moves around it the ways Turbo apps do: a Turbo
 * Drive visit to an item and Back, a page refresh Turbo morphs (same URL,
 * after which the server names another screen), a full page load
 * (`data-turbo="false"`) and Back, then a visit inside a
 * `<turbo-frame data-turbo-action="advance">`
 * (Turbo swaps only the frame and changes the URL) and Back. After each, it
 * waits for one styled Critiqs toolbar. Returns the number of critiqs-root
 * elements after each step and the contexts each page handed to <critiqs-app>.
 */
function moveAround(url: string, pipeline: string) {
  // Playwright's whole page: these steps also use addInitScript and waitForURL.
  return inChrome(async (browserPage) => {
    const page = browserPage as any;
    const errors: string[] = [];
    let step = "load";
    page.on("pageerror", (error: Error) => {
      // Turbo itself rejects a fetch it aborts when Back leaves a frame visit, with or without Critiqs on the page.
      if (step === "frame back" && String(error) === "AbortError: signal is aborted without reason") return;
      errors.push(`${step}: ${error}`);
    });
    await page.addInitScript(() => {
      document.addEventListener("turbo:morph", () => ((window as any).__morphed = true));
      const recorded: unknown = ((window as any).__contexts = []);
      customElements.whenDefined("critiqs-app").then((element: any) => {
        const setContext = element.prototype.setContext;
        element.prototype.setContext = function (context: unknown) {
          (recorded as unknown[]).push(context);
          return setContext.call(this, context);
        };
      });
    });
    const roots: Record<string, number> = {};
    const contexts = () => page.evaluate(() => (window as any).__contexts as unknown[]);
    // The page shows `heading`, has reported at least `minContexts` contexts, and has a styled toolbar:
    // only Critiqs's stylesheet fixes the toolbar in place.
    const ready = ([heading, minContexts]: [string, number]) =>
      document.querySelector("h1")?.textContent === heading &&
      (window as any).__contexts.length >= minContexts &&
      [...document.querySelectorAll("critiqs-root")].some((root) => {
        const toolbar = root.shadowRoot?.querySelector(".toolbar");
        return toolbar != null && getComputedStyle(toolbar).position === "fixed";
      });
    /** Does `action`, then waits until the page shows `heading` with one styled toolbar, and counts critiqs-root. */
    const settle = async (name: string, action: () => Promise<unknown>, heading: string, minContexts = 1) => {
      step = name;
      await action();
      const fail = async (message: string) => {
        const state = await page.evaluate(() => {
          const toolbar = document.querySelector("critiqs-root")?.shadowRoot?.querySelector(".toolbar");
          return { url: location.href, h1: document.querySelector("h1")?.textContent, contexts: (window as any).__contexts, roots: document.querySelectorAll("critiqs-root").length, toolbarPosition: toolbar ? getComputedStyle(toolbar).position : null };
        });
        throw new Error(`${pipeline}: ${name}: ${message}\n${JSON.stringify(state, null, 2)}`);
      };
      await page.waitForFunction(ready, [heading, minContexts], { timeout: 30_000 }).catch((error: Error) => fail(`waiting for ${heading} with a styled toolbar: ${error.message}`));
      // Turbo finishes a visit after the new page shows (it caches the old one for Back), so look again a moment later.
      await page.waitForTimeout(1_000);
      if (!(await page.evaluate(ready, [heading, minContexts]))) await fail("the toolbar went away after the page settled");
      roots[name] = await page.evaluate(() => document.querySelectorAll("critiqs-root").length);
    };
    const mark = () => page.evaluate(() => ((window as any).__sameDocument = true));
    const sameDocument = () => page.evaluate(() => (window as any).__sameDocument === true);

    await settle("load", () => page.goto(url), "Home", 1);
    await mark();
    await settle("drive visit", () => page.click("#item"), "Item 42", 2);
    await settle("drive back", () => page.goBack(), "Home", 3);
    const drive = { sameDocument: await sameDocument(), contexts: await contexts() };

    // The same URL again, as Turbo's page refreshes (and broadcast refreshes) do: Turbo morphs the page in place and runs no scripts.
    await page.evaluate(() => (document.cookie = "critiqs_screen=dashboard; path=/"));
    const before = drive.contexts.length;
    await settle("morph refresh", () => page.evaluate(() => (window as any).Turbo.visit(location.href, { action: "replace" })), "Home", before + 1);
    const morph = { sameDocument: await sameDocument(), morphed: await page.evaluate(() => (window as any).__morphed === true), contexts: (await contexts()).slice(before) };
    await page.evaluate(() => (document.cookie = "critiqs_screen=; path=/; max-age=0"));

    await settle("full page load", () => page.click("#full"), "Item 9", 1);
    const full = { sameDocument: await sameDocument(), contexts: await contexts() };
    await settle("full page back", () => page.goBack(), "Home", 1);

    await mark();
    await settle("frame advance", () => page.click("#frame-item").then(() => page.waitForURL(/\/items\/7$/)), "Item 7", 1);
    const frame = { sameDocument: await sameDocument() };
    await settle("frame back", () => page.goBack(), "Home", 1);

    const evidence = process.env.CRITIQS_EVIDENCE_DIR;
    if (evidence) await page.screenshot({ path: join(evidence, `rails-${pipeline}-after-turbo-visits.png`) });
    return { drive, morph, full, frame, roots, errors };
  });
}

try {
  const gem = await buildGem(env);
  await env.run(["gem", "install", "rails", "--version", "~> 8.1", "--conservative", "--no-document"], dir);
  await env.run(["gem", "install", "--local", gem, "--no-document"], dir);
  await env.run(
    // The starter, minus deployment and tooling extras this check doesn't use.
    ["rails", "new", "app", "--skip-git", "--skip-docker", "--skip-kamal", "--skip-thruster", "--skip-ci", "--skip-test", "--skip-system-test", "--skip-dev-gems", "--skip-brakeman", "--skip-rubocop", "--skip-bundler-audit", "--skip-solid", "--skip-jbuilder"],
    dir,
  );

  // A home page linking to an item page, a strict CSP with nonces, and plain HTTP.
  await env.run(["bin/rails", "generate", "controller", "pages", "home", "item", "--skip-routes", "--no-helper"], appDir);
  await Bun.write(join(appDir, "config/routes.rb"), 'Rails.application.routes.draw do\n  get "up" => "rails/health#show"\n  get "items/:id" => "pages#item", as: :item\n  root "pages#home"\nend\n');
  await Bun.write(
    join(appDir, "app/views/pages/home.html.erb"),
    `<turbo-frame id="content" data-turbo-action="advance">
  <h1>Home</h1>
  <%= link_to "Item 7 in this frame", item_path(7), id: "frame-item" %>
</turbo-frame>
<%= link_to "Item 42", item_path(42), id: "item" %>
<%= link_to "Item 9 as a full page load", item_path(9), id: "full", data: { turbo: false } %>
`,
  );
  await Bun.write(join(appDir, "app/views/pages/item.html.erb"), '<turbo-frame id="content"><h1>Item <%= params[:id] %></h1></turbo-frame>\n');
  // A screen the server can change without changing the URL, for the morph refresh.
  await Bun.write(
    join(appDir, "app/controllers/pages_controller.rb"),
    "class PagesController < ApplicationController\n  before_action { @critiqs_screen = cookies[:critiqs_screen].presence }\n\n  def home; end\n\n  def item; end\nend\n",
  );
  // The policy Rails generates (commented out), switched on, with nonces for
  // scripts and styles as it suggests, one per session so Turbo visits keep
  // working. Rails's suggested generator, session.id, is blank on a
  // visitor's first request, so the nonce lives in the session. Scripts must
  // carry it (no 'self'); styles allow no inline <style> without it, which
  // Critiqs doesn't need. The stand-in backend is plain HTTP.
  await Bun.write(
    join(appDir, "config/initializers/content_security_policy.rb"),
    `Rails.application.configure do
  config.content_security_policy do |policy|
    policy.default_src :self, :https
    policy.font_src    :self, :https, :data
    policy.img_src     :self, :https, :data
    policy.object_src  :none
    policy.script_src  :https
    policy.style_src   :self, :https
    policy.connect_src :self, :https, "${new URL(backend.url).origin}"
  end
  config.content_security_policy_nonce_generator = ->(request) { request.session[:csp_nonce] ||= SecureRandom.base64(16) }
  config.content_security_policy_nonce_directives = %w(script-src style-src)
end
`,
  );
  const productionRb = join(appDir, "config/environments/production.rb");
  await Bun.write(productionRb, (await Bun.file(productionRb).text()).replace("config.assume_ssl = true", "config.assume_ssl = false").replace("config.force_ssl = true", "config.force_ssl = false"));

  // Critiqs, added the way `critiqs init` will: the adapter's plan, written.
  const settings = { projectId: { env: rails.env(appDir, "")! }, requireProjectId: true, backend: backend.url };
  const plan = rails.plan(appDir, settings, { entry: null });
  assert(plan.ok, plan.ok ? "" : plan.message);
  assert.equal(plan.action, "install");
  for (const write of plan.writes) await Bun.write(write.file, write.source);
  const again = rails.plan(appDir, settings, { entry: null });
  assert(again.ok && again.action === "unchanged", "planning again should change nothing");
  await env.run(["bundle", "install", "--prefer-local"], appDir);
  // Page refreshes morph, and the layout's call names the screen the controller picks (nil: the route's).
  const layoutPath = join(appDir, "app/views/layouts/application.html.erb");
  const planned = await Bun.file(layoutPath).text();
  assert(planned.includes("<%= critiqs_tag(backend: "), planned);
  await Bun.write(
    layoutPath,
    planned.replace("<%= critiqs_tag(", "<%= critiqs_tag(screen: @critiqs_screen, ").replace("<%= yield :head %>", '<%= yield :head %>\n    <meta name="turbo-refresh-method" content="morph">'),
  );

  let server = false;
  const serve = async (pipeline: string, projectId: string | null) => {
    if (server) await stopServer();
    await env.run(
      ["sh", "-c", `exec bin/rails server -b ${env.bind} -p ${PORT} -P tmp/pids/server.pid > log/server.log 2>&1 < /dev/null &`],
      appDir,
      { ...production, CRITIQS_PROJECT_ID: projectId ?? "" },
    );
    server = true;
    const url = await env.url(PORT);
    await waitForServer(`${url}/up`).catch(async (error) => {
      throw new Error(`${pipeline}: ${error.message}\n${await env.run(["cat", "log/server.log"], appDir).catch(() => "")}`);
    });
    return url;
  };
  const stopServer = async () => {
    const url = await env.url(PORT);
    await env.run(["sh", "-c", "kill $(cat tmp/pids/server.pid)"], appDir);
    for (let tries = 0; tries < 100; tries++) {
      if (!(await fetch(`${url}/up`).then(() => true, () => false))) return;
      await Bun.sleep(200);
    }
    throw new Error(`The Rails server didn't stop:\n${await env.run(["cat", "log/server.log"], appDir)}`);
  };

  const check = async (pipeline: string) => {
    await rm(join(appDir, "public/assets"), { recursive: true, force: true });
    await env.run(["bin/rails", "assets:precompile"], appDir, { ...production, SECRET_KEY_BASE_DUMMY: "1" });

    const url = await serve(pipeline, PROJECT);
    const response = await fetch(url);
    const html = await response.text();
    const nonce = /'nonce-([^']+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1];
    assert(nonce, `${pipeline}: the page should send a CSP nonce`);
    const app = /<critiqs-app [^>]*><\/critiqs-app>/.exec(html)?.[0] ?? "";
    assert.match(app, new RegExp(`project-id="${PROJECT}"`), `${pipeline}: ${html}`);
    assert.match(app, /require-project-id/);
    assert(app.includes(`backend="${backend.url}"`));
    assert(app.includes(`data-critiqs-context="${JSON.stringify(HOME).replaceAll('"', "&quot;")}"`), `${pipeline}: the element should carry the page's context: ${app}`);
    const scripts = ["element", "context"].map((name) => {
      const script = new RegExp(`<script [^>]*src="(/assets/critiqs/${name}-[\\w-]+\\.js)"[^>]*>`).exec(html);
      assert(script, `${pipeline}: the page should load the fingerprinted ${name} module:\n${html}`);
      assert.match(script[0], /type="module"/);
      assert(script[0].includes(`nonce="${nonce}"`), `${pipeline}: the ${name} script should carry the request's nonce`);
      return script;
    });
    for (const script of scripts) assert.equal((await fetch(`${url}${script[1]}`)).status, 200);
    const tagOutput = html.slice(html.indexOf("<critiqs-app"), html.indexOf(">", html.lastIndexOf("/assets/critiqs/")) + 1);
    assert.deepEqual(tagOutput.match(/<script\b[^>]*>/g)?.map((tag) => tag.includes(" src=")), [true, true], `${pipeline}: Critiqs renders its two modules and no inline script: ${tagOutput}`);
    const script = scripts[0];
    const { toolbar, errors } = await expectToolbar(url, `rails-${pipeline}`, { timeout: 30_000 });
    assert.deepEqual(errors, []);
    assert.doesNotMatch(toolbar, /Set up Critiqs/);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /style-src [^;]*'nonce-/, `${pipeline}: style-src should allow only nonces for inline styles: ${csp}`);
    assert.doesNotMatch(csp, /unsafe-inline/);
    const visit = await moveAround(url, pipeline);
    assert.deepEqual(visit.errors, []);
    assert(visit.drive.sameDocument, `${pipeline}: the item link should be a Turbo visit, not a page load`);
    assert.deepEqual(visit.drive.contexts, [HOME, ITEM, HOME], `${pipeline}: each page reports its route`);
    assert(visit.morph.morphed && visit.morph.sameDocument, `${pipeline}: the refresh should be a Turbo morph in the same document`);
    assert.deepEqual(visit.morph.contexts, [DASHBOARD], `${pipeline}: a morph refresh reports the screen the page now names`);
    assert(!visit.full.sameDocument, `${pipeline}: the data-turbo="false" link should load a new page`);
    assert.deepEqual(visit.full.contexts.at(-1), { screen: "items/:id", viewState: { "route.id": "9" } });
    assert(visit.frame.sameDocument, `${pipeline}: the frame link should swap the frame, not load a page`);
    for (const [step, count] of Object.entries(visit.roots)) assert.equal(count, 1, `${pipeline}: one critiqs-root after ${step}`);

    const unset = await (await fetch(await serve(pipeline, null))).text();
    assert(unset.includes("<h1>Home</h1>"), `${pipeline}: the page should render without a project ID`);
    assert(!unset.includes("critiqs"), `${pipeline}: without CRITIQS_PROJECT_ID the page should have no Critiqs:\n${unset}`);
    await stopServer();
    server = false;
    console.log(`Rails (${pipeline}): Critiqs's toolbar appears with CRITIQS_PROJECT_ID (${JSON.stringify(toolbar)}), script ${script[1]} with the CSP nonce, one Critiqs after each of ${Object.keys(visit.roots).join(", ")}, Turbo visits reporting ${visit.drive.contexts.map((context: any) => context.screen).join(" → ")}, then the morph refresh ${visit.morph.contexts.map((context: any) => context.screen).join(", ")}; nothing without it.`);
  };

  await check("propshaft");

  // The same app on Sprockets, the asset pipeline older Rails apps use.
  const gemfile = join(appDir, "Gemfile");
  await Bun.write(gemfile, (await Bun.file(gemfile).text()).replace(/^gem "propshaft"$/m, 'gem "sprockets-rails"'));
  await Bun.write(join(appDir, "app/assets/config/manifest.js"), "//= link_tree ../images\n//= link_directory ../stylesheets .css\n//= link_tree ../../javascript .js\n//= link_tree ../../../vendor/javascript .js\n");
  const layout = join(appDir, "app/views/layouts/application.html.erb");
  await Bun.write(layout, (await Bun.file(layout).text()).replace("stylesheet_link_tag :app", 'stylesheet_link_tag "application"'));
  await env.run(["bundle", "install", "--prefer-local"], appDir);
  await check("sprockets");
} finally {
  await env.run(["sh", "-c", "[ -e tmp/pids/server.pid ] && kill $(cat tmp/pids/server.pid) || true"], appDir).catch(() => {});
  await env.stop();
  backend.stop();
}
