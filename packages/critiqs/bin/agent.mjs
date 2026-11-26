/**
 * Reading a project's feedback from the command line and coding agents: a
 * sign-in kept on this computer, and the comments, threads, screenshots, and
 * mockups behind `critiqs_comments`, `critiqs_thread`, `critiqs_screenshot`,
 * `critiqs_mockups`, and `critiqs_mockup`.
 * Dependency-free, like setup.mjs, so it runs under Node and Bun without a build.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { callConvex, CLOUD_BACKEND_URL, isHeadless, resolveBackend, SetupError, startRemoteSignIn } from "./setup.mjs";
import { findElements } from "./markup.mjs";

/** Raised when this computer has no usable sign-in; the message says how to sign in. */
export class NotSignedInError extends SetupError {}

const SIGN_IN_HINT = "Sign in once on this computer with the critiqs_sign_in tool, or run `npx critiqs sign-in`.";

// ---------------------------------------------------------------------------
// The sign-in kept on this computer

/**
 * Where this computer keeps its Critiqs sign-in: `CRITIQS_CONFIG_DIR`, or the
 * user's configuration folder. Only the owner can read it.
 */
export function credentialsFile(env = process.env, platform = process.platform) {
  if (env.CRITIQS_CONFIG_DIR) return join(env.CRITIQS_CONFIG_DIR, "sign-in.json");
  const base =
    platform === "win32" ? env.APPDATA || join(homedir(), "AppData", "Roaming") : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "critiqs", "sign-in.json");
}

function readSignIns(file) {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8"));
    if (stored?.version === 1 && typeof stored.services === "object" && stored.services !== null) return stored;
  } catch {}
  return { version: 1, services: {} };
}

/** Replaces the file in one step, readable only by its owner. */
function writeSignIns(file, stored) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {}
  renameSync(temporary, file);
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Requests made while holding the lock give up long before the lock counts as abandoned. */
const REQUEST_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

/** A request to the sign-in service that gives up after `REQUEST_TIMEOUT_MS`. */
function timed(fetchFn, url, init) {
  return fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/**
 * Runs `work` while holding a lock beside the file, so two agents on this
 * computer don't both spend the same refresh token. A lock left by a process
 * that died is taken over after `staleMs`; work under the lock makes only
 * requests that time out sooner. A lock is removed only by its owner.
 */
async function withLock(file, work, { waitMs = 15_000, staleMs = STALE_LOCK_MS } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const owner = randomBytes(12).toString("hex");
  const started = Date.now();
  for (;;) {
    try {
      writeFileSync(lock, owner, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) rmSync(lock, { force: true });
      } catch {}
      if (Date.now() - started > waitMs) throw new SetupError("Another Critiqs process is using this computer's sign-in. Try again in a moment.");
      await pause(50 + Math.random() * 100);
    }
  }
  try {
    return await work();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === owner) rmSync(lock, { force: true });
    } catch {}
  }
}

/** A token's claims, unchecked: only to show who it names and when it expires. The backend checks the token itself. */
function claimsOf(accessToken) {
  try {
    return JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")) ?? {};
  } catch {
    return {};
  }
}

function tokenReviewer(accessToken) {
  const claims = claimsOf(accessToken);
  return { name: typeof claims.name === "string" ? claims.name : null, email: typeof claims.email === "string" ? claims.email : null };
}

/** When a token expires, from its claims; soon, when it doesn't say. */
function tokenExpiry(accessToken, now) {
  const { exp } = claimsOf(accessToken);
  return typeof exp === "number" ? exp * 1000 : now() + 5 * 60_000;
}

/** Who this computer is signed in as for a sign-in service, or null. Never returns tokens. */
export function savedSignIn(signInUrl, { env = process.env } = {}) {
  const entry = readSignIns(credentialsFile(env)).services[signInUrl];
  return entry === undefined ? null : { reviewer: entry.reviewer, signedInAt: entry.signedInAt, endsAt: entry.endsAt ?? null };
}

/** Saves a sign-in, unless `cancelled()` says not to by the time the lock is held; then returns null. */
function saveSignIn(env, signInUrl, { origin, accessToken, accessExpiresAt, refreshToken, endsAt = null, reviewer, now, cancelled = () => false }) {
  const file = credentialsFile(env);
  return withLock(file, async () => {
    // Checked under the lock, which signing out also holds, so a sign-out that happened first wins.
    if (cancelled()) return null;
    const stored = readSignIns(file);
    stored.services[signInUrl] = {
      origin,
      refreshToken,
      accessToken,
      accessExpiresAt,
      endsAt,
      reviewer: reviewer ?? tokenReviewer(accessToken),
      signedInAt: now(),
    };
    writeSignIns(file, stored);
    return stored.services[signInUrl];
  });
}

/**
 * A current access token for the sign-in service, refreshing the saved
 * session when the last token is nearly used up. A session that ended is
 * removed, and the caller is told to sign in again.
 */
