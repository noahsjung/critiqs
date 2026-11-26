/**
 * Reading a project's feedback from the command line and coding agents: a
 * sign-in kept on this computer, and the comments, threads, screenshots, and
 * mockups behind `critiqs_comments`, `critiqs_thread`, `critiqs_screenshot`,
 * `critiqs_mockups`, and `critiqs_mockup`.
 * Dependency-free, like setup.mjs, so it runs under Node and Bun without a build.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  callConvex,
  CLOUD_BACKEND_URL,
  CLOUD_BINDING,
  CLOUD_SIGN_IN_URL,
  isHeadless,
  RedirectRefusedError,
  requireSecureTokenTarget,
  resolveBackend,
  sendCredential,
  SetupError,
  startRemoteSignIn,
} from "./setup.mjs";
import { findElements } from "./markup.mjs";

/** Raised when this computer has no usable sign-in; the message says how to sign in. */
export class NotSignedInError extends SetupError {}

/** Raised when the saved sign-in isn't approved for a backend, so its token isn't sent there. */
export class BackendNotApprovedError extends SetupError {}

const CLOUD_ORIGIN = CLOUD_BINDING.backend;

/** A value quoted for a POSIX shell: single quotes, with each `'` closed, escaped, and reopened. */
export const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

/** How to sign in for a backend (an origin), with the origin shown on its own and quoted in the command. */
const signInFor = (backend) =>
  `call the critiqs_sign_in tool with backend ${JSON.stringify(backend)}, or run \`npx critiqs sign-in --backend ${shellQuote(backend)}\``;

const signInHint = (backend) =>
  backend === CLOUD_ORIGIN
    ? "Sign in once on this computer with the critiqs_sign_in tool, or run `npx critiqs sign-in`."
    : `Sign in once on this computer for the Critiqs backend at ${backend}: ${signInFor(backend)}.`;

// ---------------------------------------------------------------------------
// The sign-in kept on this computer

/**
 * Where this computer keeps its Critiqs sign-ins: `CRITIQS_CONFIG_DIR`, or
 * the user's configuration folder. Only the owner can read it.
 *
 * Versions of this package that wrote format version 1 kept it in
 * `sign-in.json` beside this file (`legacyCredentialsFile`). This version
 * writes format version 2, which records the backends each sign-in was
 * approved for, to a file of its own, so an older version still running on
 * this computer can't write over it.
 */
export function credentialsFile(env = process.env, platform = process.platform) {
  const folder = env.CRITIQS_CONFIG_DIR
    ? env.CRITIQS_CONFIG_DIR
    : join(platform === "win32" ? env.APPDATA || join(homedir(), "AppData", "Roaming") : env.XDG_CONFIG_HOME || join(homedir(), ".config"), "critiqs");
  return join(folder, "sign-in.v2.json");
}

/** The file versions before this one kept their sign-ins in, as format version 1. */
export const legacyCredentialsFile = (file) => join(dirname(file), "sign-in.json");

const FORMAT = 2;

function readFile(file) {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8"));
    if (typeof stored?.services === "object" && stored.services !== null) return stored;
  } catch {}
  return null;
}

/** The computer's sign-ins in this format. */
function readSignIns(file) {
  const stored = readFile(file);
  return stored?.version === FORMAT ? stored : { version: FORMAT, services: {} };
}

/** A version 1 file's sign-ins, or null when it holds none. */
function readLegacy(file) {
  const stored = readFile(file);
  return stored?.version === 1 && Object.keys(stored.services).length > 0 ? stored : null;
}

/**
 * A version 1 entry in this format. Version 1 recorded no backends, so an
 * entry counts only for Critiqs Cloud, and only when it came from Critiqs
 * Cloud's sign-in service; others are approved for no backend, kept only so
 * signing out can end them.
 */
function fromLegacy(signInUrl, entry) {
  const { backends: _unrecorded, bindings: _unrecordedToo, ...rest } = entry;
  return { ...rest, bindings: signInUrl === CLOUD_SIGN_IN_URL ? [{ ...CLOUD_BINDING }] : [] };
}

