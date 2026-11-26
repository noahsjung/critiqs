// Onboarding on the Critiqs website: the answers someone gives, what Critiqs
// finds at their prototype's address, and the way in it recommends. See
// the install-free review research. Every question can be
// skipped, so every answer is optional and every rule works without it.

import { type HtmlElement, type ScannedHtml, scanHtml } from "./html-scan.ts";
import { isPrivateHost } from "./local-host.ts";
import { DEFAULT_TAGS } from "./tags.ts";

// Answers. Each list is in the order the question shows its options.

export const ROLES = ["designer", "product-manager", "engineer", "founder", "agency", "other"] as const;
export type Role = (typeof ROLES)[number];

export const TEAM_SIZES = ["just-me", "2-5", "6-20", "21-100", "over-100"] as const;
export type TeamSize = (typeof TEAM_SIZES)[number];

/** "Can you change the prototype's code?": Yes, Someone on my team can, or No. */
export const CODE_ACCESS = ["self", "teammate", "nobody"] as const;
export type CodeAccess = (typeof CODE_ACCESS)[number];

/** "Who will leave feedback?": any of My team, Clients or stakeholders, Test users. */
export const FEEDBACK_FROM = ["team", "clients", "test-users"] as const;
export type FeedbackFrom = (typeof FEEDBACK_FROM)[number];

/** "What's it for?" */
export const PURPOSES = ["design-review", "qa", "user-testing"] as const;
export type Purpose = (typeof PURPOSES)[number];

/** A skipped question has no field. */
export interface OnboardingAnswers {
  role?: Role;
  teamSize?: TeamSize;
  codeAccess?: CodeAccess;
  feedbackFrom?: readonly FeedbackFrom[];
  purpose?: Purpose;
}

function oneOf<T extends string>(options: readonly T[], value: unknown): T | undefined {
  return options.find((option) => option === value);
}

/** Answers as sent to the server: unknown fields and values are dropped, as if skipped. */
export function parseOnboardingAnswers(value: unknown): OnboardingAnswers {
  if (typeof value !== "object" || value === null) return {};
  const input = value as Record<string, unknown>;
  const answers: OnboardingAnswers = {};
  const role = oneOf(ROLES, input.role);
  if (role) answers.role = role;
  const teamSize = oneOf(TEAM_SIZES, input.teamSize);
  if (teamSize) answers.teamSize = teamSize;
  const codeAccess = oneOf(CODE_ACCESS, input.codeAccess);
  if (codeAccess) answers.codeAccess = codeAccess;
  const chosen = input.feedbackFrom;
  // Unique and in the question's order; choosing none is skipping.
  const feedbackFrom = Array.isArray(chosen) ? FEEDBACK_FROM.filter((option) => chosen.includes(option)) : [];
  if (feedbackFrom.length > 0) answers.feedbackFrom = feedbackFrom;
  const purpose = oneOf(PURPOSES, input.purpose);
  if (purpose) answers.purpose = purpose;
  return answers;
}

// Stacks.

/** The forms a backend other than Critiqs Cloud takes, by package (see `backendSetting`). */
type BackendForm = "component" | "nuxt" | "astro" | "angular" | "rails" | "django" | "flask" | "script";

/**
 * Every stack someone can pick, the ones with a Critiqs package first.
 * `install` adds the stack's Critiqs package; `npx critiqs init` then adds
 * Critiqs where the app renders (see `installCommands`). A stack with no
 * package (`install: null`) adds Critiqs with the `critiqs` script tag.
 * `backend` is how it takes a backend other than Critiqs Cloud.
 */
const STACK_LIST = [
  { id: "react", label: "React (Vite)", install: "npm install critiqs-react", backend: "component" },
  { id: "next", label: "Next.js", install: "npm install critiqs-react", backend: "component" },
  { id: "vue", label: "Vue", install: "npm install critiqs-vue", backend: "component" },
  { id: "nuxt", label: "Nuxt", install: "npm install critiqs-nuxt", backend: "nuxt" },
  { id: "svelte", label: "Svelte", install: "npm install critiqs-svelte", backend: "component" },
  { id: "sveltekit", label: "SvelteKit", install: "npm install critiqs-svelte", backend: "component" },
  { id: "angular", label: "Angular", install: "npm install critiqs-angular", backend: "angular" },
  { id: "astro", label: "Astro", install: "npm install critiqs-astro", backend: "astro" },
  { id: "solid", label: "Solid", install: "npm install critiqs-solid", backend: "component" },
  { id: "rails", label: "Rails", install: "bundle add critiqs-rails", backend: "rails" },
  { id: "django", label: "Django", install: "pip install django-critiqs", backend: "django" },
  { id: "flask", label: "Flask", install: "pip install flask-critiqs", backend: "flask" },
  { id: "gatsby", label: "Gatsby", install: null, backend: "script" },
  { id: "laravel", label: "Laravel", install: null, backend: "script" },
  { id: "remix", label: "Remix or React Router", install: null, backend: "script" },
  { id: "wordpress", label: "WordPress", install: null, backend: "script" },
] as const satisfies readonly { id: string; label: string; install: string | null; backend: BackendForm }[];