export async function accessTokenFor(signInUrl, { env = process.env, fetchFn = fetch, now = Date.now } = {}) {
  const file = credentialsFile(env);
  const usable = (entry) => typeof entry?.accessToken === "string" && entry.accessExpiresAt - now() > 60_000;
  const notSignedIn = () => new NotSignedInError(`This computer isn't signed in to Critiqs. ${SIGN_IN_HINT}`);
  const first = readSignIns(file).services[signInUrl];
  if (first === undefined) throw notSignedIn();
  if (usable(first)) return first.accessToken;
  return await withLock(file, async () => {
    // Another process may have refreshed while this one waited for the lock.
    const stored = readSignIns(file);
    const entry = stored.services[signInUrl];
    if (entry === undefined) throw notSignedIn();
    if (usable(entry)) return entry.accessToken;
    let response;
    try {
      response = await timed(fetchFn, `${signInUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: entry.origin },
        body: JSON.stringify({ refreshToken: entry.refreshToken }),
      });
    } catch {
      throw new SetupError(`Can't reach Critiqs's sign-in service at ${signInUrl}.`);
    }
    if (response.status === 401) {
      // Forget the sign-in only if no one replaced it meanwhile.
      const latest = readSignIns(file);
      if (latest.services[signInUrl]?.refreshToken !== entry.refreshToken) {
        if (latest.services[signInUrl] !== undefined && usable(latest.services[signInUrl])) return latest.services[signInUrl].accessToken;
        throw new SetupError("This computer's Critiqs sign-in changed while renewing. Try again.");
      }
      delete latest.services[signInUrl];
      writeSignIns(file, latest);
      throw new NotSignedInError(`This computer's Critiqs sign-in ended (signed out, or unused for 30 days). ${SIGN_IN_HINT}`);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.accessToken !== "string" || typeof body.refreshToken !== "string") {
      throw new SetupError(`Critiqs's sign-in service couldn't renew this computer's sign-in (${response.status}). Try again.`);
    }
    stored.services[signInUrl] = {
      ...entry,
      refreshToken: body.refreshToken,
      accessToken: body.accessToken,
      accessExpiresAt: typeof body.expiresAt === "number" ? body.expiresAt : tokenExpiry(body.accessToken, now),
      reviewer: tokenReviewer(body.accessToken),
    };
    writeSignIns(file, stored);
    return body.accessToken;
  });
}

/** Resolved backends, so each tool call doesn't ask again. */
const backends = new Map();

async function backendFor(backendUrl, fetchFn) {
  const url = (backendUrl || CLOUD_BACKEND_URL).replace(/\/$/, "");
  const known = backends.get(url);
  if (known !== undefined && known.fetchFn === fetchFn && Date.now() - known.at < 5 * 60_000) return known.backend;
  const backend = await resolveBackend(url, { fetchFn });
  if (backend.transport === "http") {
    throw new SetupError(
      `${url} is a Critiqs server inside your app. Reading feedback from the command line works with Critiqs Cloud and Convex deployments; open the app's Critiqs sidebar instead.`,
    );
  }
  backends.set(url, { backend, fetchFn, at: Date.now() });
  return backend;
}

/**
 * Starts signing this computer in for reading feedback. It is always approved
 * with a short code on the sign-in service's own page, which says the computer
 * stays signed in and for how long: `"browser"` also opens that page on this
 * computer, `"remote"` only shows it for any device, and `"auto"` opens it
 * when this computer has a desktop. `finish()` waits, then keeps the sign-in
 * on this computer for up to 30 days unused, 90 at most.
 */
export async function beginSignIn({ backendUrl, method = "auto", env = process.env, fetchFn = fetch, sleep, now = Date.now } = {}) {
  const { signInUrl } = await backendFor(backendUrl, fetchFn);
  const remote = await startRemoteSignIn({ signInUrl, fetchFn, now, keepSignedIn: true, ...(sleep ? { sleep } : {}) });
  let cancelled = false;
  return {
    method: method === "auto" ? (isHeadless(env) ? "remote" : "browser") : method,
    url: remote.url,
    userCode: remote.userCode,
    signInUrl,
    cancel: () => {
      cancelled = true;
      remote.close();
    },
    finish: async () => {
      const tokens = await remote.tokens;
      const saved = await saveSignIn(env, signInUrl, {
        // The session belongs to the sign-in service itself; no prototype is involved.
        origin: new URL(signInUrl).origin,
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken,
        endsAt: tokens.sessionEndsAt ?? null,
        reviewer: tokens.reviewer,
        now,
        cancelled: () => cancelled,
      });
      if (saved === null) {
        // Approved after it was cancelled, such as by signing out: end that session rather than keep it.
        await timed(fetchFn, `${signInUrl}/auth/sign-out`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: new URL(signInUrl).origin },
          body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        }).catch(() => undefined);
        throw new SetupError("This sign-in was cancelled.");
      }
      return { reviewer: saved.reviewer, endsAt: saved.endsAt, signInUrl };
    },
  };
}

/**
 * Ends this computer's sign-in with the service, then forgets it. Returns who
 * was signed in and whether the service found the session to end, or null when
 * this computer wasn't signed in. If the service can't be reached or refuses,
 * the sign-in is kept so signing out can be tried again. A session the service
 * didn't find was already ended, or was replaced by a renewal whose answer was
 * lost; no one holds that one's token, and it ends after 30 days without use.
 */
export async function signOutComputer({ backendUrl, env = process.env, fetchFn = fetch } = {}) {
  const { signInUrl } = await backendFor(backendUrl, fetchFn);
  const file = credentialsFile(env);
  return await withLock(file, async () => {
    const stored = readSignIns(file);
    const entry = stored.services[signInUrl];
    if (entry === undefined) return null;
    let answered = false;
    let found = true;
    try {
      const response = await timed(fetchFn, `${signInUrl}/auth/sign-out`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: entry.origin },
        body: JSON.stringify({ refreshToken: entry.refreshToken }),
      });
      answered = response.ok;
      found = response.headers.get("Critiqs-Session-Ended") !== "false";
    } catch {}
    if (!answered) {
      throw new SetupError(`Critiqs's sign-in service at ${signInUrl} didn't confirm signing out, so this computer is still signed in. Try again when it's reachable.`);
    }
    delete stored.services[signInUrl];
    writeSignIns(file, stored);
    return { reviewer: entry.reviewer ?? null, found };
  });
}