/**
 * What to take from a version 1 file (`legacy`) into this one (`current`,
 * null while this version has never saved a sign-in here), as the writes to
 * make in order, or null to take nothing: `current` and `legacy` are the next
 * contents of each file, and `finished` this file's once the move is done.
 *
 * The first time, every entry moves, and the version 1 file is left signed
 * out, empty but valid for older versions. This file records the move as
 * pending (`legacyMovePending`) until the version 1 file is signed out, so a
 * move that stops between the two is done again in full. After that, an
 * older version that signs in again writes a new version 1 sign-in, which is
 * left to it, except a Critiqs Cloud sign-in from Critiqs Cloud's sign-in
 * service when this file has none and none was signed out after it was made
 * (`cloudSignedOutAt`): that one moves. One this file already holds, copied
 * by such a move that stopped before removing it there, is removed there.
 */
function legacyMove(current, legacy) {
  if (legacy === null) {
    if (current?.legacyMovePending !== true) return null;
    const { legacyMovePending: _done, ...finished } = current;
    return { finished };
  }
  const entries = Object.entries(legacy.services).filter(([, entry]) => entry !== null && typeof entry === "object");
  if (current === null || current.legacyMovePending === true) {
    // Until the move is finished, the version 1 file holds the latest of its sign-ins.
    const moved = Object.fromEntries(entries.map(([url, entry]) => [url, fromLegacy(url, entry)]));
    const copied = { ...(current ?? { version: FORMAT }), services: { ...(current?.services ?? {}), ...moved }, legacyMovePending: true };
    const { legacyMovePending: _done, ...finished } = copied;
    return { current: copied, legacy: { version: 1, services: {} }, finished };
  }
  const cloud = entries.find(([url]) => url === CLOUD_SIGN_IN_URL)?.[1];
  if (cloud === undefined) return null;
  const { [CLOUD_SIGN_IN_URL]: _moved, ...left } = legacy.services;
  const rest = { ...legacy, services: left };
  const here = current.services[CLOUD_SIGN_IN_URL];
  if (here !== undefined) {
    if (here.refreshToken === cloud.refreshToken) return { legacy: rest };
    // Renewing keeps when it was signed in, and replaces the refresh token: the same sign-in, renewed on one side
    // since it was copied. Keep the one renewed last, so a spent token never wins over the live one.
    if (typeof cloud.signedInAt === "number" && here.signedInAt === cloud.signedInAt) {
      const newer = (typeof cloud.accessExpiresAt === "number" ? cloud.accessExpiresAt : 0) > (typeof here.accessExpiresAt === "number" ? here.accessExpiresAt : 0);
      if (!newer) return { legacy: rest };
      return { current: { ...current, services: { ...current.services, [CLOUD_SIGN_IN_URL]: fromLegacy(CLOUD_SIGN_IN_URL, cloud) } }, legacy: rest };
    }
    return null;
  }
  if (typeof current.cloudSignedOutAt === "number" && !(typeof cloud.signedInAt === "number" && cloud.signedInAt > current.cloudSignedOutAt)) return null;
  return { current: { ...current, services: { ...current.services, [CLOUD_SIGN_IN_URL]: fromLegacy(CLOUD_SIGN_IN_URL, cloud) } }, legacy: rest };
}

/** This file's sign-ins, or null when no version of this format has saved any. */
const readCurrent = (file) => (existsSync(file) ? readSignIns(file) : null);

/**
 * Moves sign-ins from the version 1 file, as `legacyMove` says, holding this
 * file's lock and then the version 1 file's, which older versions also take.
 * Runs before anything reads or writes this file's sign-ins. If the version 1
 * file can't be signed out, nothing goes on until it can.
 */
async function migrateLegacy(file) {
  const legacyFile = legacyCredentialsFile(file);
  if (legacyMove(readCurrent(file), readLegacy(legacyFile)) === null) return;
  await withLockRetry(file, (heldHere) =>
    withLock(legacyFile, (heldThere) => {
      const move = legacyMove(readCurrent(file), readLegacy(legacyFile));
      if (move === null) return;
      const held = () => (heldHere(), heldThere());
      if (move.current) held(), writeSignIns(file, move.current);
      if (move.legacy) {
        held();
        try {
          writeSignIns(legacyFile, move.legacy);
        } catch (error) {
          throw new SetupError(`Couldn't sign out the earlier sign-in file ${legacyFile} (${error?.code ?? error}). Make it writable, or delete it, and try again.`);
        }
      }
      if (move.finished) held(), writeSignIns(file, move.finished);
    }),
  );
}

