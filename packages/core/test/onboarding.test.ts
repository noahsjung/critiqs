import { describe, expect, test } from "bun:test";
import {
  AVAILABLE_WAYS,
  backendSetting,
  type AddressCheck,
  classifyAddress,
  detectStack,
  developerMessage,
  type FetchedAddress,
  installCommands,
  isLocalAddress,
  isPrivateReviewAddress,
  type OnboardingAnswers,
  type PageHop,
  parseOnboardingAnswers,
  parseStack,
  recommend,
  type StackId,
  STACKS,
  startingTags,
  type Way,
} from "../src/index.ts";
import { OTHER_ADDRESSES, PRIVATE_ADDRESSES } from "./review-addresses.ts";

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Prototype</title></head><body>${body}</body></html>`;

/**
 * Whether `run` takes about 8 times as long on a page 8 times the size (2 MB
 * against 256 KB), as a linear scan does, rather than the 64 times a scan
 * that grows with the square of the size takes. Each size counts its fastest
 * of 5 runs, each after a full garbage collection: other work on the machine
 * and collector pauses only ever add time, so the fastest run is the scan's
 * own. Allowing 24 times leaves 3 times room above linear and stays well
 * under quadratic. A pass on any of 3 tries counts, since load on a shared
 * machine can slow one measurement, but a quadratic scan fails every try.
 */
function growsLinearly<T>(make: (size: number) => T, run: (input: T) => unknown): boolean {
  const fastest = (input: T) => {
    let best = Infinity;
    for (let attempt = 0; attempt < 5; attempt++) {
      Bun.gc(true);
      const began = performance.now();
      run(input);
      best = Math.min(best, performance.now() - began);
    }
    return best;
  };
  const small = make(256_000);
  const large = make(2_048_000);
  run(small);
  for (let attempt = 0; attempt < 3; attempt++) {
    // The 5 ms covers a timer's resolution on pages that take well under a millisecond.
    if (fastest(large) < 24 * fastest(small) + 5) return true;
  }
  return false;
}

describe("onboarding answers", () => {
  test("keep known values and drop everything else, as if skipped", () => {
    const cases: [unknown, OnboardingAnswers][] = [
      [null, {}],
      [undefined, {}],
      ["engineer", {}],
      [42, {}],
      [["engineer"], {}],
      [{}, {}],
      [{ role: "ceo", teamSize: 5, codeAccess: "yes", purpose: "fun" }, {}],
      [{ role: { toString: () => "engineer" } }, {}],
      [{ feedbackFrom: "team" }, {}],
      [{ feedbackFrom: [] }, {}],
      [{ feedbackFrom: ["bogus", 1, null] }, {}],
      // Unique, in the question's order.
      [{ feedbackFrom: ["test-users", "bogus", "team", "team"] }, { feedbackFrom: ["team", "test-users"] }],
      [
        { role: "agency", teamSize: "over-100", codeAccess: "nobody", feedbackFrom: ["clients"], purpose: "qa", admin: true },
        { role: "agency", teamSize: "over-100", codeAccess: "nobody", feedbackFrom: ["clients"], purpose: "qa" },
      ],
    ];
    for (const [input, expected] of cases) expect([input, parseOnboardingAnswers(input)]).toEqual([input, expected]);
  });
});

describe("stacks", () => {
  test("a picked stack is one of the list, and anything else is no stack", () => {
    for (const stack of STACKS) expect(parseStack(stack.id)).toBe(stack.id);
    for (const other of ["Next.js", "NEXT", "", null, undefined, 1, ["next"], { id: "next" }, "toString"]) expect(parseStack(other)).toBeUndefined();
  });

  test("are found from durable markers in realistic pages", () => {
    const cases: [string, { html: string; headers?: Record<string, string> }, StackId | null][] = [
      ["Next.js pages router", { html: page(`<div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>`) }, "next"],
      ["Next.js app router", { html: page(`<script src="/_next/static/chunks/webpack-1a2b.js" async=""></script>`) }, "next"],
      ["Next.js header only", { html: page("<div></div>"), headers: { "x-powered-by": "Next.js" } }, "next"],
      [
        "Nuxt 3, whose pages also carry Vue's markers",
        { html: page(`<div id="__nuxt"><main data-v-6f8a2c1e>Hi</main></div><script type="application/json" id="__NUXT_DATA__" data-ssr="true">[]</script>`) },
        "nuxt",
      ],
      ["Nuxt 2", { html: page(`<script>window.__NUXT__=(function(a){return {}}(1));</script>`) }, "nuxt"],
      ["Nuxt assets", { html: page(`<link rel="modulepreload" href="https://cdn.acme.com/_nuxt/entry.4f2a.js">`) }, "nuxt"],
      [
        "SvelteKit, whose pages also carry Svelte's markers",
        { html: `<body data-sveltekit-preload-data="hover"><h1 data-svelte-h="svelte-1x2y3z">Hi</h1><script>{ __sveltekit_1ab2c3 = { base: "" }; }</script></body>` },
        "sveltekit",
      ],
      ["SvelteKit assets", { html: page(`<link href="/_app/immutable/entry/start.B1c2.js" rel="modulepreload">`) }, "sveltekit"],
      ["Astro hosting a Vue island", { html: page(`<astro-island uid="Z1" component-url="/_astro/Counter.js"><div data-v-app="">0</div></astro-island>`) }, "astro"],
      ["Astro generator", { html: `<head><meta name="generator" content="Astro v4.5.0"></head>` }, "astro"],
      ["Angular", { html: page(`<app-root _nghost-ng-c4012 ng-version="17.3.0"></app-root>`) }, "angular"],
      ["Remix", { html: page(`<script>window.__remixContext = {"url":"/"};</script>`) }, "remix"],
      ["React Router framework mode", { html: page(`<script>window.__reactRouterContext = {"basename":"/"};</script>`) }, "remix"],
      ["Gatsby", { html: page(`<div id="___gatsby"><div id="gatsby-focus-wrapper" tabindex="-1"></div></div>`) }, "gatsby"],
      ["Vue", { html: page(`<div id="app" data-v-app=""><main data-v-7ba5bd90>Hi</main></div>`) }, "vue"],
      ["Svelte", { html: page(`<h1 data-svelte-h="svelte-11xyz">Hi</h1>`) }, "svelte"],
      ["Solid", { html: page(`<div data-hk="0-0-0-0"><button>Count</button></div>`) }, "solid"],
      ["Rails", { html: `<head><meta name="csrf-param" content="authenticity_token" />\n<meta name="csrf-token" content="abc" /></head>` }, "rails"],
      ["Django form", { html: page(`<form method="post"><input type="hidden" name="csrfmiddlewaretoken" value="abc"></form>`) }, "django"],
      ["Django cookie", { html: page("<div></div>"), headers: { "set-cookie": "csrftoken=abc; expires=Wed, 25 Nov 2027 10:00:00 GMT; Path=/; SameSite=Lax" } }, "django"],
      [
        "Laravel with Vue through Inertia",
        {
          html: page(`<div id="app" data-v-app="" data-page="{}"></div>`),
          headers: {
            "set-cookie":
              "XSRF-TOKEN=eyJpdiI6; expires=Wed, 25 Nov 2026 12:00:00 GMT; Max-Age=7200; path=/; samesite=lax, laravel_session=eyJpdiI6; expires=Wed, 25 Nov 2026 12:00:00 GMT; Max-Age=7200; path=/; httponly; samesite=lax",
          },
        },
        "laravel",
      ],
      ["Flask's development server", { html: page("<h1>Hi</h1>"), headers: { server: "Werkzeug/3.0.1 Python/3.12.2" } }, "flask"],
      ["WordPress", { html: `<head><link rel='stylesheet' href='https://blog.acme.com/wp-content/themes/twentytwentyfour/style.css' /></head>` }, "wordpress"],
      ["WordPress API link", { html: page("<div></div>"), headers: { link: '<https://blog.acme.com/wp-json/>; rel="https://api.w.org/"' } }, "wordpress"],
      ["Plain Vite app", { html: `<head><script type="module" crossorigin src="/assets/index-DiwrgTda.js"></script></head><body><div id="root"></div></body>` }, null],
      ["Markers named in text", { html: page(`<p>Next.js stores props in __NEXT_DATA__ and assets under /_next/; Vue adds data-v-app.</p>`) }, null],
      // Spring also names its cookie XSRF-TOKEN, with a JSESSIONID session.
      ["Spring", { html: page("<div></div>"), headers: { "set-cookie": "XSRF-TOKEN=abc; Path=/, JSESSIONID=def; Path=/; HttpOnly" } }, null],
      ["Empty page", { html: "" }, null],
    ];
    for (const [name, { html, headers = {} }, expected] of cases) expect([name, detectStack({ html, headers })]).toEqual([name, expected]);
  });

  test("are found only in whole attributes of opening tags, with any quoting and spacing", () => {
    const cases: [string, string, StackId | null][] = [
      ["Next.js asset in another attribute", `<img data-href="/_next/static/logo.svg" src="/logo.svg" alt="">`, null],
      ["Next.js asset, unquoted", `<script src=/_next/static/chunks/main-1a2b.js defer></script>`, "next"],
      ["Next.js asset, spaced", `<link rel="preload" href = '/_next/static/css/app.css' as="style">`, "next"],
      ["Next.js data, single quotes", `<script id='__NEXT_DATA__' type='application/json'>{}</script>`, "next"],
      ["Next.js data, unquoted", `<script id=__NEXT_DATA__ type=application/json>{}</script>`, "next"],
      ["Next.js data in another attribute", `<script data-id="__NEXT_DATA__" type="application/json">{}</script>`, null],
      ["Nuxt data, spaced", `<script type="application/json" id = "__NUXT_DATA__" data-ssr="true">[]</script>`, "nuxt"],
      ["Nuxt asset in another attribute", `<link data-src="/_nuxt/entry.js" href="/entry.js">`, null],
      ["SvelteKit, an attribute with no value", `<a href="/logout" data-sveltekit-reload>Log out</a>`, "sveltekit"],
      ["SvelteKit, spaced", `<body data-sveltekit-preload-data = "hover"><div>Hi</div></body>`, "sveltekit"],
      ["Astro asset in another attribute", `<script data-src="/_astro/hoisted.js"></script>`, null],
      ["Astro generator, spaced and single quotes", `<meta name = 'generator' content = 'Astro v4.5.0'>`, "astro"],
      ["Astro generator, unquoted", `<meta name=generator content=Astro>`, "astro"],
      ["Gatsby generator in another attribute", `<meta data-name="generator" content="Gatsby 5.13.0">`, null],
      ["Gatsby, spaced", `<div id = "___gatsby"><div id="gatsby-focus-wrapper"></div></div>`, "gatsby"],
      ["Gatsby in another attribute", `<div data-id="___gatsby"></div>`, null],
      ["Angular, spaced", `<app-root _nghost-ng-c4012 ng-version = "17.3.0"></app-root>`, "angular"],
      ["Angular, unquoted", `<app-root ng-version=17.3.0></app-root>`, "angular"],
      ["Angular in a longer attribute name", `<app-root data-ng-version="17.3.0"></app-root>`, null],
      ["WordPress, unquoted", `<link rel=stylesheet href=https://blog.acme.com/wp-content/themes/a/style.css>`, "wordpress"],
      ["WordPress asset in another attribute", `<img data-src="https://blog.acme.com/wp-content/uploads/a.png" src="/a.png">`, null],
      ["Rails, unquoted", `<meta name=csrf-param content=authenticity_token>`, "rails"],
      ["Rails, spaced", `<meta name = "csrf-param" content = "authenticity_token" />`, "rails"],
      ["Rails in another attribute", `<meta data-name="csrf-param" content="authenticity_token">`, null],
      ["Django, unquoted", `<input type=hidden name=csrfmiddlewaretoken value=abc>`, "django"],
      ["Django in another attribute", `<input type="hidden" data-name="csrfmiddlewaretoken" value="abc">`, null],
      ["Vue, spaced", `<main data-v-7ba5bd90 = "">Hi</main>`, "vue"],
      ["Vue in a longer attribute name", `<div data-v-app-shell="">Hi</div>`, null],
      ["Svelte, spaced", `<h1 data-svelte-h = "svelte-11xyz">Hi</h1>`, "svelte"],
      ["Svelte in a longer attribute name", `<h1 data-svelte-hash="svelte-11xyz">Hi</h1>`, null],
      ["Solid, single quotes and spaced", `<div data-hk = '0-0-0-0'><button>Count</button></div>`, "solid"],
      ["Solid in a longer attribute name", `<div x-data-hk="0-0"></div>`, null],
    ];
    for (const [name, body, expected] of cases) expect([name, detectStack({ html: page(body), headers: {} })]).toEqual([name, expected]);
  });

  test("are read from opening tags as a browser reads them, not from text, comments, or scripts", () => {
    const astro = `<meta name="generator" content="Astro v4">`;
    const cases: [string, string, StackId | null][] = [
      ["a Next.js path inside another attribute's text", `${astro}<button title="Copy the href=/_next/static asset example">Copy</button>`, "astro"],
      ["Next.js markup in a comment", `${astro}<!-- example: <script id="__NEXT_DATA__"></script> -->`, "astro"],
      ["Next.js markup in a comment closed early, as browsers close it", `<!--><script id="__NEXT_DATA__" type="application/json">{}</script>`, "next"],
      ["Next.js markup after <!-->, which closes at once", `${astro}<!--><script id="__NEXT_DATA__"></script>-->`, "next"],
      ["Next.js markup after <!--->, which closes at once", `${astro}<!---><script id="__NEXT_DATA__"></script>-->`, "next"],
      ["Next.js markup after <!--!>, which doesn't close", `${astro}<!--!><script id="__NEXT_DATA__"></script>-->`, "astro"],
      ["Next.js markup in CDATA inside an SVG, which runs to ]]>", `${astro}<svg><![CDATA[ 1 > 0 <script id="__NEXT_DATA__"></script> ]]></svg>`, "astro"],
      ["Next.js markup in CDATA inside MathML", `${astro}<math><![CDATA[ 1 > 0 <script id="__NEXT_DATA__"></script> ]]></math>`, "astro"],
      ["Next.js markup after CDATA outside foreign content, which ends at its first >", `${astro}<![CDATA[ 1 > 0 <script id="__NEXT_DATA__"></script> ]]>`, "next"],
      ["Next.js markup after CDATA past a closed SVG", `${astro}<svg></svg><![CDATA[ 1 > 0 <script id="__NEXT_DATA__"></script> ]]>`, "next"],
      ["Next.js markup after CDATA past a self-closed SVG", `${astro}<svg/><![CDATA[ 1 > 0 <script id="__NEXT_DATA__"></script> ]]>`, "next"],
      ["Next.js markup after CDATA past HTML that leaves an SVG", `${astro}<svg><p><![CDATA[ 1 > 0 <script id="__NEXT_DATA__"></script> ]]>`, "next"],
      ["Next.js markup after <plaintext>, which is text to the end", `${astro}<plaintext><script id="__NEXT_DATA__"></script></plaintext>`, "astro"],
      ["a Next.js path in a link's query", `${astro}<a href="/search?q=/_next/static">Next docs</a>`, "astro"],
      ["a Next.js path in a stylesheet's query", `${astro}<link rel="stylesheet" href="/theme.css?from=/_next/static/">`, "astro"],
      ["a > inside an earlier quoted value", `<script title="1 > 0" id="__NEXT_DATA__" type="application/json">{}</script>`, "next"],
      ["a > inside an earlier single-quoted value", `<meta content='Gatsby 5' data-note='a > b' name=generator>`, "gatsby"],
      ["a value with character references", `<script id="__NEXT&#95;DATA&#x5F;_" type="application/json">{}</script>`, "next"],
      ["values with named and numeric references", `<meta name="gen&#101;rator" content="&#65;stro &amp; more">`, "astro"],
      ["a reference that changes a value", `<meta name="csrf-param" content="authenticity_token&amp;">`, null],
      ["markup inside a script", `<script>const html = '<meta name="generator" content="Astro v4">';</script>`, null],
      ["markup inside a style", `<style>/* <link href="/_next/static/css/app.css"> */</style>`, null],
      ["Nuxt's state in page text", `<p>Nuxt 2 sets window.__NUXT__= on every page.</p>`, null],
      ["Nuxt's state in a script", `<SCRIPT>window.__NUXT__ = {}</SCRIPT>`, "nuxt"],
      ["a repeated attribute, where the first counts", `<script id="app" id="__NEXT_DATA__" type="application/json">{}</script>`, null],
    ];
    for (const [name, body, expected] of cases) expect([name, detectStack({ html: page(body), headers: {} })]).toEqual([name, expected]);
  });

  test("the linear-time check fails a scan that grows with the square of the page", () => {
    // A stand-in for a scanner that rescans: the work for a page is (its length / 200) squared.
    const quadratic = (input: { html: string }) => {
      const n = Math.floor(input.html.length / 200);
      let sum = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sum += (i ^ j) & 1;
      return sum;
    };
    expect(growsLinearly((size) => ({ html: "x".repeat(size) }), quadratic)).toBe(false);
  });

  test("stay linear in the page's size on hostile pages", () => {
    // Each scenario builds a page of about `size` characters. A pattern that
    // backtracks across tags or rescans grows with the square of the size.
    const fill = (piece: string, size: number) => piece.repeat(Math.ceil(size / piece.length));
    const scenarios: [string, (size: number) => { html: string; headers: Record<string, string> }][] = [
      ...["<a", "<script", "<meta", "<input", "src=", "href=", "__sveltekit_", "<div data-v-", "<!--", "<!x", "</a", "&#"].map(
        (start): [string, (size: number) => { html: string; headers: Record<string, string> }] => [start, (size) => ({ html: fill(start, size), headers: {} })],
      ),
      ["one tag of src=", (size) => ({ html: "<a " + fill(" src=", size), headers: {} })],
      ["one tag of unquoted src", (size) => ({ html: "<script" + fill(" src=/x", size), headers: {} })],
      ["one tag of spaced ids", (size) => ({ html: "<script" + fill(" id = ", size), headers: {} })],
      ["one tag of password types", (size) => ({ html: "<input" + fill(" type = ", size), headers: {} })],
      ["one tag of spaces", (size) => ({ html: "<input type" + fill(" ", size), headers: {} })],
      ["one unclosed quoted value", (size) => ({ html: '<input type="' + fill("password ", size), headers: {} })],
      [
        "many tags",
        (size) => ({
          html: fill('<a href="/assets/logo.svg" title="Example"><script id="config" src="/assets/app.js"></script><input type="text"><meta name="description" content="Prototype"><span data-v-missing>Text</span>', size),
          headers: {},
        }),
      ],
      ["one script of near misses", (size) => ({ html: "<script>" + fill("window.__NUXT__x; window.__remixContextx; __sveltekit_abcd_ef; ", size) + "</script>", headers: {} })],
      ["many unclosed scripts", (size) => ({ html: fill("<script>x", size), headers: {} })],
      ["many comments", (size) => ({ html: fill("<!-- - -- x", size), headers: {} })],
      ["many comments that open like <!--!>", (size) => ({ html: fill("<!--!>", size), headers: {} })],
      ["many CDATA sections in an SVG", (size) => ({ html: "<svg>" + fill("<![CDATA[ ]>", size), headers: {} })],
      ["many SVGs", (size) => ({ html: fill("<svg><math></svg><p>", size), headers: {} })],
      [
        "headers that almost match",
        (size) => ({
          html: "<main>Preview</main>",
          headers: {
            "x-powered-by": fill("Nextx", size / 4),
            link: fill("<https://example.com/api-w.org/>; rel=help, ", size / 4),
            "set-cookie": fill("XSRF-TOKEN=example, application-profile_sessioning=example, ", size / 4),
            server: fill("Example HTTP Server", size / 4),
          },
        }),
      ],
    ];
    const run = ({ html, headers }: { html: string; headers: Record<string, string> }) => {
      detectStack({ html, headers });
      classifyAddress({ hops: [{ url: "https://acme.com/", status: 403, headers }], html });
      classifyAddress({ hops: [{ url: "https://acme.com/", status: 200, headers }], html });
    };
    for (const [name, make] of scenarios) expect([name, growsLinearly(make, run)]).toEqual([name, true]);
  }, 120_000);

  test("are each listed once, and every framework with a Critiqs package is installable", () => {
    expect(new Set(STACKS.map((stack) => stack.id)).size).toBe(STACKS.length);
    expect(STACKS.filter((stack) => stack.installable).map((stack) => stack.id)).toEqual(["react", "next", "vue", "nuxt", "svelte", "sveltekit", "angular", "astro", "solid", "rails", "django", "flask"]);
    expect(STACKS.filter((stack) => !stack.installable).map((stack) => stack.id)).toEqual(["gatsby", "laravel", "remix", "wordpress"]);
  });
});