// ---------------------------------------------------------------------------
// Reading feedback

async function connect({ backendUrl, env, fetchFn, now }) {
  const backend = await backendFor(backendUrl, fetchFn);
  const accessToken = await accessTokenFor(backend.signInUrl, { env, fetchFn, now });
  const query = (path, args) => callConvex(backend.backendUrl, "query", path, args, accessToken, { fetchFn });
  const mutate = (path, args) => callConvex(backend.backendUrl, "mutation", path, args, accessToken, { fetchFn });
  return { backend, accessToken, query, mutate };
}

/** Refuses a backend whose `/critiqs/config` doesn't report `flag`, before anything is read or posted. */
async function requireFeature(backend, fetchFn, flag, missing) {
  const config = await fetchFn(`${backend.siteUrl}/critiqs/config`).then((response) => response.json()).catch(() => null);
  if (config?.[flag] !== true) {
    throw new SetupError(`The Critiqs backend at ${backend.backendUrl} runs an older version that ${missing} yet. Its operator needs to deploy the current Critiqs backend.`);
  }
}

/** Every page of a paginated query; 40 items a page, as every backend allows. */
async function allPages(load, maxPages = 500) {
  const items = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const result = await load({ numItems: 40, cursor });
    if (!Array.isArray(result?.page) || typeof result.isDone !== "boolean") throw new SetupError("The backend returned an invalid page.");
    items.push(...result.page);
    if (result.isDone) return { items, rest: result };
    if (typeof result.continueCursor !== "string" || result.continueCursor === "" || seen.has(result.continueCursor)) {
      throw new SetupError("Reading feedback stopped because the backend's pages didn't advance.");
    }
    seen.add(result.continueCursor);
    cursor = result.continueCursor;
  }
  throw new SetupError("There is too much to read at once.");
}

/** Runs `work` over items with at most `limit` at a time, keeping order. */
async function mapLimited(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** A Critiqs link from the thread's or message's ID, as sign-in and the sidebar read it. */
function feedbackLink(base, threadId, messageId = null) {
  if (typeof base !== "string" || base === "") return null;
  try {
    const url = new URL(base);
    const value = messageId === null ? threadId : `${threadId}.${messageId}`;
    if (url.searchParams.has("critiqs")) url.searchParams.set("critiqs", value);
    else url.search = `${url.search === "" ? "?" : `${url.search}&`}critiqs=${encodeURIComponent(value)}`;
    return url.toString();
  } catch {
    return null;
  }
}

/** A thread ID from an ID or a Critiqs link (`?critiqs=<thread>.<message>`). */
export function threadIdOf(value) {
  if (typeof value !== "string" || value.trim() === "") throw new SetupError("Give a thread ID or a Critiqs link.");
  const text = value.trim();
  if (!/^[a-z]+:\/\//i.test(text)) return { threadId: text, messageId: null };
  let found = null;
  try {
    found = new URL(text).searchParams.get("critiqs");
  } catch {}
  if (!found) throw new SetupError("That link has no Critiqs thread in it (no critiqs= parameter).");
  const [threadId, messageId] = found.split(".");
  return { threadId, messageId: messageId || null };
}

/** Trimmed text, or null when absent or blank. */
const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

function projectIdOf(args) {
  const projectId = nonEmpty(args.projectId);
  if (projectId === null) throw new SetupError("Give the project's ID (projectId), as Project setup in the Critiqs sidebar shows it.");
  return projectId;
}

const iso = (time) => (typeof time === "number" ? new Date(time).toISOString() : null);

function targetOf(location) {
  const target = location.target ?? {};
  const clues = target.clues ?? {};
  return {
    purposeId: target.purposeId ?? null,
    recordKey: target.recordKey ?? null,
    label: clues.label ?? null,
    role: clues.role ?? null,
    tagName: clues.tagName ?? null,
    path: clues.path ?? null,
  };
}

/** The context needed to understand and find a thread's feedback in the prototype and its code. */
function contextOf(anchor, location) {
  const evidence = anchor.evidence ?? {};
  return {
    screen: anchor.screen,
    viewState: anchor.viewState ?? {},
    scope: anchor.scope,
    target: targetOf(anchor),
    page: {
      url: evidence.url ?? null,
      viewport: evidence.viewport ?? null,
      persona: evidence.persona ?? null,
      revision: evidence.revision ?? null,
      browser: evidence.userAgent ?? null,
      capturedAt: iso(evidence.capturedAt),
      marker: evidence.marker ?? null,
    },
    // Reattached threads point at a replacement target; `target` above stays the original.
    movedTo:
      location === null || location === undefined
        ? null
        : { screen: location.screen, viewState: location.viewState ?? {}, scope: location.scope, target: targetOf(location) },
  };
}

/** A message as agents read it. Critiqs AI's replies are written for the person who asked (`askedBy`), with the mockup version they saved. */
function shapeMessage(message, links) {
  const authorId = message.authorId ?? message.author?._id ?? null;
  const name = typeof message.author === "string" ? message.author : (message.author?.name ?? "Unknown");
  const ai = message.via === "ai";
  return {
    id: message._id,
    link: links(message._id),
    authorId,
    author: ai ? "Critiqs AI" : name,
    createdAt: iso(message.createdAt),
    editedAt: iso(message.editedAt),
    revision: message.revision ?? null,
    body: message.body,
    ...(message.via === "agent" || ai ? { via: message.via } : {}),
    ...(ai ? { askedBy: name } : {}),
    ...(typeof message.mockupVersion === "number" ? { mockupVersion: message.mockupVersion } : {}),
  };
}

// --- Filters

const STATUSES = ["open", "resolved", "all"];

/** A time from an ISO date or date-time, or a relative age such as `7d` or `12h`; null when absent. */
export function parseTime(value, name, now = Date.now(), endOfDay = false) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim();
  const relative = /^(\d+)\s*([mhdw])$/i.exec(text);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2].toLowerCase()];
    return now - Number(relative[1]) * unit;
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const time = Date.parse(dateOnly ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(time)) throw new SetupError(`${name} must be a date such as 2026-10-01, a date and time, or an age such as 7d.`);
  // A date alone covers that whole day (UTC) when it is the end of a range.
  return dateOnly && endOfDay ? time + 86_400_000 - 1 : time;
}

