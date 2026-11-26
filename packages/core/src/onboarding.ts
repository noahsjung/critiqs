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

/**
 * Every stack someone can pick, installable ones first. Installable means
 * Critiqs can be installed there today, with `installCommands`: `critiqs init`
 * supports React apps built with Vite or Next.js. The others turn installable
 * as their framework packages ship.
 */
const STACK_LIST = [
  { id: "react", label: "React (Vite)", installable: true },
  { id: "next", label: "Next.js", installable: true },
  { id: "angular", label: "Angular", installable: false },
  { id: "astro", label: "Astro", installable: false },
  { id: "django", label: "Django", installable: false },
  { id: "flask", label: "Flask", installable: false },
  { id: "gatsby", label: "Gatsby", installable: false },
  { id: "laravel", label: "Laravel", installable: false },
  { id: "nuxt", label: "Nuxt", installable: false },
  { id: "rails", label: "Rails", installable: false },
  { id: "remix", label: "Remix or React Router", installable: false },
  { id: "solid", label: "Solid", installable: false },
  { id: "svelte", label: "Svelte", installable: false },
  { id: "sveltekit", label: "SvelteKit", installable: false },
  { id: "vue", label: "Vue", installable: false },
  { id: "wordpress", label: "WordPress", installable: false },
] as const satisfies readonly { id: string; label: string; installable: boolean }[];

export type StackId = (typeof STACK_LIST)[number]["id"];

export interface StackInfo {
  id: StackId;
  label: string;
  installable: boolean;
}

export const STACKS: readonly StackInfo[] = STACK_LIST;

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
 * every other way leads back to it.
 */
export const AVAILABLE_WAYS: ReadonlySet<Way> = new Set<Way>(["install", "send-to-developer"]);

/** Ways that work without installing, by what the address check found. */
const WAYS_TODAY: Record<AddressCheck["kind"], readonly Way[]> = {
  public: ["review-link"],
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
/** How long after an invite its Resend is offered. */
export const DEVELOPER_INVITE_RESEND_MS = 24 * 60 * 60 * 1000;
/** Developer emails one person can send in a day, across projects. */
export const DEVELOPER_INVITES_PER_PERSON_PER_DAY = 5;

/** The commands, in order, that install Critiqs in an installable stack, for a project ID the backend issued. */
export function installCommands(projectId: string): readonly string[] {
  // The commands are pasted into a terminal, so only a real project ID goes in them.
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Not a Critiqs project ID: ${JSON.stringify(projectId)}`);
  // `init` adds <Critiqs /> and writes the project ID but doesn't add the dependency.
  return ["npm install critiqs-react", `npx critiqs-react init ${projectId}`];
}

/** Project IDs from either backend: Convex IDs, or SQLite's `p_` IDs. Matches critiqs-react's `PROJECT_ID_PATTERN`. */
export const PROJECT_ID_PATTERN = /^([a-z0-9]{16,64}|p_[0-9a-f]{32})$/;

/**
 * The message someone copies to ask their developer to install Critiqs, for
 * example over Slack. Plain text. A stack Critiqs can't be installed in yet
 * gets no command, only the setup page.
 */
export function developerMessage(args: { projectName: string; address: string | null; stack: StackId | null; projectId: string; setupUrl: string }): string {
  const name = args.projectName.trim() || "our prototype";
  const where = args.address === null ? "" : ` at ${args.address.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const ask = `Can you add Critiqs to ${name}${where}? It lets us comment right on the prototype.`;
  const commands = installCommands(args.projectId).join("\n");
  const stack = STACKS.find((candidate) => candidate.id === args.stack) ?? null;
  let how: string;
  if (stack === null) {
    const installable = STACKS.filter((candidate) => candidate.installable).map((candidate) => candidate.label);
    how = `If it's built with ${installable.join(" or ")}, run these in its folder:\n${commands}`;
  } else if (stack.installable) {
    how = `It's built with ${stack.label}, so run these in its folder:\n${commands}`;
  } else {
    how = `It's built with ${stack.label}, and Critiqs can't be added to ${stack.label} apps yet.`;
  }
  return [ask, how, `Setup page: ${args.setupUrl}`].join("\n\n");
}