export type StackId = (typeof STACK_LIST)[number]["id"];

/** A stack as backends send it. */
export interface StackInfo {
  id: StackId;
  label: string;
  /** Whether it has a Critiqs package that `critiqs init` sets up; otherwise Critiqs goes in with the script tag. */
  installable: boolean;
}

export const STACKS: readonly StackInfo[] = STACK_LIST.map(({ id, label, install }) => ({ id, label, installable: install !== null }));

/** The stacks with a Critiqs package, as people say them, for "works with …". */
export const PACKAGE_STACK_NAMES: readonly string[] = ["React", "Next.js", "Vue", "Nuxt", "Svelte", "SvelteKit", "Angular", "Astro", "Solid", "Rails", "Django", "Flask"];

/** Where the script tag is explained, for stacks with no Critiqs package. */
export const SCRIPT_TAG_GUIDE = "https://github.com/noahsjung/critiqs/tree/main/packages/critiqs#with-a-script-tag";

/** A stack someone picked or confirmed, as sent to the server; anything else is no stack. */
export function parseStack(value: unknown): StackId | undefined {
  return STACKS.find((stack) => stack.id === value)?.id;
}

/**
 * A page's body and response headers. Header names are lowercase; several
 * `Set-Cookie` headers are one value joined with ", ", as `Headers.get` gives.
 */
export interface PageContent {
  html: string;
  headers: Readonly<Record<string, string>>;
}

/** A page as markers read it: its markup scanned once, its headers, and the names of the cookies it sets. */
interface ReadPage {
  html: ScannedHtml;
  headers: Readonly<Record<string, string>>;
  cookies: readonly string[];
}

/** Cookie names from a joined `Set-Cookie`. A date's ", " starts a piece with no name, so it is skipped. */
function cookieNames(setCookie: string): string[] {
  return setCookie.split(",").flatMap((piece) => {
    const name = /^\s*([^\s=;,]+)=/.exec(piece)?.[1];
    return name === undefined ? [] : [name];
  });
}

function readPage(html: string, headers: Readonly<Record<string, string>>): ReadPage {
  return { html: scanHtml(html), headers, cookies: cookieNames(headers["set-cookie"] ?? "") };
}

// Markers, as data. Bodies come from any address someone enters, so markers
// read the scanned page (see html-scan.ts) or test single values and headers
// with patterns that can't backtrack across each other.

type Test = (value: string) => boolean;

/** An attribute, by its exact lowercase name or a test of the name, and optionally a test of its decoded value. */
interface AttributeRule {
  name: string | Test;
  value?: Test;
}

type Marker =
  /** An opening tag (`null` for any) carrying every attribute given. */
  | { in: "element"; tag: string | null; attributes: readonly AttributeRule[] }
  /** An inline script's text. */
  | { in: "script"; text: RegExp }
  | { in: "header"; name: string; value: RegExp }
  | { in: "cookie"; name: Test };

type ElementMarker = Extract<Marker, { in: "element" }>;

const element = (tag: string | null, ...attributes: AttributeRule[]): ElementMarker => ({ in: "element", tag, attributes });
const attribute = (name: string | Test, value?: Test): AttributeRule => ({ name, value });
const script = (text: RegExp): Marker => ({ in: "script", text });
const header = (name: string, value: RegExp): Marker => ({ in: "header", name, value });
const cookie = (name: string | Test): Marker => ({ in: "cookie", name: typeof name === "string" ? is(name) : name });

const is =
  (expected: string): Test =>
  (value) =>
    value === expected;
/** Equal ignoring ASCII case, untrimmed, as browsers compare keywords such as `type="password"`. */
const isKeyword =
  (expected: string): Test =>
  (value) =>
    value.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) === expected;
const startsWithWord =
  (prefix: string): Test =>
  (value) =>
    value.trim().toLowerCase().startsWith(prefix.toLowerCase());