/** Tags compare as Critiqs keys them: case, spaces, underscores, and a leading # don't matter. */
const tagKey = (tag) => String(tag).normalize("NFKC").trim().replace(/^#/, "").toLowerCase().replace(/[\s_]+/g, "-");

/** Reads the filters an agent passed, refusing ones that can't be understood. */
export function readFilters(args, now = Date.now()) {
  const status = args.status === undefined || args.status === null || args.status === "" ? "open" : String(args.status);
  if (!STATUSES.includes(status)) throw new SetupError('status must be "open", "resolved", or "all".');
  const since = parseTime(args.since, "since", now);
  const until = parseTime(args.until, "until", now, true);
  if (since !== null && until !== null && since > until) throw new SetupError("since must be before until.");
  const limit = args.limit === undefined || args.limit === null ? 50 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new SetupError("limit must be a whole number from 1 to 500.");
  return { status, since, until, limit, author: nonEmpty(args.author), tag: nonEmpty(args.tag), screen: nonEmpty(args.screen), text: nonEmpty(args.text) };
}

/** Which author IDs an author filter means: an ID, or a display name (any case). Refuses a name two people share. */
function authorIds(filter, threads) {
  const people = new Map();
  for (const thread of threads) for (const message of thread.messages) if (message.authorId !== null) people.set(message.authorId, message.author);
  if (people.has(filter)) return { ids: new Set([filter]), names: null };
  const wanted = filter.toLowerCase();
  const matching = [...people].filter(([, name]) => name.toLowerCase() === wanted);
  if (matching.length > 1) {
    throw new SetupError(
      `${matching.length} people are named "${filter}": ${matching.map(([id, name]) => `${name} (${id})`).join(", ")}. Pass the author's ID instead.`,
    );
  }
  // Messages from backends without author IDs can only match by name.
  return { ids: new Set(matching.map(([id]) => id)), names: wanted };
}

/**
 * A project's feedback threads with their whole discussions and context,
 * filtered by status, author, when messages were written, tag, screen, and
 * text. Message filters (author, since, until, text) keep a thread when any
 * of its messages matches, and mark which ones did.
 */
export async function listComments(args, { env = process.env, fetchFn = fetch, now = Date.now } = {}) {
  const projectId = projectIdOf(args);
  const filters = readFilters(args, now());
  const { query } = await connect({ backendUrl: args.backend, env, fetchFn, now });
  const project = await query("projects:get", { projectId });
  const { items: summaries } = await allPages((paginationOpts) => query("threads:list", { projectId, paginationOpts }));

  // Narrow with what the list already shows before reading whole discussions.
  const candidates = summaries.filter((thread) => {
    if (filters.status !== "all" && thread.status !== filters.status) return false;
    if (filters.tag !== null && !(thread.tags ?? []).some((tag) => tagKey(tag) === tagKey(filters.tag))) return false;
    if (filters.screen !== null && thread.anchor.screen !== filters.screen && thread.location?.screen !== filters.screen) return false;
    if (filters.since !== null && thread.lastMessageAt < filters.since) return false;
    if (filters.until !== null && thread.createdAt > filters.until) return false;
    return true;
  });

  // Author, time, and text are decided on whole discussions. Without them the
  // list decides, so only the discussions to return are read.
  const messageFilters = filters.author !== null || filters.since !== null || filters.until !== null || filters.text !== null;
  candidates.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  const toRead = messageFilters ? candidates : candidates.slice(0, filters.limit);

  const linkBase = (thread) => project.reviewUrl ?? thread.anchor.evidence?.url ?? null;
  const threads = (
    await mapLimited(toRead, 6, async (summary) => {
      const exported = await readExport(query, projectId, summary._id);
      if (exported === null) return null;
      const base = linkBase(summary);
      const links = (messageId) => feedbackLink(base, summary._id, messageId);
      const messages = exported.messages.map((message) => shapeMessage(message, links));
      return {
        id: summary._id,
        link: feedbackLink(base, summary._id),
        status: exported.thread.status,
        tags: exported.thread.tags,
        startedBy: messages[0] ? { id: messages[0].authorId, name: messages[0].author } : null,
        createdAt: iso(summary.createdAt),
        lastMessageAt: iso(summary.lastMessageAt),
        messageCount: messages.length,
        hasScreenshot: exported.thread.hasCapture,
        context: contextOf(exported.thread.anchor, exported.thread.location),
        messages,
        lastMessageTime: summary.lastMessageAt,
      };
    })
  ).filter((thread) => thread !== null);

  const author = filters.author === null ? null : authorIds(filters.author, threads);
  const matches = (message) => {
    const time = Date.parse(message.createdAt);
    if (filters.since !== null && time < filters.since) return false;
    if (filters.until !== null && time > filters.until) return false;
    if (author !== null) {
      const byId = message.authorId !== null && author.ids.has(message.authorId);
      const byName = message.authorId === null && author.names !== null && message.author.toLowerCase() === author.names;
      if (!byId && !byName) return false;
    }
    return filters.text === null || message.body.toLowerCase().includes(filters.text.toLowerCase());
  };
  const kept = [];
  for (const thread of threads) {
    if (messageFilters) {
      let any = false;
      for (const message of thread.messages) {
        message.matches = matches(message);
        any ||= message.matches;
      }
      if (!any) continue;
    }
    kept.push(thread);
  }
  kept.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  const returned = kept.slice(0, filters.limit).map(({ lastMessageTime, ...thread }) => thread);
  // Unread matches still count; a thread deleted while reading doesn't.
  const total = messageFilters ? kept.length : candidates.length - (toRead.length - threads.length);
  return {
    project: { id: projectId, name: project.name, reviewUrl: project.reviewUrl ?? null },
    filters: {
      status: filters.status,
      author: filters.author,
      since: iso(filters.since),
      until: iso(filters.until),
      tag: filters.tag,
      screen: filters.screen,
      text: filters.text,
      limit: filters.limit,
    },
    total,
    returned: returned.length,
    truncated: total > returned.length,
    threads: returned,
  };
}

/** One thread's export, every page; null when it was deleted or isn't in the project. */
async function readExport(query, projectId, threadId) {
  let thread = null;
  const messages = [];
  let cursor = null;
  for (let page = 0; page < 500; page++) {
    const result = await query("threads:exportThreads", { projectId, threadIds: [threadId], threadIndex: 0, paginationOpts: { numItems: 40, cursor } });
    if (result.thread === null) return null;
    thread ??= result.thread;
    messages.push(...result.page);
    if (result.isDone) return { thread, messages };
    if (result.continueCursor === cursor) throw new SetupError("Reading a thread stopped because its pages didn't advance.");
    cursor = result.continueCursor;
  }
  throw new SetupError("That thread is too long to read at once.");
}

/** One thread's whole discussion and context, including mentions, reactions, and who resolved or moved it. */
export async function readThread(args, { env = process.env, fetchFn = fetch, now = Date.now } = {}) {
  const { threadId, messageId } = threadIdOf(args.thread ?? args.threadId ?? args.link);
  const { query } = await connect({ backendUrl: args.backend, env, fetchFn, now });
  let detail = null;
  const { items: pages } = await allPages(async (paginationOpts) => {
    const result = await query("threads:get", { threadId, paginationOpts });
    detail ??= result;
    return result;
  });
  const { items: reactions } = await allPages((paginationOpts) => query("threads:listReactions", { threadId, paginationOpts }));
  const project = await query("projects:get", { projectId: detail.projectId });
  const base = project.reviewUrl ?? detail.anchor.evidence?.url ?? null;
  const links = (id) => feedbackLink(base, threadId, id);
  const reactionsOf = new Map();
  for (const reaction of reactions) {
    const counts = reactionsOf.get(reaction.messageId) ?? new Map();
    const count = counts.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false };
    count.count += 1;
    count.mine ||= reaction.mine;
    counts.set(reaction.emoji, count);
    reactionsOf.set(reaction.messageId, counts);
  }
  const messages = pages.map((message) => ({
    ...shapeMessage(message, links),
    mine: message.isMine === true,
    mentions: (message.mentions ?? []).map((mention) => ({ id: mention._id, name: mention.name, as: mention.label })),
    reactions: [...(reactionsOf.get(message._id)?.values() ?? [])],
    ...(messageId === message._id ? { linked: true } : {}),
  }));
  return {
    project: { id: detail.projectId, name: project.name, reviewUrl: project.reviewUrl ?? null },
    thread: {
      id: threadId,
      link: links(null),
      status: detail.status,
      statusChangedBy: detail.statusChangedByName ?? null,
      statusChangedAt: iso(detail.statusChangedAt),
      tags: detail.tags,
      startedBy: messages[0] ? { id: messages[0].authorId, name: messages[0].author } : null,
      createdAt: iso(detail.createdAt),
      lastMessageAt: iso(detail.lastMessageAt),
      messageCount: detail.messageCount,
      screenshot: detail.capture,
      context: contextOf(detail.anchor, detail.reattachment?.location ?? null),
      movedBy: detail.reattachedByName ?? null,
      movedAt: iso(detail.reattachment?.reattachedAt),
      messages,
    },
  };
}