describe("local addresses", () => {
  test("are this computer, private networks, and local names", () => {
    const cases: [string, boolean][] = [
      ["http://localhost:5173/", true],
      ["http://app.localhost/", true],
      ["http://127.0.0.1:3000/", true],
      ["http://2130706433/", true],
      ["http://0x7f.1/", true],
      ["http://0.0.0.0:8080/", true],
      ["http://10.0.0.8/", true],
      ["http://172.16.4.1/", true],
      ["http://192.168.1.4:3000/", true],
      ["http://169.254.169.254/latest/meta-data/", true],
      ["http://100.101.102.103/", true],
      ["http://[::1]:3000/", true],
      ["http://[::ffff:127.0.0.1]/", true],
      ["http://[fd7a:115c:a1e0::1]/", true],
      ["http://[fe80::1]/", true],
      ["http://prototype.local/", true],
      ["http://api.internal/", true],
      ["http://devbox:3000/", true],
      ["https://localhost./", true],
      ["https://acme-proto.vercel.app/", false],
      ["https://example.com/", false],
      ["http://8.8.8.8/", false],
      ["http://172.32.0.1/", false],
      ["http://[2606:4700:4700::1111]/", false],
      ["https://local.example.com/", false],
    ];
    for (const [address, expected] of cases) expect([address, isLocalAddress(new URL(address))]).toEqual([address, expected]);
  });

  test("follow the same rule as private review addresses, Tailscale names included", () => {
    const named = ["https://devbox.home.arpa/", "https://devbox.tail1234.ts.net/", "https://DevBox.Tail1234.TS.NET./"];
    for (const address of named) expect([address, isLocalAddress(new URL(address)), isPrivateReviewAddress(address)]).toEqual([address, true, true]);
    const addresses = [...PRIVATE_ADDRESSES, ...OTHER_ADDRESSES].filter((address) => URL.canParse(address));
    for (const address of addresses) expect([address, isLocalAddress(new URL(address))]).toEqual([address, isPrivateReviewAddress(address)]);
  });
});