/** A URL whose path, before any query or fragment, contains `path`. */
const inPath =
  (path: string): Test =>
  (value) =>
    value.split(/[?#]/, 1)[0]!.includes(path);

/** A script or stylesheet loaded from under `path`, such as a build's assets. */
const loads = (path: string): Marker[] => [element("script", attribute("src", inPath(path))), element("link", attribute("href", inPath(path)))];
const generator = (name: string): Marker => element("meta", attribute("name", isKeyword("generator")), attribute("content", startsWithWord(name)));

function hasAttribute(found: HtmlElement, rule: AttributeRule): boolean {
  if (typeof rule.name === "string") {
    const value = found.attributes.get(rule.name);
    return value !== undefined && (rule.value === undefined || rule.value(value));
  }
  for (const [name, value] of found.attributes) if (rule.name(name) && (rule.value === undefined || rule.value(value))) return true;
  return false;
}

function isElement(marker: ElementMarker, found: HtmlElement): boolean {
  return (marker.tag === null || found.name === marker.tag) && marker.attributes.every((rule) => hasAttribute(found, rule));
}

function matches(marker: Marker, page: ReadPage): boolean {
  switch (marker.in) {
    case "element":
      return page.html.elements.some((found) => isElement(marker, found));
    case "script":
      return page.html.scripts.some((text) => marker.text.test(text));
    case "header":
      return marker.value.test(page.headers[marker.name] ?? "");
    case "cookie":
      return page.cookies.some(marker.name);
    default: {
      const exhaustive: never = marker;
      return exhaustive;
    }
  }
}

/** A stack's markers: any one of them, or, for `all`, every one. */
type StackMarkers = { stack: StackId } & ({ any: readonly Marker[] } | { all: readonly Marker[] });

/**
 * Markers the stacks leave in their pages, most specific first: a framework
 * before the library it builds on (Nuxt before Vue), Astro before the islands
 * it hosts, and a server framework before a library used for parts of its
 * pages. A plain React app built with Vite leaves no reliable marker.
 */
const STACK_MARKERS: readonly StackMarkers[] = [
  { stack: "next", any: [element("script", attribute("id", is("__NEXT_DATA__"))), ...loads("/_next/"), header("x-powered-by", /next\.js/i)] },
  { stack: "nuxt", any: [script(/window\.__NUXT__\s*=/), element("script", attribute("id", is("__NUXT_DATA__"))), ...loads("/_nuxt/")] },
  {
    stack: "sveltekit",
    any: [script(/__sveltekit_[a-z0-9]+\s*=/), element(null, attribute((name) => name.startsWith("data-sveltekit-") && name.length > 15)), ...loads("/_app/immutable/")],
  },
  { stack: "astro", any: [element("astro-island"), ...loads("/_astro/"), generator("Astro")] },
  { stack: "remix", any: [script(/window\.__(?:remix|reactRouter)Context\s*=/)] },
  { stack: "gatsby", any: [element(null, attribute("id", is("___gatsby"))), generator("Gatsby")] },
  { stack: "angular", any: [element(null, attribute("ng-version"))] },
  { stack: "wordpress", any: [...loads("/wp-content/"), ...loads("/wp-includes/"), generator("WordPress"), header("link", /api\.w\.org/)] },
  { stack: "rails", any: [element("meta", attribute("name", is("csrf-param")), attribute("content", is("authenticity_token")))] },
  { stack: "django", any: [element("input", attribute("name", is("csrfmiddlewaretoken"))), cookie("csrftoken")] },
  // Laravel names its session cookie after the app, `laravel_session` by default.
  { stack: "laravel", all: [cookie("XSRF-TOKEN"), cookie((name) => name.length > 8 && name.endsWith("_session"))] },
  // Flask's development server.
  { stack: "flask", any: [header("server", /^werkzeug\//i)] },
  { stack: "vue", any: [element(null, attribute((name) => /^data-v-(?:app|[0-9a-f]{8})$/.test(name)))] },
  { stack: "svelte", any: [element(null, attribute("data-svelte-h"))] },
  { stack: "solid", any: [element(null, attribute("data-hk"))] },
];

function stackOf(page: ReadPage): StackId | null {
  const found = STACK_MARKERS.find((entry) => ("all" in entry ? entry.all.every((marker) => matches(marker, page)) : entry.any.some((marker) => matches(marker, page))));
  return found?.stack ?? null;
}

/** The stack a page was built with, or null when it isn't clear and the person picks. */
export function detectStack(page: PageContent): StackId | null {
  return stackOf(readPage(page.html, page.headers));
}

// The address check. The server fetches the address with its own guards,
// following redirects, and passes what came back to `classifyAddress`.

export interface PageHop {
  url: string;
  status: number;
  /** Lowercase names, as in `PageContent`. */
  headers: Readonly<Record<string, string>>;
}

export interface FetchedAddress {
  /** Each response in order: the address, then every redirect followed. Empty when nothing answered. */
  hops: readonly PageHop[];
  /** The last response's body, as much as the server read; null if it had none. */
  html: string | null;
}

export type AddressCheck =
  | { kind: "public"; stack: StackId | null }
  /**
   * `redirect`: sent to an identity provider or a sign-in page, at `host`.
   * `password`: Basic Auth or a host's password page.
   */
  | { kind: "sign-in"; via: "redirect" | "password"; host: string | null; stack: StackId | null }
  /** Bot protection, or a firewall refusing Critiqs's server. */
  | { kind: "blocked" }
  /** No answer, a server error, or no page at the address, such as a 404 or an empty 204. */
  | { kind: "unreachable" }
  /** On this computer or a private network: never fetched. */
  | { kind: "local" }
  /** "I don't have one yet." */
  | { kind: "none" };

/**
 * Whether an address only works on someone's own computer or private network,
 * so the server must not fetch it: the same rule as `isPrivateReviewAddress`
 * (see `isPrivateHost`). The server still checks every address it resolves.
 */
export function isLocalAddress(url: URL): boolean {
  return isPrivateHost(url.hostname);
}

/**
 * A site that serves sign-in: a host, or with `tenants` only the hosts under it
 * other than `www.` (a provider's customers, not its own site), and optionally
 * a path and the paths under it.
 */
interface SignInSite {
  domain: string;
  tenants?: true;
  path?: string;
}

function isOn(url: URL, { domain, tenants, path }: SignInSite): boolean {
  const host = url.hostname.toLowerCase();
  const onHost = tenants ? host.endsWith(`.${domain}`) && host !== `www.${domain}` : host === domain;
  return onHost && (path === undefined || url.pathname === path || url.pathname.startsWith(`${path}/`));
}

/** Identity providers. */
const IDENTITY_PROVIDERS: readonly SignInSite[] = [
  { domain: "accounts.google.com" },
  { domain: "login.microsoftonline.com" },
  { domain: "okta.com", tenants: true },
  { domain: "auth0.com", tenants: true },
  { domain: "clerk.accounts.dev", tenants: true },
  { domain: "cloudflareaccess.com", tenants: true },
  { domain: "github.com", path: "/login" },
  { domain: "vercel.com", path: "/sso-api" },
];

/** Hosts that serve only sign-in, such as Clerk's `accounts.<domain>`. */
const SIGN_IN_HOST = /^(?:accounts|login|sso)\./;

/** A sign-in page's whole path, such as `/login` or `/sign-in/`; a query may follow, a deeper path may not. */
const SIGN_IN_PATH = /^\/(?:login|signin|sign-in|sso|auth)\/?$/i;

function isIdentityProvider(url: URL): boolean {
  return SIGN_IN_HOST.test(url.hostname.toLowerCase()) || IDENTITY_PROVIDERS.some((provider) => isOn(url, provider));
}

const PASSWORD_FIELD = element("input", attribute("type", isKeyword("password")));

/** Imperva's challenge frame. Imperva also adds a script from the same path to pages it lets through. */
const IMPERVA_FRAME = element("iframe", attribute("src", inPath("/_Incapsula_Resource")));

/**
 * Bot walls, tested on the prototype's own last response: a vendor's
 * challenge header or frame, or a refusal status with the vendor's markers. A
 * vendor's words on a success never count, since articles quote them too.
 */
const BOT_WALLS: readonly ((hop: PageHop, page: ReadPage, body: string) => boolean)[] = [
  // Cloudflare, Vercel, and AWS WAF mark the challenges they serve.
  (hop) => /challenge/i.test(hop.headers["cf-mitigated"] ?? ""),
  (hop) => /challenge/i.test(hop.headers["x-vercel-mitigated"] ?? ""),
  (hop) => /challenge|captcha/i.test(hop.headers["x-amzn-waf-action"] ?? ""),
  (hop, _page, body) =>
    [403, 429, 503].includes(hop.status) && /cloudflare/i.test(hop.headers.server ?? "") && /Just a moment|Attention Required|\/cdn-cgi\/challenge-platform/i.test(body),
  // DataDome, HUMAN (PerimeterX), Imperva, Akamai, and Sucuri.
  (hop, _page, body) => hop.status === 403 && ("x-datadome" in hop.headers || /captcha-delivery\.com/.test(body)),
  (hop, _page, body) => hop.status === 403 && /px-captcha|_pxCaptcha/.test(body),
  (_hop, page) => matches(IMPERVA_FRAME, page),
  (hop, _page, body) => hop.status >= 400 && /Incapsula incident ID|_Incapsula_Resource/.test(body),
  (hop) => hop.status === 403 && /akamaighost/i.test(hop.headers.server ?? ""),
  (hop) => hop.status === 403 && "x-sucuri-id" in hop.headers,
];

/** Sign-in a host's page links to when it answers in place, such as Vercel Authentication on a preview. */
const SIGN_IN_LINKS: readonly SignInSite[] = [{ domain: "vercel.com", path: "/sso-api" }];

/** The host of a sign-in the page links to, from `SIGN_IN_LINKS`, or null. */
function signInLink(page: ReadPage, base: string): string | null {
  for (const found of page.html.elements) {
    const href = found.name === "a" ? found.attributes.get("href") : undefined;
    const url = href === undefined ? null : parseUrl(href, base);
    if (url !== null && SIGN_IN_LINKS.some((link) => isOn(url, link))) return url.hostname.toLowerCase();
  }
  return null;
}

/**
 * A host's password page that answers 200, by the password field it posts:
 * Vercel's `_vercel_password`. Any other page with a password field may be a
 * public page with a sign-in form, so it isn't guessed at.
 */
const PASSWORD_GATE = element("input", ...PASSWORD_FIELD.attributes, attribute("name", is("_vercel_password")));

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/** A host without `www.`, so `example.com` and `www.example.com` are one site. */
function site(url: URL | null): string | null {
  return url === null ? null : url.hostname.toLowerCase().replace(/^www\./, "");
}

function isRedirect(hop: PageHop): boolean {
  return hop.status >= 300 && hop.status < 400;
}

const PAGE_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);
const DOCUMENT_TAGS: ReadonlySet<string> = new Set(["html", "head", "body"]);

/**
 * Whether a response is a page someone could open: a success with a body, and
 * not sent as a download. It must say it's HTML or, naming no type, have a
 * doctype or an `html`, `head`, or `body` tag. 204 and 205 never carry one.
 */
function isPage(hop: PageHop, body: string, page: ReadPage): boolean {
  const type = hop.headers["content-type"];
  return (
    hop.status >= 200 &&
    hop.status < 300 &&
    hop.status !== 204 &&
    hop.status !== 205 &&
    (type === undefined ? page.html.doctype || page.html.elements.some((found) => DOCUMENT_TAGS.has(found.name)) : PAGE_TYPES.has(type.split(";", 1)[0]!.trim().toLowerCase())) &&
    !/^\s*attachment/i.test(hop.headers["content-disposition"] ?? "") &&
    body.trim() !== ""
  );
}

/** Every address the hops redirected to, in order. */
function redirectTargets(hops: readonly PageHop[]): URL[] {
  return hops.flatMap((hop) => {
    const location = isRedirect(hop) ? hop.headers.location : undefined;
    const target = location === undefined ? null : parseUrl(location, hop.url);
    return target === null ? [] : [target];
  });
}

/**
 * What a fetched address is, for the recommendation. `local` and `none` never
 * come from here: the caller knows them before fetching.
 */
export function classifyAddress(fetched: FetchedAddress): AddressCheck {
  const first = fetched.hops[0];
  const last = fetched.hops.at(-1);
  if (first === undefined || last === undefined) return { kind: "unreachable" };
  const body = fetched.html ?? "";
  const page = readPage(body, last.headers);

  // A sign-in page on the prototype's own site is part of the app, so it can
  // show the stack; an identity provider's page can't. A wall's page belongs
  // to the host, so only headers count.
  const ownSite = site(parseUrl(first.url));
  const appStack = () => (site(parseUrl(last.url)) === ownSite && last.status < 300 ? stackOf(page) : stackOf(readPage("", first.headers)));
  const headersOnly = () => stackOf(readPage("", last.headers));

  // Being sent to an identity provider is the sign-in, whatever its page
  // answers a bare request from a server, a bot challenge included: only the
  // prototype's own responses can say it's blocked.
  const targets = redirectTargets(fetched.hops);
  const provider = targets.find(isIdentityProvider);
  if (provider) return { kind: "sign-in", via: "redirect", host: provider.hostname, stack: appStack() };
  if (BOT_WALLS.some((wall) => wall(last, page, body))) return { kind: "blocked" };
  // A sign-in path where the redirects ended on a page; a `/login` that fails or was never reached says nothing.
  const endsOnPage = isPage(last, body, page);
  const destination = targets.length > 0 && endsOnPage ? parseUrl(last.url) : null;
  if (destination !== null && SIGN_IN_PATH.test(destination.pathname)) return { kind: "sign-in", via: "redirect", host: destination.hostname, stack: appStack() };
  if (last.status === 401 || last.status === 403) {
    const host = signInLink(page, last.url);
    if (host !== null) return { kind: "sign-in", via: "redirect", host, stack: appStack() };
    // Basic Auth, a host's password page, or another page that asks for credentials.
    if (last.status === 401 || matches(PASSWORD_FIELD, page)) return { kind: "sign-in", via: "password", host: null, stack: headersOnly() };
  }
  // Refused without a recognized wall, most often a firewall that doesn't know Critiqs's server.
  if (last.status === 403 || last.status === 429) return { kind: "blocked" };
  if (endsOnPage) {
    // A host's password page that answers 200 belongs to the host, like one that answers 401.
    if (matches(PASSWORD_GATE, page)) return { kind: "sign-in", via: "password", host: null, stack: headersOnly() };
    return { kind: "public", stack: stackOf(page) };
  }
  // A server error, no page (404, an empty success, or a file that isn't a page), or redirects that never reached one.
  return { kind: "unreachable" };
}

// The recommendation.

export type Way = "install" | "send-to-developer" | "extension" | "share-build" | "review-link" | "allow-critiqs";

/** Why, for the recommendation's one sentence. It describes the answers, so it stays when a way isn't available. */
export type RecommendationReason = "can-change-code" | "someone-else-changes-code" | "no-code-access" | "install-is-default";

export interface Recommendation {
  primary: Way;
  /** Other ways in, best first, never repeating `primary`. */
  others: readonly Way[];
  reason: RecommendationReason;
}

/**
 * The ways Critiqs offers today. `install` is always offered, whatever the set:
 * every other way leads back to it. Review links, shared builds, and Allow
 * Critiqs stay off until they are built; adding one here offers it wherever
 * the recommendation places it.
 */
export const AVAILABLE_WAYS: ReadonlySet<Way> = new Set<Way>(["install", "send-to-developer", "extension"]);

/**
 * Ways that work without installing, by what the address check found. The
 * extension works on any page a reviewer can open, so a public page offers it
 * after a review link, and in its place while review links are off.
 */
const WAYS_TODAY: Record<AddressCheck["kind"], readonly Way[]> = {
  public: ["review-link", "extension"],
  "sign-in": ["extension", "share-build"],
  local: ["extension", "share-build"],
  blocked: ["allow-critiqs", "extension"],
  unreachable: ["extension", "share-build"],
  none: [],
};

/** Ways that work only on a prototype at an address, so never before it has one. */
const NEEDS_AN_ADDRESS: ReadonlySet<Way> = new Set<Way>(["extension", "share-build", "review-link", "allow-critiqs"]);

/** Each answer to "Can you change the prototype's code?", with its ways in order. */
const RECOMMENDATIONS: Record<CodeAccess | "skipped", (today: readonly Way[]) => { ways: readonly Way[]; reason: RecommendationReason }> = {
  self: (today) => ({ ways: ["install", ...today, "send-to-developer"], reason: "can-change-code" }),
  teammate: (today) => ({ ways: ["send-to-developer", ...today, "install"], reason: "someone-else-changes-code" }),
  nobody: (today) => ({ ways: ["send-to-developer", ...today, "install"], reason: "no-code-access" }),
  // Installing is the main path.
  skipped: (today) => ({ ways: ["install", "send-to-developer", ...today], reason: "install-is-default" }),
};

/**
 * The way in to recommend, and the others to show below it. Engineers are
 * assumed to change the code unless they answered otherwise. Ways missing from
 * `available` are left out, and the next way takes the place of a missing one.
 */
export function recommend(answers: OnboardingAnswers, check: AddressCheck, available: ReadonlySet<Way>): Recommendation {
  const access = answers.codeAccess ?? (answers.role === "engineer" ? "self" : "skipped");
  // People outside the team won't install an extension, so a shared build comes first when they review.
  const outsiders = answers.feedbackFrom?.some((from) => from !== "team") ?? false;
  const today = outsiders ? [...WAYS_TODAY[check.kind]].sort((a, b) => Number(b === "share-build") - Number(a === "share-build")) : WAYS_TODAY[check.kind];
  const { ways, reason } = RECOMMENDATIONS[access](today);
  const offered = [...new Set(ways)].filter(
    (way) =>
      way === "install" ||
      (available.has(way) &&
        !(check.kind === "none" && NEEDS_AN_ADDRESS.has(way)) &&
        // Allowing Critiqs's server helps only review links.
        (way !== "allow-critiqs" || available.has("review-link"))),
  );
  // Every row includes `install`, so one way is always left.
  const [primary, ...others] = offered as [Way, ...Way[]];
  return { primary, others, reason };
}

// Starting tags.

const STARTING_TAGS: Record<Purpose, readonly string[]> = {
  qa: ["Bug", "Regression", "UX copy change", "User feedback"],
  "design-review": ["Design change request", "UX copy change", "Bug", "User feedback"],
  "user-testing": ["User feedback", "Bug", "UX copy change", "Design change request"],
};

/** A new project's tags, by what it's for. */
export function startingTags(purpose: Purpose | undefined): readonly string[] {
  return purpose === undefined ? DEFAULT_TAGS : STARTING_TAGS[purpose];
}

// Sending to a developer.

export const MAX_DEVELOPER_INVITES_PER_PROJECT = 3;
/** Developer emails one person can send in a day, across projects. */
export const DEVELOPER_INVITES_PER_PERSON_PER_DAY = 5;
/** How long after a developer's email went out the steps can be sent to them again. */
export const DEVELOPER_RESEND_AFTER_MS = 24 * 60 * 60 * 1000;
/** How many times one developer can be sent a project's steps again. */
export const MAX_DEVELOPER_RESENDS = 2;

/**
 * A limit that refused a developer email: the project's developers, the
 * person's day, the inbox's day, or the deployment's hour; for sending the
 * steps again, the 24 hours since the last email (`wait`) or the resends used
 * up (`resends`).
 */
export type DeveloperLimit = "developers" | "person" | "inbox" | "deployment" | "wait" | "resends";

/**
 * What a send did about the developer joining the project's organization,
 * which happens only when an admin of it sends. `created`: they were invited
 * and join when they sign in. `pending`: an invite to it was already
 * waiting. `member`: they're already in it. `limit`: the organization's
 * invites for the day were used up, so they weren't invited. `none`: the
 * sender isn't an admin of it, so no one is invited.
 */
export type DeveloperInvite = "created" | "pending" | "member" | "limit" | "none";

/**
 * What sending setup steps did for one address, as given. `sent`: Critiqs
 * took the email to send, and `invite` says what it did about the project's
 * organization, separately from the email. `already-sent`: the address
 * already got this project's email, or may have; each address gets one. A
 * refused address (`already-sent`, `limit`, `suppressed`, or `invalid`) left
 * nothing recorded and used no limit.
 */
export type DeveloperSendResult =
  | { email: string; status: "sent"; sendId: string; invite: DeveloperInvite }
  | { email: string; status: "already-sent"; sendId: string }
  | { email: string; status: "limit"; limit: DeveloperLimit; message: string }
  | { email: string; status: "suppressed" }
  | { email: string; status: "invalid"; message: string };

/**
 * A developer setup email's state. `sent`: the mail service took it.
 * `failed`: it certainly wasn't delivered, because every attempt was
 * refused, or its inbox opted out before the first; sending again sends a
 * new email. `uncertain`: not answered yet, or an answer was lost, so it may
 * have been delivered; it counts as sent and is retried only under its own
 * key.
 */
export type DeveloperSendStatus = "sent" | "uncertain" | "failed";

/** One address a project sent setup steps to, for the people who manage it. */
export interface DeveloperSendSummary {
  sendId: string;
  email: string;
  status: DeveloperSendStatus;
  /** When the email went out: the attempt the mail service accepted, else its first attempt, else when it was reserved. */
  lastSentAt: number;
  /**
   * When the steps can be sent to this address again, 24 hours after the
   * email went out; null when they can't: a failed email is sent again at
   * once instead, an address that was sent them again twice gets no more,
   * and an inbox that reported Critiqs's email gets nothing. Absent from
   * backends that can't send them again.
   */
  resendAt?: number | null;
  /** True when the address's inbox reported Critiqs's email as unwanted, so nothing more is sent to it; absent otherwise. */
  suppressed?: boolean;
}

/** What a project's setup page shows: the project, its address, its saved stack, and how to install Critiqs in it. */
export interface ProjectSetup {
  projectId: string;
  projectName: string;
  /** The project's review address, shown as text. */
  address: string | null;
  stack: StackInfo | null;
  /** `installCommands` for the stack. Newer clients work them out from `stack` instead, so older backends' answers show today's commands. */
  installCommands: readonly string[] | null;
  /**
   * Whether Critiqs has loaded at the project's own address (its review
   * address, or an address its list matches): when it last did, and that
   * page's origin (only for the people the saved stack is shown to). Null
   * until then; absent from older backends, which don't record it.
   */
  connected?: ProjectConnection | null;
}

/** When Critiqs last loaded at a project's own address, and on which origin, if the reader may see it. */
export interface ProjectConnection {
  at: number;
  origin: string | null;
  /** True for the people who manage the project, who may clear it; absent otherwise, and from older backends. */
  clearable?: boolean;
}

/**
 * The origin a browser reported for a page that loaded Critiqs, as a project
 * records it: an `http:` or `https:` origin and nothing else, such as
 * `https://acme-proto.vercel.app`; null for anything else, including the
 * extension's own pages and requests that name no origin.
 */
export function connectionOrigin(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

/** What a setup link shows the developer it was sent to: the project's setup, and who asked. */
export interface DeveloperSetup extends ProjectSetup {
  inviterName: string;
}

/**
 * The commands, in order, that add Critiqs to an app built with `stack`, for
 * a project ID the backend issued: the stack's Critiqs package, then
 * `critiqs init`, which adds Critiqs where the app renders. For an unknown
 * stack only `critiqs init`, which finds the framework and names its
 * package. Null for a stack with no package, which uses the script tag.
 */
export function installCommands(projectId: string, stack: StackId | null): readonly string[] | null {
  // The commands are pasted into a terminal, so only a real project ID goes in them.
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Not a Critiqs project ID: ${JSON.stringify(projectId)}`);
  const init = `npx critiqs init ${projectId}`;
  if (stack === null) return [init];
  const install = STACK_LIST.find((candidate) => candidate.id === stack)?.install ?? null;
  return install === null ? null : [install, init];
}

/**
 * How an app built with `stack` is told to use a backend other than Critiqs
 * Cloud, which `npx critiqs init <projectId>` doesn't write: `setting`, the
 * code to add, and `where`, completing "add this …". Each is the form the
 * stack's Critiqs package reads: a property on the component, an option in
 * the framework's config, `critiqs_tag`'s argument, Django's `CRITIQS`
 * setting, Flask's config, or the script tag's `data-backend`. For an
 * unknown stack, the backend's address on its own.
 */
export function backendSetting(stack: StackId | null, backend: string): { where: string; setting: string } {
  const url = JSON.stringify(backend);
  const form = STACK_LIST.find((candidate) => candidate.id === stack)?.backend ?? null;
  switch (form) {
    case "component":
      return { where: "on the <Critiqs /> component init added", setting: `backend=${url}` };
    case "nuxt":
      return { where: "to nuxt.config, beside the critiqs-nuxt module init added", setting: `critiqs: { backend: ${url} }` };
    case "astro":
      return { where: "in astro.config, as the option of the critiqs() integration init added", setting: `critiqs({ backend: ${url} })` };
    case "angular":
      return { where: "inside the provideCritiqs({ … }) call init added", setting: `backend: ${url},` };
    case "rails":
      return { where: "in the layout, in place of the <%= critiqs_tag %> init added", setting: `<%= critiqs_tag(backend: ${url}) %>` };
    case "django":
      return { where: "to the settings module (settings.py)", setting: `CRITIQS = {"BACKEND": ${url}}` };
    case "flask":
      return { where: "after app = Flask(__name__), where init added Critiqs(app)", setting: `app.config["CRITIQS_BACKEND"] = ${url}` };
    case "script":
      return { where: "to the script tag", setting: `data-backend=${url}` };
    case null:
      return { where: "as Critiqs's backend where init added it (its framework package's README shows the setting)", setting: backend };
    default: {
      const exhaustive: never = form;
      return exhaustive;
    }
  }
}

/** "A, B, or C". */
export function listOr(items: readonly string[]): string {
  return items.length < 3 ? items.join(" or ") : `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

/** Critiqs Cloud's Convex deployment, which a prototype uses when it names no backend. */
export const HOSTED_BACKEND_URL = "https://brazen-snail-591.convex.cloud";

/** Project IDs from either backend: Convex IDs, or SQLite's `p_` IDs. Matches critiqs-react's `PROJECT_ID_PATTERN`. */
export const PROJECT_ID_PATTERN = /^([a-z0-9]{16,64}|p_[0-9a-f]{32})$/;

/**
 * The message someone copies to ask their developer to install Critiqs, for
 * example over Slack. Plain text. A stack with no Critiqs package gets the
 * script tag's guide and the project ID instead of commands.
 */
export function developerMessage(args: { projectName: string; address: string | null; stack: StackId | null; projectId: string; setupUrl: string }): string {
  const name = args.projectName.trim() || "our prototype";
  const where = args.address === null ? "" : ` at ${args.address.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const ask = `Can you add Critiqs to ${name}${where}? It lets us comment right on the prototype.`;
  const stack = STACKS.find((candidate) => candidate.id === args.stack) ?? null;
  const commands = installCommands(args.projectId, stack?.id ?? null);
  let how: string;
  if (commands === null) {
    how = `It's built with ${stack!.label}, which has no Critiqs package, so add Critiqs with a script tag on every page: ${SCRIPT_TAG_GUIDE}\nProject ID: ${args.projectId}`;
  } else if (stack === null) {
    how = `Run this in its folder. It finds the framework (${listOr(PACKAGE_STACK_NAMES)}) and adds Critiqs:\n${commands.join("\n")}`;
  } else {
    how = `It's built with ${stack.label}, so run these in its folder:\n${commands.join("\n")}`;
  }
  return [ask, how, `Setup page: ${args.setupUrl}`].join("\n\n");
}