/** Image types a capture is saved as. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** Larger images are saved to a file rather than returned inline. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * A thread's screenshot: what the reviewer saw when they left the feedback,
 * with the marked element outlined on it. With `file`, it is saved there too.
 */
export async function readScreenshot(args, { cwd = process.cwd(), env = process.env, fetchFn = fetch, now = Date.now } = {}) {
  const { threadId } = threadIdOf(args.thread ?? args.threadId ?? args.link);
  const { backend, accessToken, query } = await connect({ backendUrl: args.backend, env, fetchFn, now });
  const detail = await query("threads:get", { threadId, paginationOpts: { numItems: 1, cursor: null } });
  if (detail.capture?.status === "failed") {
    throw new SetupError(`This thread has no screenshot: ${detail.capture.failureReason || "capture failed"}.`);
  }
  let response;
  try {
    response = await fetchFn(`${backend.siteUrl}/capture?threadId=${encodeURIComponent(threadId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new SetupError(`Can't reach the Critiqs backend at ${backend.backendUrl}.`);
  }
  if (response.status === 404) throw new SetupError("This thread's screenshot isn't available.");
  if (!response.ok) throw new SetupError(`The Critiqs backend couldn't send the screenshot (${response.status}).`);
  const mimeType = (response.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(mimeType)) throw new SetupError("The Critiqs backend sent something other than an image.");
  const bytes = Buffer.from(await response.arrayBuffer());
  const wantsFile = typeof args.file === "string" && args.file.trim() !== "";
  if (bytes.length > MAX_INLINE_IMAGE_BYTES && !wantsFile) {
    throw new SetupError(
      `This screenshot is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, too large to return here. Ask again with file, a path to save it to.`,
    );
  }
  let saved = null;
  if (wantsFile) {
    saved = resolve(cwd, args.file.trim());
    mkdirSync(dirname(saved), { recursive: true });
    writeFileSync(saved, bytes);
  }
  const evidence = detail.anchor.evidence ?? {};
  return {
    threadId,
    kind: detail.capture?.status === "supplied" ? "supplied by the reviewer" : "captured automatically",
    mimeType,
    bytes: bytes.length,
    file: saved,
    page: evidence.url ?? null,
    viewport: evidence.viewport ?? null,
    marker: evidence.marker ?? null,
    capturedAt: iso(evidence.capturedAt),
    /** Base64, unless the image is too large to return inline; then it is only in `file`. */
    image: bytes.length <= MAX_INLINE_IMAGE_BYTES ? bytes.toString("base64") : null,
  };
}

// ---------------------------------------------------------------------------
// Reading mockups

const MOCKUPS_MISSING = "has no mockups";
/** Most mockups a backend lists for a project. Matches `MOCKUP_RULES.listed`. */
const MAX_MOCKUPS = 100;

function sourceOf(source) {
  return { url: source.url, screen: source.screen, viewState: source.viewState ?? {}, revision: source.revision ?? null, persona: source.persona ?? null };
}

/**
 * A project's mockups, most recently changed first, filtered by the screen
 * they were made on and text in their title. Backends list a project's
 * newest 100.
 */
export async function listMockups(args, { env = process.env, fetchFn = fetch, now = Date.now } = {}) {
  const projectId = projectIdOf(args);
  const screen = nonEmpty(args.screen);
  const title = nonEmpty(args.text);
  const limit = args.limit === undefined || args.limit === null ? 50 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MOCKUPS) throw new SetupError(`limit must be a whole number from 1 to ${MAX_MOCKUPS}.`);
  const { backend, query } = await connect({ backendUrl: args.backend, env, fetchFn, now });
  await requireFeature(backend, fetchFn, "mockups", MOCKUPS_MISSING);
  const project = await query("projects:get", { projectId });
  const matching = (await query("mockups:list", { projectId }))
    .filter((mockup) => screen === null || mockup.source.screen === screen)
    .filter((mockup) => title === null || mockup.title.toLowerCase().includes(title.toLowerCase()));
  const mockups = matching.slice(0, limit).map((mockup) => ({
    id: mockup._id,
    title: mockup.title,
    source: sourceOf(mockup.source),
    createdBy: mockup.createdByName,
    createdAt: iso(mockup.createdAt),
    updatedAt: iso(mockup.updatedAt),
    versionCount: mockup.versionCount,
    threadCount: mockup.threadCount,
    copies: mockup.snapshots.map((snapshot) => ({ id: snapshot._id, width: snapshot.width })),
    // Each mockup thread is its own proposal, so its first message says what the mockup is for.
    threads: (mockup.threads ?? []).map((thread) => ({
      id: thread._id,
      status: thread.status,
      firstMessage: thread.preview?.body ?? "",
      author: thread.preview?.authorName ?? "Unknown",
      lastMessageAt: iso(thread.lastMessageAt),
    })),
  }));
  return {
    project: { id: projectId, name: project.name, reviewUrl: project.reviewUrl ?? null },
    filters: { screen, text: title, limit },
    total: matching.length,
    returned: mockups.length,
    truncated: matching.length > mockups.length,
    mockups,
  };
}