describe("address check", () => {
  const hop = (url: string, status: number, headers: Record<string, string> = {}): PageHop => ({ url, status, headers });
  const redirect = (url: string, location: string, headers: Record<string, string> = {}) => hop(url, 302, { location, ...headers });
  const nextPage = page(`<script src="/_next/static/chunks/main.js"></script><div>Sign in</div>`);

  test("tells public, sign-in, blocked, and unreachable pages apart", () => {
    const cases: [string, FetchedAddress, AddressCheck][] = [
      ["no answer", { hops: [], html: null }, { kind: "unreachable" }],
      ["a public page", { hops: [hop("https://acme.com/", 200)], html: page("<h1>Hi</h1>") }, { kind: "public", stack: null }],
      ["a public Next.js page", { hops: [hop("https://acme.com/", 200)], html: nextPage }, { kind: "public", stack: "next" }],
      [
        "public after redirects",
        { hops: [redirect("http://acme.com/", "https://acme.com/"), redirect("https://acme.com/", "/en/"), hop("https://acme.com/en/", 200)], html: nextPage },
        { kind: "public", stack: "next" },
      ],
      [
        "redirected to Google, with the stack from the prototype's own headers",
        {
          hops: [redirect("https://app.acme.com/", "https://accounts.google.com/o/oauth2/v2/auth?client_id=1", { "x-powered-by": "Next.js" }), hop("https://accounts.google.com/o/oauth2/v2/auth?client_id=1", 200)],
          html: page("<div>Sign in with Google</div>"),
        },
        { kind: "sign-in", via: "redirect", host: "accounts.google.com", stack: "next" },
      ],
      [
        "redirected to Microsoft, not followed",
        { hops: [redirect("https://app.acme.com/", "https://login.microsoftonline.com/common/oauth2/authorize")], html: null },
        { kind: "sign-in", via: "redirect", host: "login.microsoftonline.com", stack: null },
      ],
      [
        "redirected to Okta",
        { hops: [redirect("https://app.acme.com/", "https://acme.okta.com/oauth2/v1/authorize")], html: null },
        { kind: "sign-in", via: "redirect", host: "acme.okta.com", stack: null },
      ],
      [
        "redirected to Auth0",
        { hops: [redirect("https://app.acme.com/", "https://acme.us.auth0.com/authorize")], html: null },
        { kind: "sign-in", via: "redirect", host: "acme.us.auth0.com", stack: null },
      ],
      [
        "redirected to Clerk's development accounts page",
        { hops: [redirect("https://app.acme.com/", "https://happy-cat-12.clerk.accounts.dev/sign-in")], html: null },
        { kind: "sign-in", via: "redirect", host: "happy-cat-12.clerk.accounts.dev", stack: null },
      ],
      [
        "redirected to Clerk's accounts page on the app's domain",
        { hops: [redirect("https://app.acme.com/", "https://accounts.acme.com/sign-up")], html: null },
        { kind: "sign-in", via: "redirect", host: "accounts.acme.com", stack: null },
      ],
      [
        "redirected to GitHub sign-in",
        { hops: [redirect("https://app.acme.com/", "https://github.com/login?return_to=%2Fapps"), hop("https://github.com/login?return_to=%2Fapps", 200)], html: page("") },
        { kind: "sign-in", via: "redirect", host: "github.com", stack: null },
      ],
      [
        "redirected to Vercel Authentication, whose own page is built with Next.js",
        { hops: [hop("https://proto-git-main-acme.vercel.app/", 307, { location: "https://vercel.com/sso-api?url=https%3A%2F%2Fproto" }), hop("https://vercel.com/sso-api?url=https%3A%2F%2Fproto", 200)], html: nextPage },
        { kind: "sign-in", via: "redirect", host: "vercel.com", stack: null },
      ],
      [
        "redirected to Cloudflare Access",
        { hops: [redirect("https://app.acme.com/", "https://acme.cloudflareaccess.com/cdn-cgi/access/login/app.acme.com")], html: null },
        { kind: "sign-in", via: "redirect", host: "acme.cloudflareaccess.com", stack: null },
      ],
      [
        "redirected to the app's own sign-in page, which shows its stack",
        {
          hops: [redirect("https://www.acme.com/dashboard", "https://acme.com/sign-in"), hop("https://acme.com/sign-in", 200)],
          html: `<head><meta name="csrf-param" content="authenticity_token" /></head><form></form>`,
        },
        { kind: "sign-in", via: "redirect", host: "acme.com", stack: "rails" },
      ],
      [
        "redirected to /login",
        { hops: [redirect("https://acme.com/", "/login?next=%2F"), hop("https://acme.com/login?next=%2F", 200)], html: nextPage },
        { kind: "sign-in", via: "redirect", host: "acme.com", stack: "next" },
      ],
      [
        "a Vercel Authentication page in place",
        { hops: [hop("https://proto-acme.vercel.app/", 401, { server: "Vercel" })], html: page(`<a href="https://vercel.com/sso-api?url=x">Log in to Vercel</a>`) },
        { kind: "sign-in", via: "redirect", host: "vercel.com", stack: null },
      ],
      [
        "Basic Auth",
        { hops: [hop("https://staging.acme.com/", 401, { "www-authenticate": 'Basic realm="Staging"', server: "Werkzeug/3.0.1 Python/3.12.2" })], html: "Unauthorized" },
        { kind: "sign-in", via: "password", host: null, stack: "flask" },
      ],
      [
        "a host's password page",
        { hops: [hop("https://proto-acme.vercel.app/", 401, { server: "Vercel" })], html: page(`<form method="POST"><input type="password" name="_vercel_password"></form><script src="/_next/static/x.js"></script>`) },
        { kind: "sign-in", via: "password", host: null, stack: null },
      ],
      [
        "a password page answered with 403",
        { hops: [hop("https://proto.netlify.app/", 403, { server: "Netlify" })], html: page(`<input name="password" type="password">`) },
        { kind: "sign-in", via: "password", host: null, stack: null },
      ],
      ["any other 401", { hops: [hop("https://acme.com/", 401)], html: "Unauthorized" }, { kind: "sign-in", via: "password", host: null, stack: null }],
      ["a Cloudflare challenge", { hops: [hop("https://acme.com/", 403, { "cf-mitigated": "challenge", server: "cloudflare" })], html: page("Just a moment...") }, { kind: "blocked" }],
      [
        "a Cloudflare challenge page",
        { hops: [hop("https://acme.com/", 503, { server: "cloudflare" })], html: page(`<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>`) },
        { kind: "blocked" },
      ],
      [
        "a challenge on the sign-in page",
        { hops: [redirect("https://acme.com/", "/login"), hop("https://acme.com/login", 403, { "cf-mitigated": "challenge" })], html: page("Just a moment...") },
        { kind: "blocked" },
      ],
      ["Vercel's attack challenge", { hops: [hop("https://acme.com/", 429, { "x-vercel-mitigated": "challenge" })], html: "" }, { kind: "blocked" }],
      ["an AWS WAF challenge", { hops: [hop("https://acme.com/", 202, { "x-amzn-waf-action": "challenge" })], html: "" }, { kind: "blocked" }],
      ["DataDome", { hops: [hop("https://acme.com/", 403, { "x-datadome": "protected" })], html: page(`<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>`) }, { kind: "blocked" }],
      ["Akamai", { hops: [hop("https://acme.com/", 403, { server: "AkamaiGHost" })], html: page("<h1>Access Denied</h1>") }, { kind: "blocked" }],
      ["a plain 403", { hops: [hop("https://acme.com/", 403)], html: page("Forbidden") }, { kind: "blocked" }],
      ["too many requests", { hops: [hop("https://acme.com/", 429)], html: "" }, { kind: "blocked" }],
      ["a server error", { hops: [hop("https://acme.com/", 500)], html: page("Internal Server Error") }, { kind: "unreachable" }],
      ["a bad gateway", { hops: [redirect("https://acme.com/", "/app"), hop("https://acme.com/app", 502)], html: null }, { kind: "unreachable" }],
      ["no page there", { hops: [hop("https://acme.com/nope", 404)], html: page("Not found") }, { kind: "unreachable" }],
      ["redirects that never reach a page", { hops: [redirect("https://acme.com/", "/a"), redirect("https://acme.com/a", "/")], html: null }, { kind: "unreachable" }],
      [
        "a redirect to a public GitHub page",
        { hops: [redirect("https://acme.com/", "https://github.com/acme/proto"), hop("https://github.com/acme/proto", 200)], html: page("") },
        { kind: "public", stack: null },
      ],
      [
        "a sign-in step the redirects pass through",
        { hops: [redirect("https://acme.com/", "/auth/refresh"), redirect("https://acme.com/auth/refresh", "/dashboard"), hop("https://acme.com/dashboard", 200)], html: page("") },
        { kind: "public", stack: null },
      ],
      ["a public page behind Imperva", { hops: [hop("https://acme.com/", 200)], html: page(`<script src="/_Incapsula_Resource?SWJIYLWA=719d34d3"></script>`) }, { kind: "public", stack: null }],
      ["Imperva's block text on a 200, public without its challenge frame", { hops: [hop("https://acme.com/", 200)], html: page("Request unsuccessful. Incapsula incident ID: 123-456") }, { kind: "public", stack: null }],
      ["a path that only starts like a sign-in path", { hops: [redirect("https://acme.com/", "/authors/"), hop("https://acme.com/authors/", 200)], html: page("") }, { kind: "public", stack: null }],
    ];
    for (const [name, fetched, expected] of cases) expect([name, classifyAddress(fetched)]).toEqual([name, expected]);
  });

  test("needs a page before it calls an address public or infers sign-in from where it led", () => {
    const cases: [string, FetchedAddress, AddressCheck][] = [
      ["no content", { hops: [hop("https://acme.com/", 204)], html: null }, { kind: "unreachable" }],
      ["reset content", { hops: [hop("https://acme.com/", 205)], html: null }, { kind: "unreachable" }],
      ["an empty 200", { hops: [hop("https://acme.com/", 200)], html: " \n" }, { kind: "unreachable" }],
      ["no content after a redirect", { hops: [redirect("https://acme.com/", "/app"), hop("https://acme.com/app", 204)], html: null }, { kind: "unreachable" }],
      ["a redirect to /login that ends in a 404", { hops: [redirect("https://acme.com/", "/login"), hop("https://acme.com/login", 404)], html: page("Not found") }, { kind: "unreachable" }],
      ["a redirect to a sign-in page that fails", { hops: [redirect("https://acme.com/", "/users/sign_in"), hop("https://acme.com/users/sign_in", 500)], html: page("Error") }, { kind: "unreachable" }],
      ["a redirect to a sign-in page with no content", { hops: [redirect("https://acme.com/", "/login"), hop("https://acme.com/login", 204)], html: null }, { kind: "unreachable" }],
      ["a redirect to /login that wasn't followed", { hops: [redirect("https://acme.com/", "/login")], html: null }, { kind: "unreachable" }],
      // Being sent to an identity provider is the sign-in, whatever its page answers Critiqs's server.
      ["a redirect to Okta, which refuses the bare request", { hops: [redirect("https://app.acme.com/", "https://acme.okta.com/oauth2/v1/authorize"), hop("https://acme.okta.com/oauth2/v1/authorize", 400)], html: page("Bad request") }, { kind: "sign-in", via: "redirect", host: "acme.okta.com", stack: null }],
      ["a redirect to Google, which fails", { hops: [redirect("https://app.acme.com/", "https://accounts.google.com/o/oauth2/v2/auth"), hop("https://accounts.google.com/o/oauth2/v2/auth", 502)], html: null }, { kind: "sign-in", via: "redirect", host: "accounts.google.com", stack: null }],
      ["a redirect to /login that loads", { hops: [redirect("https://acme.com/", "/login"), hop("https://acme.com/login", 200)], html: page("<form></form>") }, { kind: "sign-in", via: "redirect", host: "acme.com", stack: null }],
    ];
    for (const [name, fetched, expected] of cases) expect([name, classifyAddress(fetched)]).toEqual([name, expected]);
  });

  test("reads a password field from its whole type attribute, with any quoting and spacing", () => {
    const refused = (body: string): FetchedAddress => ({ hops: [hop("https://proto.netlify.app/", 403, { server: "Netlify" })], html: page(body) });
    const password: AddressCheck = { kind: "sign-in", via: "password", host: null, stack: null };
    const cases: [string, FetchedAddress, AddressCheck][] = [
      ["spaced", refused(`<form><input type = "password" name="pw"></form>`), password],
      ["single quotes", refused(`<form><input name='pw' type='password'></form>`), password],
      ["unquoted", refused(`<form><input type=password name=pw></form>`), password],
      ["another attribute naming password", refused(`<form><input data-type="password" type="text"></form>`), { kind: "blocked" }],
      ["a longer type", refused(`<form><input type="password-reveal"></form>`), { kind: "blocked" }],
      ["a type with another word", refused(`<form><input type="password hint"></form>`), { kind: "blocked" }],
      ["a type in capitals, as browsers read it", refused(`<form><input type="PASSWORD"></form>`), password],
      ["a type with spaces around it, which browsers don't trim", refused(`<form><input type=" PASSWORD "></form>`), { kind: "blocked" }],
      ["password named in another attribute's text", refused(`<input type="text" aria-description="Enter a label such as type=password for this example">`), { kind: "blocked" }],
      ["a password field in a comment", refused(`<!-- <input type="password"> --><h1>Forbidden</h1>`), { kind: "blocked" }],
    ];
    for (const [name, fetched, expected] of cases) expect([name, classifyAddress(fetched)]).toEqual([name, expected]);
  });

  test("calls only an HTML page public", () => {
    const answered = (headers: Record<string, string>, html: string): FetchedAddress => ({ hops: [hop("https://acme.com/", 200, headers)], html });
    const cases: [string, FetchedAddress, AddressCheck][] = [
      ["a JSON health check", answered({ "content-type": "application/json" }, '{"status":"up"}'), { kind: "unreachable" }],
      ["a CSV download", answered({ "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' }, "a,b\n1,2"), { kind: "unreachable" }],
      ["an HTML file sent as a download", answered({ "content-type": "text/html", "content-disposition": "Attachment; filename=page.html" }, page("<h1>Hi</h1>")), { kind: "unreachable" }],
      ["plain text", answered({ "content-type": "text/plain; charset=utf-8" }, "OK"), { kind: "unreachable" }],
      ["HTML with a character set", answered({ "content-type": "Text/HTML; charset=utf-8" }, page("<h1>Hi</h1>")), { kind: "public", stack: null }],
      ["XHTML", answered({ "content-type": "application/xhtml+xml" }, page("<h1>Hi</h1>")), { kind: "public", stack: null }],
      ["HTML shown in place", answered({ "content-type": "text/html", "content-disposition": "inline" }, page("<h1>Hi</h1>")), { kind: "public", stack: null }],
      ["a page without a content type", answered({}, page("<h1>Hi</h1>")), { kind: "public", stack: null }],
      ["a page without a content type or doctype", answered({}, "<html><h1>Hi</h1></html>"), { kind: "public", stack: null }],
      ["a body without a content type", answered({}, "<body><h1>Hi</h1></body>"), { kind: "public", stack: null }],
      ["JSON without a content type", answered({}, '{"status":"up"}'), { kind: "unreachable" }],
      ["a fragment without a content type", answered({}, "<h1>Hi</h1>"), { kind: "unreachable" }],
      ["a doctype in a comment without a content type", answered({}, "<!-- <!doctype html> --><h1>Hi</h1>"), { kind: "unreachable" }],
      [
        "a sign-in page that answers with JSON",
        { hops: [redirect("https://acme.com/", "/login"), hop("https://acme.com/login", 200, { "content-type": "application/json" })], html: '{"error":"login required"}' },
        { kind: "unreachable" },
      ],
    ];
    for (const [name, fetched, expected] of cases) expect([name, classifyAddress(fetched)]).toEqual([name, expected]);
  });

  test("calls a page that answers 200 a password gate only with a host's marker", () => {
    const answered = (html: string, headers: Record<string, string> = {}): FetchedAddress => ({ hops: [hop("https://proto-acme.vercel.app/", 200, headers)], html });
    const password: AddressCheck = { kind: "sign-in", via: "password", host: null, stack: null };
    const publicPage: AddressCheck = { kind: "public", stack: null };
    const gate = (body: string) => page(`<h1>Protected</h1>${body}`);
    const cases: [string, FetchedAddress, AddressCheck][] = [
      [
        "Vercel's password page",
        answered(page(`<main><h1>Password required</h1><p>Enter the password to see this page.</p><form method="POST"><input type="password" name="_vercel_password" autofocus><button type="submit">Continue</button></form><a href="https://vercel.com">Vercel</a></main>`), { server: "Vercel" }),
        password,
      ],
      [
        "a museum's homepage with a member login in its aside",
        answered(page(`<h1>City Museum</h1><p>Open daily 10 to 5.</p><aside><form action="/members" method="post"><input type="email" name="email"><input type="password" name="password"><button>Member login</button></form></aside>`)),
        publicPage,
      ],
      // Without a host's marker, Critiqs doesn't guess; the person can still say it's private.
      ["a password gate whose form is in a template, public without a host's marker", answered(gate(`<template><form method="post"><input type="password" name="password"><button>Enter</button></form></template>`)), publicPage],
      ["a password gate padded with &nbsp;, public without a host's marker", answered(gate(`${"&nbsp;".repeat(60)}<form method="post"><input type="password" name="password"><button>Enter</button></form>`)), publicPage],
      ["a preview's password page, public without a host's marker", answered('<!doctype html><h1>Preview access</h1><form method="post"><input type="password" required><button>Continue</button></form>'), publicPage],
      ["a sign-in page with an email and a password, public without a host's marker", answered(page(`<h1>Sign in</h1><form action="/session" method="post"><input type="email" name="email"><input type="password" name="password"><button>Sign in</button></form>`)), publicPage],
      ["Vercel's field name without a password field", answered(page(`<form><input type="text" name="_vercel_password"></form>`)), publicPage],
    ];
    for (const [name, fetched, expected] of cases) expect([name, classifyAddress(fetched)]).toEqual([name, expected]);
  });

  test("reads sign-in and bot walls only where they belong", () => {
    const article = (body: string) => page(`<article><h1>Troubleshooting</h1><p>${body}</p></article>`);
    const cases: [string, FetchedAddress, AddressCheck][] = [
      [
        "a redirect to a GitHub repository whose name starts with login",
        { hops: [redirect("https://acme.com/", "https://github.com/login-demo"), hop("https://github.com/login-demo", 200)], html: page("<h1>login-demo</h1>") },
        { kind: "public", stack: null },
      ],
      [
        "a redirect to GitHub's OAuth sign-in",
        { hops: [redirect("https://app.acme.com/", "https://github.com/login/oauth/authorize?client_id=1")], html: null },
        { kind: "sign-in", via: "redirect", host: "github.com", stack: null },
      ],
      [
        "a redirect to a Vercel page whose path only starts like its sign-in",
        { hops: [redirect("https://acme.com/", "https://vercel.com/sso-api-docs"), hop("https://vercel.com/sso-api-docs", 200)], html: page("<h1>Docs</h1>") },
        { kind: "public", stack: null },
      ],
      [
        "a redirect to Auth0's own documentation",
        { hops: [redirect("https://acme.com/", "https://auth0.com/docs/authenticate"), hop("https://auth0.com/docs/authenticate", 200)], html: page("<h1>Authenticate</h1>") },
        { kind: "public", stack: null },
      ],
      ["a redirect to Auth0's site", { hops: [redirect("https://acme.com/", "https://auth0.com/"), hop("https://auth0.com/", 200)], html: page("<h1>Auth0</h1>") }, { kind: "public", stack: null }],
      ["a redirect to Okta's site", { hops: [redirect("https://acme.com/", "https://www.okta.com/"), hop("https://www.okta.com/", 200)], html: page("<h1>Okta</h1>") }, { kind: "public", stack: null }],
      [
        "a redirect to documentation under /docs/auth",
        { hops: [redirect("https://acme.com/", "/docs/auth/token"), hop("https://acme.com/docs/auth/token", 200)], html: page("<h1>Tokens</h1>") },
        { kind: "public", stack: null },
      ],
      [
        "a redirect to a page under /auth",
        { hops: [redirect("https://acme.com/", "/auth/token"), hop("https://acme.com/auth/token", 200)], html: page("<h1>Tokens</h1>") },
        { kind: "public", stack: null },
      ],
      [
        "a redirect to a sign-in page deeper in the path, public because only a first segment counts",
        { hops: [redirect("https://acme.com/", "/users/sign_in"), hop("https://acme.com/users/sign_in", 200)], html: page("<form></form>") },
        { kind: "public", stack: null },
      ],
      ...(["/login", "/signin", "/sign-in", "/sso", "/auth", "/login/", "/SIGNIN?next=%2F"] as const).map((path): [string, FetchedAddress, AddressCheck] => [
        `a redirect to ${path}`,
        { hops: [redirect("https://acme.com/", path), hop(`https://acme.com${path}`, 200)], html: page("<form></form>") },
        { kind: "sign-in", via: "redirect", host: "acme.com", stack: null },
      ]),
      [
        "a redirect to an identity provider that challenges Critiqs's server",
        { hops: [redirect("https://app.acme.com/", "https://acme.okta.com/login"), hop("https://acme.okta.com/login", 403, { "cf-mitigated": "challenge" })], html: page("Just a moment") },
        { kind: "sign-in", via: "redirect", host: "acme.okta.com", stack: null },
      ],
      ["an article that names Imperva's block message", { hops: [hop("https://acme.com/", 200)], html: article("How to find the Incapsula incident ID") }, { kind: "public", stack: null }],
      [
        "an article that quotes Imperva's whole block message",
        { hops: [hop("https://acme.com/", 200)], html: article("You may see: Request unsuccessful. Incapsula incident ID: 123-456") },
        { kind: "public", stack: null },
      ],
      [
        "an article that quotes Imperva's block message and sets Imperva's visitor cookie",
        { hops: [hop("https://acme.com/", 200, { "set-cookie": "visid_incap_123=abc; path=/" })], html: article("You may see: Request unsuccessful. Incapsula incident ID: 123-456") },
        { kind: "public", stack: null },
      ],
      [
        "Imperva's block message with Imperva's headers on a 200, public without its challenge frame",
        { hops: [hop("https://acme.com/", 200, { "x-iinfo": "10-123-0 NNNN", "x-cdn": "Imperva" })], html: article("Request unsuccessful. Incapsula incident ID: 123-456") },
        { kind: "public", stack: null },
      ],
      ["Imperva's block message on a 503", { hops: [hop("https://acme.com/", 503, { "x-iinfo": "10-123-0 NNNN" })], html: page("Request unsuccessful. Incapsula incident ID: 123-456") }, { kind: "blocked" }],
      [
        "Imperva's challenge frame",
        { hops: [hop("https://acme.com/", 200)], html: `<html><head><meta name="robots" content="noindex,nofollow"></head><body><iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=9&xinfo=1">Request unsuccessful. Incapsula incident ID: 123-456</iframe></body></html>` },
        { kind: "blocked" },
      ],
      ["a 403 page that links to Vercel's sign-in in a query", { hops: [hop("https://acme.com/", 403)], html: page(`<h1>Forbidden</h1><a href="/docs?url=vercel.com/sso-api">Docs</a>`) }, { kind: "blocked" }],
      ["a 403 page that names Vercel's sign-in in its text", { hops: [hop("https://acme.com/", 403)], html: page(`<h1>Forbidden</h1><p>See vercel.com/sso-api for help.</p>`) }, { kind: "blocked" }],
    ];
    for (const [name, fetched, expected] of cases) expect([name, classifyAddress(fetched)]).toEqual([name, expected]);
  });
});

describe("recommendation", () => {
  const ALL: ReadonlySet<Way> = new Set<Way>(["install", "send-to-developer", "extension", "share-build", "review-link", "allow-critiqs"]);
  const publicCheck: AddressCheck = { kind: "public", stack: null };
  const checks: AddressCheck[] = [
    publicCheck,
    { kind: "sign-in", via: "redirect", host: "accounts.google.com", stack: null },
    { kind: "sign-in", via: "password", host: null, stack: null },
    { kind: "blocked" },
    { kind: "unreachable" },
    { kind: "local" },
    { kind: "none" },
  ];

  test("follows the answers and the address check", () => {
    const cases: [string, OnboardingAnswers, AddressCheck, ReadonlySet<Way>, ReturnType<typeof recommend>][] = [
      ["can change the code", { codeAccess: "self" }, publicCheck, ALL, { primary: "install", others: ["review-link", "extension", "send-to-developer"], reason: "can-change-code" }],
      ["can change the code, local", { codeAccess: "self" }, { kind: "local" }, ALL, { primary: "install", others: ["extension", "share-build", "send-to-developer"], reason: "can-change-code" }],
      ["an engineer who skipped the question", { role: "engineer" }, { kind: "blocked" }, ALL, { primary: "install", others: ["allow-critiqs", "extension", "send-to-developer"], reason: "can-change-code" }],
      ["an engineer who said No", { role: "engineer", codeAccess: "nobody" }, publicCheck, ALL, { primary: "send-to-developer", others: ["review-link", "extension", "install"], reason: "no-code-access" }],
      ["a teammate, public", { codeAccess: "teammate" }, publicCheck, ALL, { primary: "send-to-developer", others: ["review-link", "extension", "install"], reason: "someone-else-changes-code" }],
      [
        "a teammate, clients reviewing a public page",
        { codeAccess: "teammate", feedbackFrom: ["clients"] },
        publicCheck,
        ALL,
        { primary: "send-to-developer", others: ["review-link", "extension", "install"], reason: "someone-else-changes-code" },
      ],
      ["a teammate, behind a sign-in", { codeAccess: "teammate" }, checks[1]!, ALL, { primary: "send-to-developer", others: ["extension", "share-build", "install"], reason: "someone-else-changes-code" }],
      ["a teammate, local", { codeAccess: "teammate" }, { kind: "local" }, ALL, { primary: "send-to-developer", others: ["extension", "share-build", "install"], reason: "someone-else-changes-code" }],
      ["nobody, blocked", { codeAccess: "nobody" }, { kind: "blocked" }, ALL, { primary: "send-to-developer", others: ["allow-critiqs", "extension", "install"], reason: "no-code-access" }],
      ["nobody, unreachable", { codeAccess: "nobody" }, { kind: "unreachable" }, ALL, { primary: "send-to-developer", others: ["extension", "share-build", "install"], reason: "no-code-access" }],
      ["skipped, public", {}, publicCheck, ALL, { primary: "install", others: ["send-to-developer", "review-link", "extension"], reason: "install-is-default" }],
      ["a designer who skipped, blocked", { role: "designer" }, { kind: "blocked" }, ALL, { primary: "install", others: ["send-to-developer", "allow-critiqs", "extension"], reason: "install-is-default" }],
      // Today's ways: the extension stands in for review links on a public page.
      ["can change the code, today", { codeAccess: "self" }, publicCheck, AVAILABLE_WAYS, { primary: "install", others: ["extension", "send-to-developer"], reason: "can-change-code" }],
      ["a teammate, today", { codeAccess: "teammate" }, checks[1]!, AVAILABLE_WAYS, { primary: "send-to-developer", others: ["extension", "install"], reason: "someone-else-changes-code" }],
      ["skipped, today", {}, { kind: "local" }, AVAILABLE_WAYS, { primary: "install", others: ["send-to-developer", "extension"], reason: "install-is-default" }],
      ["skipped, no address yet, today", {}, { kind: "none" }, AVAILABLE_WAYS, { primary: "install", others: ["send-to-developer"], reason: "install-is-default" }],
      // A missing way gives its place to the next.
      ["a teammate, without sending", { codeAccess: "teammate" }, publicCheck, new Set<Way>(["review-link"]), { primary: "review-link", others: ["install"], reason: "someone-else-changes-code" }],
      ["a teammate, with only the extension", { codeAccess: "teammate" }, publicCheck, new Set<Way>(["extension"]), { primary: "extension", others: ["install"], reason: "someone-else-changes-code" }],
      ["nobody, with nothing else offered", { codeAccess: "nobody" }, { kind: "blocked" }, new Set<Way>(), { primary: "install", others: [], reason: "no-code-access" }],
    ];
    for (const [name, answers, check, available, expected] of cases) expect([name, recommend(answers, check, available)]).toEqual([name, expected]);
  });

  test("offers no way that needs an address before there is one", () => {
    const none: AddressCheck = { kind: "none" };
    const cases: [string, OnboardingAnswers, ReturnType<typeof recommend>][] = [
      ["a teammate", { codeAccess: "teammate" }, { primary: "send-to-developer", others: ["install"], reason: "someone-else-changes-code" }],
      ["nobody", { codeAccess: "nobody" }, { primary: "send-to-developer", others: ["install"], reason: "no-code-access" }],
      ["nobody, clients reviewing", { codeAccess: "nobody", feedbackFrom: ["clients"] }, { primary: "send-to-developer", others: ["install"], reason: "no-code-access" }],
      ["can change the code", { codeAccess: "self" }, { primary: "install", others: ["send-to-developer"], reason: "can-change-code" }],
      ["an engineer who skipped the question", { role: "engineer" }, { primary: "install", others: ["send-to-developer"], reason: "can-change-code" }],
      ["skipped", {}, { primary: "install", others: ["send-to-developer"], reason: "install-is-default" }],
    ];
    for (const [name, answers, expected] of cases) expect([name, recommend(answers, none, ALL)]).toEqual([name, expected]);
  });

  test("puts a shared build before the extension when people outside the team review", () => {
    const signIn = checks[1]!;
    const cases: [string, OnboardingAnswers, AddressCheck, ReturnType<typeof recommend>][] = [
      ["clients, behind a sign-in", { codeAccess: "teammate", feedbackFrom: ["clients"] }, signIn, { primary: "send-to-developer", others: ["share-build", "extension", "install"], reason: "someone-else-changes-code" }],
      ["test users, local", { codeAccess: "nobody", feedbackFrom: ["test-users"] }, { kind: "local" }, { primary: "send-to-developer", others: ["share-build", "extension", "install"], reason: "no-code-access" }],
      ["the team and clients, unreachable", { codeAccess: "nobody", feedbackFrom: ["team", "clients"] }, { kind: "unreachable" }, { primary: "send-to-developer", others: ["share-build", "extension", "install"], reason: "no-code-access" }],
      ["clients, skipped the code question", { feedbackFrom: ["clients"] }, signIn, { primary: "install", others: ["send-to-developer", "share-build", "extension"], reason: "install-is-default" }],
      ["clients, a local prototype its owner can change", { codeAccess: "self", feedbackFrom: ["clients"] }, { kind: "local" }, { primary: "install", others: ["share-build", "extension", "send-to-developer"], reason: "can-change-code" }],
      ["test users, behind a sign-in, an engineer who skipped", { role: "engineer", feedbackFrom: ["test-users"] }, signIn, { primary: "install", others: ["share-build", "extension", "send-to-developer"], reason: "can-change-code" }],
      ["only the team, local, its owner can change", { codeAccess: "self", feedbackFrom: ["team"] }, { kind: "local" }, { primary: "install", others: ["extension", "share-build", "send-to-developer"], reason: "can-change-code" }],
      ["only the team", { codeAccess: "teammate", feedbackFrom: ["team"] }, signIn, { primary: "send-to-developer", others: ["extension", "share-build", "install"], reason: "someone-else-changes-code" }],
      ["nobody said who", { codeAccess: "teammate" }, signIn, { primary: "send-to-developer", others: ["extension", "share-build", "install"], reason: "someone-else-changes-code" }],
    ];
    for (const [name, answers, check, expected] of cases) expect([name, recommend(answers, check, ALL)]).toEqual([name, expected]);
  });

  test("offers Allow Critiqs only with review links, the one way it helps", () => {
    const blocked: AddressCheck = { kind: "blocked" };
    const withoutReviewLinks = new Set<Way>([...ALL].filter((way) => way !== "review-link"));
    const cases: [string, OnboardingAnswers, ReadonlySet<Way>, ReturnType<typeof recommend>][] = [
      ["nobody, with review links", { codeAccess: "nobody" }, ALL, { primary: "send-to-developer", others: ["allow-critiqs", "extension", "install"], reason: "no-code-access" }],
      ["nobody, without review links", { codeAccess: "nobody" }, withoutReviewLinks, { primary: "send-to-developer", others: ["extension", "install"], reason: "no-code-access" }],
      ["skipped, without review links", {}, withoutReviewLinks, { primary: "install", others: ["send-to-developer", "extension"], reason: "install-is-default" }],
      ["a teammate, with only Allow Critiqs", { codeAccess: "teammate" }, new Set<Way>(["allow-critiqs"]), { primary: "install", others: [], reason: "someone-else-changes-code" }],
    ];
    for (const [name, answers, available, expected] of cases) expect([name, recommend(answers, blocked, available)]).toEqual([name, expected]);
  });

  test("never repeats a way", () => {
    const answers: OnboardingAnswers[] = [{}, { role: "engineer" }, { codeAccess: "self" }, { codeAccess: "teammate" }, { codeAccess: "nobody" }];
    for (const answer of answers) {
      for (const check of checks) {
        for (const available of [ALL, AVAILABLE_WAYS, new Set<Way>()]) {
          const { primary, others } = recommend(answer, check, available);
          expect(new Set([primary, ...others]).size).toBe(others.length + 1);
        }
      }
    }
  });
});

describe("starting tags", () => {
  test("follow what the project is for", () => {
    const cases: [Parameters<typeof startingTags>[0], readonly string[]][] = [
      ["qa", ["Bug", "Regression", "UX copy change", "User feedback"]],
      ["design-review", ["Design change request", "UX copy change", "Bug", "User feedback"]],
      ["user-testing", ["User feedback", "Bug", "UX copy change", "Design change request"]],
      [undefined, ["Bug", "UX copy change", "Design change request", "User feedback"]],
    ];
    for (const [purpose, expected] of cases) expect([purpose, startingTags(purpose)]).toEqual([purpose, expected]);
  });
});

describe("sending to a developer", () => {
  test("the commands install the stack's package, then run critiqs init with the project ID", () => {
    const id = "k57abc123def456ghi";
    const cases: [StackId | null, readonly string[] | null][] = [
      ["react", ["npm install critiqs-react", `npx critiqs init ${id}`]],
      ["next", ["npm install critiqs-react", `npx critiqs init ${id}`]],
      ["vue", ["npm install critiqs-vue", `npx critiqs init ${id}`]],
      ["nuxt", ["npm install critiqs-nuxt", `npx critiqs init ${id}`]],
      ["svelte", ["npm install critiqs-svelte", `npx critiqs init ${id}`]],
      ["sveltekit", ["npm install critiqs-svelte", `npx critiqs init ${id}`]],
      ["angular", ["npm install critiqs-angular", `npx critiqs init ${id}`]],
      ["astro", ["npm install critiqs-astro", `npx critiqs init ${id}`]],
      ["solid", ["npm install critiqs-solid", `npx critiqs init ${id}`]],
      ["rails", ["bundle add critiqs-rails", `npx critiqs init ${id}`]],
      ["django", ["pip install django-critiqs", `npx critiqs init ${id}`]],
      ["flask", ["pip install flask-critiqs", `npx critiqs init ${id}`]],
      // Init finds the framework and names its package.
      [null, [`npx critiqs init ${id}`]],
      // No package: the script tag.
      ["laravel", null],
      ["wordpress", null],
    ];
    for (const [stack, expected] of cases) expect([stack, installCommands(id, stack)]).toEqual([stack, expected]);
    expect(installCommands("p_0123456789abcdef0123456789abcdef", null)).toEqual(["npx critiqs init p_0123456789abcdef0123456789abcdef"]);
  });

  test("the install command refuses anything but a project ID", () => {
    for (const id of ["", "prj_123", "abc; rm -rf ~", "$(whoami)aaaaaaaaaaaaaa", "ABCDEFGHIJKLMNOPQR"]) {
      expect(() => installCommands(id, "react")).toThrow("Not a Critiqs project ID");
      expect(() => installCommands(id, "laravel")).toThrow("Not a Critiqs project ID");
    }
  });

  test("the message gives the command only where it works", () => {
    const base = { projectName: "Acme prototype", address: "https://acme-proto.vercel.app/", projectId: "k57abc123def456ghi", setupUrl: "https://critiqs.app/setup/k57abc123def456ghi" };
    const cases: [string, Parameters<typeof developerMessage>[0], string][] = [
      [
        "a stack with a package",
        { ...base, stack: "next" },
        "Can you add Critiqs to Acme prototype at acme-proto.vercel.app? It lets us comment right on the prototype.\n\nIt's built with Next.js, so run these in its folder:\nnpm install critiqs-react\nnpx critiqs init k57abc123def456ghi\n\nSetup page: https://critiqs.app/setup/k57abc123def456ghi",
      ],
      [
        "a stack with a gem",
        { ...base, stack: "rails" },
        "Can you add Critiqs to Acme prototype at acme-proto.vercel.app? It lets us comment right on the prototype.\n\nIt's built with Rails, so run these in its folder:\nbundle add critiqs-rails\nnpx critiqs init k57abc123def456ghi\n\nSetup page: https://critiqs.app/setup/k57abc123def456ghi",
      ],
      [
        "an unknown stack",
        { ...base, address: "https://acme.com/proto/#/start", stack: null },
        "Can you add Critiqs to Acme prototype at acme.com/proto/#/start? It lets us comment right on the prototype.\n\nRun this in its folder. It finds the framework (React, Next.js, Vue, Nuxt, Svelte, SvelteKit, Angular, Astro, Solid, Rails, Django, or Flask) and adds Critiqs:\nnpx critiqs init k57abc123def456ghi\n\nSetup page: https://critiqs.app/setup/k57abc123def456ghi",
      ],
      [
        "a stack with no package",
        { ...base, stack: "laravel" },
        "Can you add Critiqs to Acme prototype at acme-proto.vercel.app? It lets us comment right on the prototype.\n\nIt's built with Laravel, which has no Critiqs package, so add Critiqs with a script tag on every page: https://github.com/noahsjung/critiqs/tree/main/packages/critiqs#with-a-script-tag\nProject ID: k57abc123def456ghi\n\nSetup page: https://critiqs.app/setup/k57abc123def456ghi",
      ],
      [
        "no address and no name",
        { ...base, projectName: "  ", address: null, stack: "react" },
        "Can you add Critiqs to our prototype? It lets us comment right on the prototype.\n\nIt's built with React (Vite), so run these in its folder:\nnpm install critiqs-react\nnpx critiqs init k57abc123def456ghi\n\nSetup page: https://critiqs.app/setup/k57abc123def456ghi",
      ],
    ];
    for (const [name, args, expected] of cases) expect([name, developerMessage(args)]).toEqual([name, expected]);
  });
});

describe("backendSetting", () => {
  test("every stack gets the form its package reads, and an unknown stack the address alone", () => {
    const url = "https://team.example.com";
    const forms = Object.fromEntries(STACKS.map((stack) => [stack.id, backendSetting(stack.id, url).setting]));
    expect(forms).toEqual({
      react: `backend="${url}"`,
      next: `backend="${url}"`,
      vue: `backend="${url}"`,
      nuxt: `critiqs: { backend: "${url}" }`,
      svelte: `backend="${url}"`,
      sveltekit: `backend="${url}"`,
      angular: `backend: "${url}",`,
      astro: `critiqs({ backend: "${url}" })`,
      solid: `backend="${url}"`,
      rails: `<%= critiqs_tag(backend: "${url}") %>`,
      django: `CRITIQS = {"BACKEND": "${url}"}`,
      flask: `app.config["CRITIQS_BACKEND"] = "${url}"`,
      gatsby: `data-backend="${url}"`,
      laravel: `data-backend="${url}"`,
      remix: `data-backend="${url}"`,
      wordpress: `data-backend="${url}"`,
    });
    expect(backendSetting(null, url)).toEqual({ where: expect.stringContaining("README"), setting: url });
  });
});