/**
 * Signing out of Critiqs Cloud here also signs out a Critiqs Cloud sign-in an
 * older version keeps in the version 1 file, so the next command can't move
 * it in, and records when (`cloudSignedOutAt`), so a version 1 sign-in made
 * before then never moves in. Returns who that one was, or null.
 */
async function signOutLegacyCloud(file, fetchFn) {
  const legacyFile = legacyCredentialsFile(file);
  const taken = await withLockRetry(file, (heldHere) =>
    withLock(legacyFile, (heldThere) => {
      const current = readSignIns(file);
      const legacy = readLegacy(legacyFile);
      const entry = legacy?.services[CLOUD_SIGN_IN_URL];
      const found = entry !== null && typeof entry === "object" && typeof entry.refreshToken === "string";
      // Kept aside in this file (`recovered`) until the service confirms it ended, so its token is never just dropped.
      const recovered = found ? [...recoveredOf(current), { signInUrl: CLOUD_SIGN_IN_URL, origin: entry.origin, refreshToken: entry.refreshToken }] : null;
      heldHere(), heldThere();
      writeSignIns(file, { ...current, cloudSignedOutAt: Date.now(), ...(recovered === null ? {} : { recovered }) });
      if (!found) return null;
      const { [CLOUD_SIGN_IN_URL]: _ended, ...left } = legacy.services;
      heldHere(), heldThere();
      writeSignIns(legacyFile, { ...legacy, services: left });
      return entry;
    }),
  );
  if (taken === null) return null;
  const ended = await endSession(fetchFn, CLOUD_SIGN_IN_URL, taken);
  if (ended.answered) {
    await withLockRetry(file, (held) => {
      const latest = readSignIns(file);
      const kept = recoveredOf(latest).filter((spare) => spare.refreshToken !== taken.refreshToken);
      if (kept.length > 0) latest.recovered = kept;
      else delete latest.recovered;
      held();
      writeSignIns(file, latest);
    });
  }
  // Unconfirmed, it stays in `recovered`, and the next sign-out tries to end it again.
  return { reviewer: taken.reviewer ?? null, found: ended.found };
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
const HEARTBEAT_MS = 5_000;

/** A request to the sign-in service carrying a refresh token: it gives up after `REQUEST_TIMEOUT_MS`, and follows no redirect. */
function timed(fetchFn, url, init) {
  return sendCredential(fetchFn, url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/**
 * Ends a saved session with its sign-in service. `answered` is whether the
 * service confirmed, and `found` whether it had the session to end.
 */
async function endSession(fetchFn, signInUrl, entry) {
  try {
    const response = await timed(fetchFn, `${signInUrl}/auth/sign-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: entry.origin ?? new URL(signInUrl).origin },
      body: JSON.stringify({ refreshToken: entry.refreshToken }),
    });
    return { answered: response.ok, found: response.headers.get("Critiqs-Session-Ended") !== "false" };
  } catch (error) {
    if (error instanceof RedirectRefusedError) throw error;
    return { answered: false, found: true };
  }
}

// ---------------------------------------------------------------------------
// The lock beside a sign-in file
//
// One process at a time reads and writes a sign-in file, so two agents on this
// computer don't both spend the same refresh token. Node has no advisory file
// lock without a native module, so the lock is made from steps the file system
// does in one go:
//
// - The lock is a directory, `<file>.lock`, made with mkdir, which fails for
//   every process but one. Its `owner` file holds a token unique to the holder,
//   who touches it every HEARTBEAT_MS while working.
// - A lock whose heartbeat is older than STALE_LOCK_MS was left by a process
//   that died. Waiters take one over one at a time, each holding
//   `<file>.lock.break` (another mkdir) while it checks the heartbeat again and
//   renames the lock to a name of its own before removing it. A lock taken
//   since the waiter first looked has a fresh heartbeat, so it is left alone.
// - Before every write, the holder checks its token is still in the lock
//   (`held()`); if not, it writes nothing and throws LockLostError, and the
//   caller writes again under a fresh lock (`withLockRetry`, `persist`). So
//   even a holder that stalled past STALE_LOCK_MS never writes while another
//   holds the lock.
// - A file at `<file>.lock` is an earlier version's lock, waited for and taken
//   over the same way. Earlier versions can't remove a directory, so they wait.

/** Thrown before a write by a holder whose lock another process took over. */
class LockLostError extends SetupError {}

/** Who holds the lock (`token`, null while it is being made) and how long since its heartbeat, or null when no one does. */
function lockState(lock) {
  try {
    const stats = statSync(lock);
    if (!stats.isDirectory()) return { token: readFileSync(lock, "utf8"), age: Date.now() - stats.mtimeMs };
    try {
      const owner = join(lock, "owner");
      return { token: readFileSync(owner, "utf8"), age: Date.now() - statSync(owner).mtimeMs };
    } catch {
      return { token: null, age: Date.now() - stats.mtimeMs };
    }
  } catch {
    return null;
  }
}

/** Removes a lock (or breaker): renamed in one step to a name of `token`'s, so nothing taken meanwhile is half removed. */
function bury(path, token) {
  const tombstone = `${path}.${token}.gone`;
  try {
    renameSync(path, tombstone);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  rmSync(tombstone, { recursive: true, force: true });
}

/** Removes the lock if its heartbeat is still stale, holding the breaker; true when the caller may try again at once. */
function takeOverAbandoned(lock, token, staleMs) {
  const breaker = `${lock}.break`;
  try {
    mkdirSync(breaker, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    // Holding the breaker takes microseconds; one this old was left by a waiter that died holding it.
    try {
      if (Date.now() - statSync(breaker).mtimeMs > staleMs) bury(breaker, token);
    } catch {}
    return false;
  }
  try {
    const state = lockState(lock);
    if (state === null) return true;
    if (state.age <= staleMs) return false;
    bury(lock, token);
    return true;
  } finally {
    rmSync(breaker, { recursive: true, force: true });
  }
}

/**
 * Runs `work(held)` holding the lock beside the file (see above). `held()`
 * throws LockLostError unless this process still holds it; `work` calls it
 * right before each write. Work under the lock makes only requests that time
 * out sooner than the lock counts as abandoned.
 */
async function withLock(file, work, { waitMs = 15_000, staleMs = STALE_LOCK_MS } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const owner = join(lock, "owner");
  const token = randomBytes(12).toString("hex");
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const state = lockState(lock);
    if (state !== null && state.age > staleMs && takeOverAbandoned(lock, token, staleMs)) continue;
    if (Date.now() - started > waitMs) throw new SetupError("Another Critiqs process is using this computer's sign-in. Try again in a moment.");
    await pause(50 + Math.random() * 100);
  }
  try {
    writeFileSync(owner, token, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Without its owner file the lock would look abandoned only after the stale time; give it up now.
    rmSync(lock, { recursive: true, force: true });
    throw error;
  }
  const mine = () => {
    try {
      return readFileSync(owner, "utf8") === token;
    } catch {
      return false;
    }
  };
  const held = () => {
    if (!mine()) throw new LockLostError("Another Critiqs process took over this computer's sign-in. Try again.");
  };
  const heartbeat = setInterval(() => {
    try {
      if (mine()) utimesSync(owner, new Date(), new Date());
    } catch {}
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await work(held);
  } finally {
    clearInterval(heartbeat);
    try {
      if (mine()) bury(lock, token);
    } catch {}
  }
}

/** `withLock`, run again from the start if the lock was taken over before a write; `work` reads the file again each time. */
async function withLockRetry(file, work) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withLock(file, work);
    } catch (error) {
      if (!(error instanceof LockLostError) || attempt === 3) throw error;
    }
  }
}

/**
 * Runs `write(held)` under the lock already held, or, if another process took
 * it over meanwhile, under a fresh one, so what was learned under the lock,
 * such as a new refresh token, is written rather than lost. `write` reads the
 * file again and checks what it finds.
 */
async function persist(file, held, write) {
  try {
    return await write(held);
  } catch (error) {
    if (!(error instanceof LockLostError)) throw error;
  }
  return await withLockRetry(file, write);
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

/**
 * The backends a saved sign-in was approved for, each with where it serves
 * screenshots and page copies (`site`), as origins: scheme, host, and port.
 * Its tokens are sent to no other address.
 */
function bindingsOf(entry) {
  return Array.isArray(entry?.bindings) ? entry.bindings.filter((binding) => typeof binding?.backend === "string" && typeof binding.site === "string") : [];
}

/** Who this computer is signed in as for a sign-in service, or null. Never returns tokens. */
export function savedSignIn(signInUrl, { env = process.env } = {}) {
  const entry = readSignIns(credentialsFile(env)).services[signInUrl];
  return entry === undefined
    ? null
    : { reviewer: entry.reviewer, signedInAt: entry.signedInAt, endsAt: entry.endsAt ?? null, bindings: bindingsOf(entry) };
}

/**
 * Saves a sign-in approved for `binding` (a backend and its site, as origins),
 * unless `cancelled()` says not to by the time the lock is held; then returns
 * null. It replaces the computer's sign-in to that service, keeping the
 * backends the same person approved before on this computer.
 */
async function saveSignIn(env, signInUrl, { origin, binding, accessToken, accessExpiresAt, refreshToken, endsAt = null, reviewer, now, cancelled = () => false }) {
  const file = credentialsFile(env);
  await migrateLegacy(file);
  return await withLockRetry(file, async (held) => {
    // Checked under the lock, which signing out also holds, so a sign-out that happened first wins.
    if (cancelled()) return null;
    const stored = readSignIns(file);
    const previous = stored.services[signInUrl];
    const subject = claimsOf(accessToken).sub;
    const samePerson = previous !== undefined && typeof subject === "string" && claimsOf(previous.accessToken ?? "").sub === subject;
    stored.services[signInUrl] = {
      origin,
      bindings: [...(samePerson ? bindingsOf(previous).filter((kept) => kept.backend !== binding.backend) : []), binding],
      refreshToken,
      accessToken,
      accessExpiresAt,
      endsAt,
      reviewer: reviewer ?? tokenReviewer(accessToken),
      signedInAt: now(),
    };
    held();
    writeSignIns(file, stored);
    return stored.services[signInUrl];
  });
}

/**
 * A current access token from the sign-in service, to send to `backendUrl`
 * (and, with `siteUrl`, to where it serves screenshots and page copies),
 * refreshing the saved session when the last token is nearly used up. A
 * session not approved for those origins is refused, whichever sign-in
 * service the backend names. A session that ended is removed, and the caller
 * is told to sign in again.
 */
export async function accessTokenFor(signInUrl, { backendUrl, siteUrl, env = process.env, fetchFn = fetch, now = Date.now } = {}) {
  if (typeof backendUrl !== "string" || backendUrl === "") throw new SetupError("Name the backend the sign-in is for.");
  requireSecureTokenTarget(backendUrl);
  if (siteUrl !== undefined) requireSecureTokenTarget(siteUrl);
  const backend = new URL(backendUrl).origin;
  const site = siteUrl === undefined ? null : new URL(siteUrl).origin;
  const file = credentialsFile(env);
  await migrateLegacy(file);
  const usable = (entry) => typeof entry?.accessToken === "string" && entry.accessExpiresAt - now() > 60_000;
  const notSignedIn = () => new NotSignedInError(`This computer isn't signed in to Critiqs. ${signInHint(backend)}`);
  /** The entry, if its tokens may go to this backend and its site. */
  const approved = (entry) => {
    if (entry === undefined) throw notSignedIn();
    const binding = bindingsOf(entry).find((candidate) => candidate.backend === backend);
    if (binding === undefined) {
      throw new BackendNotApprovedError(
        `This computer's Critiqs sign-in isn't approved for the backend at ${backend}, so nothing was sent to it. ` +
          `If you trust that backend, sign in for it: ${signInFor(backend)}. The approval page names the backend.`,
      );
    }
    if (site !== null && binding.site !== site) {
      throw new BackendNotApprovedError(
        `This computer's Critiqs sign-in is approved for the backend at ${backend} with screenshots and page copies from ${binding.site}, not ${site}, so nothing was sent. ` +
          `If you trust ${site}, sign in again: ${signInFor(backend)}. The approval page names both addresses.`,
      );
    }
    return entry;
  };
  const first = approved(readSignIns(file).services[signInUrl]);
  if (usable(first)) return first.accessToken;
  requireSecureTokenTarget(signInUrl);
  return await withLock(file, async (held) => {
    // Another process may have refreshed while this one waited for the lock.
    const stored = readSignIns(file);
    const entry = approved(stored.services[signInUrl]);
    if (usable(entry)) return entry.accessToken;
    let response;
    try {
      response = await timed(fetchFn, `${signInUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: entry.origin },
        body: JSON.stringify({ refreshToken: entry.refreshToken }),
      });
    } catch (error) {
      if (error instanceof SetupError) throw error;
      throw new SetupError(`Can't reach Critiqs's sign-in service at ${signInUrl}.`);
    }
    /** What to do when the saved sign-in is no longer the one renewed: a replacement is held to the same approval. */
    const replaced = (replacement) => {
      if (replacement !== undefined && usable(replacement)) return approved(replacement).accessToken;
      throw new SetupError("This computer's Critiqs sign-in changed while renewing. Try again.");
    };
    if (response.status === 401) {
      // Forget the sign-in only if no one replaced it meanwhile.
      return await persist(file, held, (heldNow) => {
        const latest = readSignIns(file);
        if (latest.services[signInUrl]?.refreshToken !== entry.refreshToken) return replaced(latest.services[signInUrl]);
        delete latest.services[signInUrl];
        heldNow();
        writeSignIns(file, latest);
        throw new NotSignedInError(`This computer's Critiqs sign-in ended (signed out, or unused for 30 days). ${signInHint(backend)}`);
      });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.accessToken !== "string" || typeof body.refreshToken !== "string") {
      throw new SetupError(`Critiqs's sign-in service couldn't renew this computer's sign-in (${response.status}). Try again.`);
    }
    const renewed = {
      refreshToken: body.refreshToken,
      accessToken: body.accessToken,
      accessExpiresAt: typeof body.expiresAt === "number" ? body.expiresAt : tokenExpiry(body.accessToken, now),
      reviewer: tokenReviewer(body.accessToken),
    };
    // The old refresh token is spent, so the new one is written even if another process took the lock over meanwhile.
    return await persist(file, held, (heldNow) => {
      const latest = readSignIns(file);
      const current = latest.services[signInUrl];
      const mine = current?.refreshToken === entry.refreshToken;
      if (mine) latest.services[signInUrl] = { ...current, ...renewed };
      // Replaced meanwhile: kept aside, so signing out ends this session too.
      else latest.recovered = [...recoveredOf(latest), { signInUrl, origin: entry.origin, refreshToken: body.refreshToken }];
      heldNow();
      writeSignIns(file, latest);
      return mine ? body.accessToken : replaced(current);
    });
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
  const backend = await backendFor(backendUrl, fetchFn);
  const { signInUrl } = backend;
  // Refused before anyone approves: this sign-in's tokens will go to the backend and its site.
  requireSecureTokenTarget(backend.backendUrl);
  requireSecureTokenTarget(backend.siteUrl);
  // The approval page must name this backend and its site, as the sign-in service confirms when it starts and with the tokens.
  const remote = await startRemoteSignIn({ signInUrl, backendUrl: backend.backendUrl, fetchFn, now, keepSignedIn: true, ...(sleep ? { sleep } : {}) });
  const { binding } = remote;
  let cancelled = false;
  return {
    method: method === "auto" ? (isHeadless(env) ? "remote" : "browser") : method,
    url: remote.url,
    userCode: remote.userCode,
    signInUrl,
    backendUrl: backend.backendUrl,
    binding,
    confirmed: remote.confirmed,
    cancel: () => {
      cancelled = true;
      remote.close();
    },
    finish: async () => {
      const tokens = await remote.tokens;
      const endSession = () =>
        timed(fetchFn, `${signInUrl}/auth/sign-out`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: new URL(signInUrl).origin },
          body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        }).catch(() => undefined);
      const saved = await saveSignIn(env, signInUrl, {
        // The session belongs to the sign-in service itself; no prototype is involved.
        origin: new URL(signInUrl).origin,
        binding,
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
        await endSession();
        throw new SetupError("This sign-in was cancelled.");
      }
      return { reviewer: saved.reviewer, endsAt: saved.endsAt, signInUrl, backendUrl: backend.backendUrl, bindings: saved.bindings };
    },
  };
}

/** Sessions renewed while another process replaced the sign-in, kept so signing out can end them. */
const recoveredOf = (stored) => (Array.isArray(stored.recovered) ? stored.recovered.filter((spare) => typeof spare?.refreshToken === "string") : []);

/**
 * Ends this computer's sign-in with the service, then forgets it. Returns who
 * was signed in and whether the service found the session to end, or null when
 * this computer wasn't signed in. If the service can't be reached or refuses,
 * the sign-in is kept so signing out can be tried again. A session the service
 * didn't find was already ended, or was replaced by a renewal whose answer was
 * lost; no one holds that one's token, and it ends after 30 days without use.
 * Sessions kept aside for the service (`recovered`) are ended too. Signing out
 * of Critiqs Cloud also ends a Critiqs Cloud sign-in an older version keeps.
 */
export async function signOutComputer({ backendUrl, env = process.env, fetchFn = fetch } = {}) {
  const { signInUrl } = await backendFor(backendUrl, fetchFn);
  const file = credentialsFile(env);
  await migrateLegacy(file);
  const result = await withLock(file, async (held) => {
    const stored = readSignIns(file);
    const entry = stored.services[signInUrl];
    const spares = recoveredOf(stored).filter((spare) => spare.signInUrl === signInUrl);
    if (entry === undefined && spares.length === 0) return null;
    requireSecureTokenTarget(signInUrl);
    const ended = entry === undefined ? null : await endSession(fetchFn, signInUrl, entry);
    if (ended !== null && !ended.answered) {
      throw new SetupError(`Critiqs's sign-in service at ${signInUrl} didn't confirm signing out, so this computer is still signed in. Try again when it's reachable.`);
    }
    for (const spare of spares) await endSession(fetchFn, signInUrl, spare);
    const spent = new Set(spares.map((spare) => spare.refreshToken));
    await persist(file, held, (heldNow) => {
      const latest = readSignIns(file);
      if (entry !== undefined && latest.services[signInUrl]?.refreshToken === entry.refreshToken) delete latest.services[signInUrl];
      if (signInUrl === CLOUD_SIGN_IN_URL) latest.cloudSignedOutAt = Date.now();
      const kept = recoveredOf(latest).filter((spare) => !spent.has(spare.refreshToken));
      if (kept.length > 0) latest.recovered = kept;
      else delete latest.recovered;
      heldNow();
      writeSignIns(file, latest);
    });
    return ended === null ? null : { reviewer: entry.reviewer ?? null, found: ended.found };
  });
  if (signInUrl !== CLOUD_SIGN_IN_URL) return result;
  const older = await signOutLegacyCloud(file, fetchFn);
  return result ?? older;
}

// ---------------------------------------------------------------------------
// Reading feedback

async function connect({ backendUrl, env, fetchFn, now }) {
  const backend = await backendFor(backendUrl, fetchFn);
  // Screenshots and page copies come from the site address, which the sign-in must have been approved for too.
  requireSecureTokenTarget(backend.backendUrl);
  requireSecureTokenTarget(backend.siteUrl);
  const accessToken = await accessTokenFor(backend.signInUrl, { backendUrl: backend.backendUrl, siteUrl: backend.siteUrl, env, fetchFn, now });
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
    response = await sendCredential(fetchFn, `${backend.siteUrl}/capture?threadId=${encodeURIComponent(threadId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    if (error instanceof SetupError) throw error;
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
    response = await sendCredential(fetchFn, `${backend.siteUrl}/mockup/snapshot?snapshotId=${encodeURIComponent(snapshotId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    if (error instanceof SetupError) throw error;
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

/**
 * The sign-in service a backend uses, who this computer is signed in to it as
 * (null when it isn't), and whether that sign-in is approved for this backend.
 */
export async function signInStatus({ backendUrl, env = process.env, fetchFn = fetch } = {}) {
  const backend = await backendFor(backendUrl, fetchFn);
  await migrateLegacy(credentialsFile(env));
  const saved = savedSignIn(backend.signInUrl, { env });
  const origin = new URL(backend.backendUrl).origin;
  const site = new URL(backend.siteUrl).origin;
  const approved = saved !== null && saved.bindings.some((binding) => binding.backend === origin && binding.site === site);
  return { signInUrl: backend.signInUrl, backendUrl: backend.backendUrl, saved, approved };
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