/** A page copy's HTML as it was frozen, after the same access checks as reading its mockup. */
async function readCopy(backend, accessToken, fetchFn, snapshotId) {
  let response;
  try {
    response = await fetchFn(`${backend.siteUrl}/mockup/snapshot?snapshotId=${encodeURIComponent(snapshotId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new SetupError(`Can't reach the Critiqs backend at ${backend.backendUrl}.`);
  }
  if (response.status === 404) throw new SetupError(`Page copy ${snapshotId} isn't available.`);
  if (!response.ok) throw new SetupError(`The Critiqs backend couldn't send page copy ${snapshotId} (${response.status}).`);
  return await response.text();
}

/** Who made a version: Critiqs AI for the person who asked, or a person. */
function versionAuthor(version) {
  return version.byAi ? { author: "Critiqs AI", byAi: true, askedBy: version.authorName } : { author: version.authorName, byAi: false };
}

/** Convex IDs; anything else can't name a file inside the folder copies are saved to. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * One mockup, to build its change for real: where it was made, its page
 * copies, one version's changes for each copy (the latest by default) with
 * the original markup of each element they change, the version history, its
 * mockup threads with whole discussions, and the existing threads it answers.
 * With `saveCopies`, each copy's original HTML and the version's changes are
 * written under `<saveCopies>/<mockupId>/`.
 */
export async function readMockup(args, { cwd = process.cwd(), env = process.env, fetchFn = fetch, now = Date.now } = {}) {
  const mockupId = nonEmpty(args.mockup ?? args.mockupId);
  if (mockupId === null) throw new SetupError("Give the mockup's ID (mockup), as critiqs_mockups lists it.");
  const { backend, accessToken, query } = await connect({ backendUrl: args.backend, env, fetchFn, now });
  await requireFeature(backend, fetchFn, "mockups", MOCKUPS_MISSING);
  const detail = await query("mockups:get", { mockupId });
  const head = detail.versionCount;
  const number = args.version === undefined || args.version === null || args.version === "" ? head : Number(args.version);
  if (!Number.isInteger(number) || number < 0 || number > head) {
    throw new SetupError(
      head === 0
        ? "This mockup has no versions yet; version 0 is its original page copies."
        : `This mockup has versions 1 to ${head}; version must be one of them, or 0 for the original page copies.`,
    );
  }
  const chosen = detail.versions.find((version) => version.number === number) ?? null;
  const editsOf = (snapshotId) => chosen?.edits[snapshotId] ?? [];

  const project = await query("projects:get", { projectId: detail.projectId });
  const threadRows = await query("mockups:threads", { mockupId });
  const discussions = await mapLimited(threadRows, 6, async (row) => {
    let thread = null;
    const { items } = await allPages(async (paginationOpts) => {
      const result = await query("threads:get", { threadId: row._id, paginationOpts });
      thread ??= result;
      return result;
    });
    return { thread, messages: items };
  });

  // Each copy is read once, only when its markup is needed or it is saved.
  const saveTo = nonEmpty(args.saveCopies);
  const wanted = new Map(detail.snapshots.map((snapshot) => [snapshot._id, new Set()]));
  for (const snapshot of detail.snapshots) for (const edit of editsOf(snapshot._id)) if (typeof edit.node === "number") wanted.get(snapshot._id).add(edit.node);
  for (const { thread } of discussions) {
    const pin = thread.mockup;
    if (pin?.snapshotId && typeof pin.node === "number") wanted.get(pin.snapshotId)?.add(pin.node);
  }
  const html = new Map();
  const found = new Map();
  for (const snapshot of detail.snapshots) {
    if (wanted.get(snapshot._id).size === 0 && saveTo === null) continue;
    const copy = await readCopy(backend, accessToken, fetchFn, snapshot._id);
    html.set(snapshot._id, copy);
    found.set(snapshot._id, findElements(copy, wanted.get(snapshot._id)));
  }
  /** The element as the original copy has it; null when an earlier change added it, or it was never there. */
  const original = (snapshotId, node) => {
    const scan = found.get(snapshotId);
    if (scan === undefined) return { original: null };
    const element = scan.elements.get(node) ?? null;
    return element === null && node > scan.highest ? { original: null, addedByChange: true } : { original: element };
  };

  const copies = detail.snapshots.map((snapshot) => ({
    id: snapshot._id,
    width: snapshot.width,
    height: snapshot.height,
    capturedAt: iso(snapshot.capturedAt),
    edits: editsOf(snapshot._id).map((edit) => (typeof edit.node === "number" ? { ...edit, ...original(snapshot._id, edit.node) } : edit)),
  }));

  const threads = discussions.map(({ thread, messages }) => {
    const pin = thread.mockup;
    return {
      id: thread._id,
      status: thread.status,
      createdAt: iso(thread.createdAt),
      lastMessageAt: iso(thread.lastMessageAt),
      messageCount: thread.messageCount,
      // The copy and element the thread is on, if not the whole mockup.
      pin:
        pin === undefined || pin.snapshotId === null
          ? null
          : { copyId: pin.snapshotId, node: pin.node ?? null, ...(typeof pin.node === "number" ? original(pin.snapshotId, pin.node) : {}) },
      messages: messages.map((message) => shapeMessage(message, () => null)),
    };
  });

  const linkedThreads = await mapLimited(detail.linkedThreadIds, 6, async (threadId) => {
    const first = await query("threads:get", { threadId, paginationOpts: { numItems: 1, cursor: null } });
    const message = first.page[0];
    return {
      id: threadId,
      link: feedbackLink(project.reviewUrl ?? first.anchor.evidence?.url ?? null, threadId),
      status: first.status,
      screen: first.reattachment?.location.screen ?? first.anchor.screen,
      messageCount: first.messageCount,
      firstMessage: message === undefined ? null : { author: message.author?.name ?? "Unknown", body: message.body, createdAt: iso(message.createdAt) },
    };
  });

  const version =
    chosen === null
      ? { number: 0, latest: head === 0, summary: "The original page copies, before any change.", author: null, byAi: false, createdAt: null, restoredFrom: null, threadId: null, messageId: null }
      : {
          number,
          latest: number === head,
          summary: chosen.summary,
          ...versionAuthor(chosen),
          createdAt: iso(chosen.createdAt),
          restoredFrom: chosen.restoredFrom,
          threadId: chosen.threadId,
          messageId: chosen.messageId,
        };

  let saved = null;
  if (saveTo !== null) {
    if (![mockupId, ...detail.snapshots.map((snapshot) => snapshot._id)].every((id) => SAFE_ID.test(id))) {
      throw new SetupError("This mockup's IDs can't be used as file names, so its copies weren't saved.");
    }
    const folder = join(resolve(cwd, saveTo), mockupId);
    mkdirSync(folder, { recursive: true });
    const files = [];
    for (const copy of copies) {
      const file = join(folder, `${copy.id}.html`);
      writeFileSync(file, html.get(copy.id));
      files.push(file);
    }
    const editsFile = join(folder, `edits-v${number}.json`);
    const record = {
      mockup: { id: mockupId, title: detail.title },
      version,
      copies: copies.map((copy) => ({ id: copy.id, width: copy.width, file: `${copy.id}.html`, edits: copy.edits })),
    };
    writeFileSync(editsFile, `${JSON.stringify(record, null, 2)}\n`);
    saved = { folder, copies: files, edits: editsFile };
  }

  return {
    project: { id: detail.projectId, name: project.name, reviewUrl: project.reviewUrl ?? null },
    mockup: {
      id: mockupId,
      title: detail.title,
      source: sourceOf(detail.source),
      createdBy: detail.createdByName,
      createdAt: iso(detail.createdAt),
      updatedAt: iso(detail.updatedAt),
      versionCount: head,
    },
    version,
    copies,
    versions: detail.versions.map((entry) => ({
      number: entry.number,
      summary: entry.summary,
      ...versionAuthor(entry),
      createdAt: iso(entry.createdAt),
      restoredFrom: entry.restoredFrom,
    })),
    threads,
    linkedThreads,
    saved,
  };
}

/** The sign-in service a backend uses, and who this computer is signed in to it as (null when it isn't). */
export async function signInStatus({ backendUrl, env = process.env, fetchFn = fetch } = {}) {
  const { signInUrl } = await backendFor(backendUrl, fetchFn);
  return { signInUrl, saved: savedSignIn(signInUrl, { env }) };
}

// ---------------------------------------------------------------------------
// Replying

/** Longest comment Critiqs accepts. Matches `MAX_BODY_LENGTH`. */
export const MAX_REPLY_LENGTH = 10_000;
/** Most people one comment may mention. Matches `MAX_MENTIONS`. */
const MAX_REPLY_MENTIONS = 20;

/**
 * Who a mention means: the author ID of someone in this thread (as
 * critiqs_thread shows them), or the display name of someone who has
 * commented in the project (any case).
 */
async function mentionOf(query, projectId, inThread, wanted) {
  const text = String(wanted).trim().replace(/^@/, "");
  if (text === "") throw new SetupError("A mention needs a name or an author ID.");
  if (inThread.has(text)) return { id: text, name: inThread.get(text) };
  // Everyone with exactly this name, so a name two people share is never guessed.
  const { people, complete } = await query("projects:participantsNamed", { projectId, name: text });
  if (people.length === 1 && complete) return { id: people[0]._id, name: people[0].name };
  if (people.length > 1) {
    throw new SetupError(`${people.length} people are named "${text}": ${people.map((person) => `${person.name} (${person._id})`).join(", ")}. Mention one by ID.`);
  }
  if (people.length === 1) {
    throw new SetupError(`This project has too many participants to be sure only one is named "${text}". Mention them by the author ID critiqs_thread shows.`);
  }
  throw new SetupError(
    `No one named "${text}" has commented in this project, so they can't be mentioned. Mention people by the names or author IDs critiqs_thread shows. You can't mention yourself.`,
  );
}

/**
 * Posts a reply in a thread as the signed-in reviewer, marked as written by a
 * coding agent. Everyone else in the thread is emailed about it (unless they
 * turned that off); people it mentions get a mention email instead. Mentions
 * are names or author IDs; each one's `@Name` is added to the text if missing.
 */
export async function postReply(args, { env = process.env, fetchFn = fetch, now = Date.now } = {}) {
  const { threadId } = threadIdOf(args.thread ?? args.threadId ?? args.link);
  const body = typeof args.body === "string" ? args.body.trim() : "";
  if (body === "") throw new SetupError("Write the reply's text in body.");
  const wanted = Array.isArray(args.mention) ? args.mention : typeof args.mention === "string" && args.mention.trim() !== "" ? [args.mention] : [];
  if (wanted.length > MAX_REPLY_MENTIONS) throw new SetupError(`Mention up to ${MAX_REPLY_MENTIONS} people in one reply.`);
  const revision = typeof args.revision === "string" && args.revision.trim() !== "" ? args.revision.trim() : null;
  const { backend, query, mutate } = await connect({ backendUrl: args.backend, env, fetchFn, now });
  // Older backends would refuse the agent mark, or post without telling anyone.
  await requireFeature(backend, fetchFn, "agentReplies", "can't post agent replies");
  let detail = null;
  const { items: messages } = await allPages(async (paginationOpts) => {
    const result = await query("threads:get", { threadId, paginationOpts });
    detail ??= result;
    return result;
  });
  // The people in this thread, by ID, as an agent saw them in critiqs_thread.
  const inThread = new Map();
  for (const message of messages) {
    if (message.authorId) inThread.set(message.authorId, message.author?.name ?? "Someone");
    for (const mention of message.mentions ?? []) inThread.set(mention._id, mention.name);
  }
  const mentions = [];
  for (const entry of wanted) {
    const person = await mentionOf(query, detail.projectId, inThread, entry);
    if (!mentions.some((known) => known.id === person.id)) mentions.push(person);
  }
  // The text shows each mention as `@Name`, as the sidebar writes it.
  let text = body;
  const missing = mentions.filter((person) => !text.includes(`@${person.name}`));
  if (missing.length > 0) text = `${missing.map((person) => `@${person.name}`).join(" ")} ${text}`;
  if (text.length > MAX_REPLY_LENGTH) throw new SetupError(`Replies are limited to ${MAX_REPLY_LENGTH} characters.`);
  const messageId = await mutate("threads:reply", {
    threadId,
    body: text,
    revision,
    mentions: mentions.map((person) => ({ userId: person.id, label: person.name })),
    via: "agent",
  });
  const project = await query("projects:get", { projectId: detail.projectId });
  return {
    project: { id: detail.projectId, name: project.name, reviewUrl: project.reviewUrl ?? null },
    threadId,
    messageId,
    link: feedbackLink(project.reviewUrl ?? detail.anchor.evidence?.url ?? null, threadId, messageId),
    body: text,
    revision,
    mentioned: mentions,
    via: "agent",
  };
}
