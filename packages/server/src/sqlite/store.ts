import { AsyncLocalStorage } from "node:async_hooks";
import { type PageRequest, type Role, tagKey, type TeamSize } from "@critiqs/core";
import type {
  DeliveryRecord,
  DeveloperAttempt,
  DeveloperSendRecord,
  StoredMail,
  InviteRecord,
  PlanAlertKind,
  PlanAlertRecord,
  ProjectOnboarding,
  MembershipRecord,
  MessageRecord,
  OrganizationRecord,
  FollowerRecord,
  NotificationRecord,
  ReplyEmailJobRecord,
  PageResult,
  ParticipantRecord,
  PreferenceRecord,
  ProjectRecord,
  ReactionRecord,
  ReadStateRecord,
  Store,
  StoredMention,
  AiSettingsRecord,
  PersonalAiSettingsChanges,
  PersonalAiSettingsRecord,
  StoredConnection,
  TagGroupRecord,
  TagRecord,
  TextTag,
  ThreadRecord,
  ThreadTagRecord,
  UserRecord,
} from "../store.ts";
import { backfillHashtags, STARTER_GROUPS, groupNameKey, threadTags, updateTextTags } from "../tags.ts";
import type { Plan } from "../limits.ts";
import type { SqlDriver, SqlValue } from "./driver.ts";

// Critiqs's server rules on SQLite, for a server running inside the host app.
// One file holds a deployment's feedback; every operation runs in a
// transaction, and operations on one database run one at a time.

/** Schema version this code writes. Each migration below moves one version forward. */
export const SCHEMA_VERSION = 13;

/** A migration: SQL, or a step that needs code, such as reading hashtags from existing messages. */
type Migration = string | ((sql: SqlDriver) => void);

export const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE users (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT,
    image_url TEXT,
    profile_version INTEGER
  );
  CREATE TABLE projects (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tags TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX projects_by_creator ON projects (created_by, seq);
  CREATE TABLE threads (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    anchor TEXT NOT NULL,
    tags TEXT NOT NULL,
    capture TEXT NOT NULL,
    capture_file TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_message_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL,
    status_changed_by TEXT,
    status_changed_at INTEGER,
    reattachment TEXT
  );
  CREATE INDEX threads_visible_by_project ON threads (project_id, seq) WHERE status != 'deleted';
  CREATE INDEX threads_by_capture_file ON threads (capture_file);
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    revision TEXT
  );
  CREATE INDEX messages_by_thread ON messages (thread_id, created_at, seq);
  CREATE TABLE reactions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL
  );
  CREATE INDEX reactions_by_thread ON reactions (thread_id, seq);
  CREATE UNIQUE INDEX reactions_by_message_user_emoji ON reactions (message_id, user_id, emoji);
  CREATE TABLE read_states (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    last_read_at INTEGER NOT NULL,
    manual_unread INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX read_states_by_user_thread ON read_states (user_id, thread_id);
  CREATE TABLE files (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    content_type TEXT,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    data BLOB NOT NULL
  );
  `,
  `
  ALTER TABLE projects ADD COLUMN review_url TEXT;
  ALTER TABLE messages ADD COLUMN mentions TEXT;
  CREATE TABLE participants (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX participants_by_project_user ON participants (project_id, user_id);
  CREATE INDEX participants_by_project_activity ON participants (project_id, last_active_at);
  CREATE TABLE deliveries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    recipient_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    claim_token TEXT,
    lease_until INTEGER,
    message TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    reason TEXT
  );
  CREATE INDEX deliveries_by_status_due ON deliveries (status, due_at);
  CREATE INDEX deliveries_by_status_lease ON deliveries (status, lease_until);
  CREATE INDEX deliveries_by_recipient_thread ON deliveries (recipient_id, thread_id, status);
  CREATE INDEX deliveries_by_finished ON deliveries (finished_at);
  CREATE TABLE notifications (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    delivery_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX notifications_by_delivery ON notifications (delivery_id, seq);
  CREATE TABLE preferences (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL UNIQUE,
    mention_emails INTEGER NOT NULL,
    muted_projects TEXT NOT NULL
  );
  -- Everyone who already commented can be mentioned: their latest message in each project.
  INSERT INTO participants (id, project_id, user_id, last_active_at)
    SELECT 'a_' || lower(hex(randomblob(16))), threads.project_id, messages.author_id, max(messages.created_at)
    FROM messages JOIN threads ON threads.id = messages.thread_id
    GROUP BY threads.project_id, messages.author_id;
  `,
  `
  ALTER TABLE users ADD COLUMN plan TEXT;
  CREATE TABLE usage (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    key TEXT NOT NULL UNIQUE,
    count INTEGER NOT NULL
  );
  CREATE TABLE usage_members (
    key TEXT NOT NULL,
    member TEXT NOT NULL,
    PRIMARY KEY (key, member)
  );
  `,
  // Sign-in for a server in the host app: email-code attempts, counters that
  // limit codes sent, sessions held in cookies, and generated secrets.
  `
  CREATE TABLE sign_in_attempts (
    key_hash TEXT PRIMARY KEY,
    binding_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    email TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    code_digest TEXT,
    code_expires_at INTEGER,
    guesses INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE sign_in_counters (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_by_user ON sessions (user_id);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX users_by_email ON users (email);
  `,
  // Prepared mention emails are stored as files; edits are counted so a
  // discussion read in pages can tell it changed meanwhile.
  `
  ALTER TABLE threads ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE deliveries ADD COLUMN payload TEXT;
  `,
  // Hashtags derived from messages, the tag registry and shared groups,
  // thread-to-tag records and full-text search for search, AI settings, and
  // short-window counters. Existing explicit tags and messages are kept and
  // their hashtags read once.
  (sql) => {
    sql.exec(`
      ALTER TABLE messages ADD COLUMN project_id TEXT;
      ALTER TABLE messages ADD COLUMN hashtags TEXT;
      ALTER TABLE threads ADD COLUMN text_tags TEXT;
      CREATE INDEX threads_recent_by_project ON threads (project_id, last_message_at) WHERE status != 'deleted';
      CREATE INDEX messages_by_project ON messages (project_id, created_at);
      CREATE TABLE tags (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        first_used_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        group_ids TEXT NOT NULL,
        grouping TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL,
        claim_token TEXT,
        lease_until INTEGER,
        last_error TEXT
      );
      CREATE UNIQUE INDEX tags_by_project_key ON tags (project_id, key);
      CREATE INDEX tags_by_project_used ON tags (project_id, last_used_at);
      CREATE INDEX tags_due ON tags (grouping, next_attempt_at);
      CREATE INDEX tags_due_in_project ON tags (project_id, grouping, next_attempt_at);
      CREATE TABLE tag_groups (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX tag_groups_by_name ON tag_groups (project_id, name_key);
      CREATE TABLE thread_tags (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        key TEXT NOT NULL
      );
      CREATE INDEX thread_tags_by_thread ON thread_tags (thread_id);
      CREATE INDEX thread_tags_by_key ON thread_tags (project_id, key, seq);
      CREATE TABLE ai_settings (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL,
        mode TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        base_url TEXT,
        secret TEXT,
        epoch INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        last_test TEXT
      );
      CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX rate_limits_by_expiry ON rate_limits (expires_at);
      UPDATE messages SET project_id = (SELECT project_id FROM threads WHERE threads.id = messages.thread_id);
    `);
    // Full-text search when this SQLite has FTS5 (Bun's, Node's, and better-sqlite3 do); otherwise search scans with LIKE.
    try {
      sql.exec(`
        CREATE VIRTUAL TABLE message_search USING fts5(body, content='messages', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER messages_search_insert AFTER INSERT ON messages BEGIN
          INSERT INTO message_search (rowid, body) VALUES (new.seq, new.body);
        END;
        CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
          INSERT INTO message_search (message_search, rowid, body) VALUES ('delete', old.seq, old.body);
        END;
        CREATE TRIGGER messages_search_update AFTER UPDATE OF body ON messages BEGIN
          INSERT INTO message_search (message_search, rowid, body) VALUES ('delete', old.seq, old.body);
          INSERT INTO message_search (rowid, body) VALUES (new.seq, new.body);
        END;
        INSERT INTO message_search (message_search) VALUES ('rebuild');
      `);
    } catch {}
    backfillTags(sql);
  },
  // 6 → 7: reply emails and replies written by coding agents. Older threads
  // learn who is in them from their discussion, in the background, at their first reply.
  `
  ALTER TABLE threads ADD COLUMN followers_ready INTEGER;
  ALTER TABLE messages ADD COLUMN via TEXT;
  ALTER TABLE notifications ADD COLUMN kind TEXT;
  ALTER TABLE preferences ADD COLUMN reply_emails INTEGER;
  CREATE TABLE thread_followers (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    since INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX thread_followers_by_thread_user ON thread_followers (thread_id, user_id);
  CREATE INDEX thread_followers_by_thread_seq ON thread_followers (thread_id, seq);
  CREATE TABLE reply_email_jobs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    position INTEGER NOT NULL,
    stage TEXT NOT NULL,
    cursor TEXT
  );
  `,
  // Personal AI connections, and a project's AI usage rule and models.
  `
  ALTER TABLE ai_settings ADD COLUMN rule TEXT;
  ALTER TABLE ai_settings ADD COLUMN managed_model TEXT;
  ALTER TABLE ai_settings ADD COLUMN models TEXT;
  ALTER TABLE ai_settings ADD COLUMN allowed_models TEXT;
  CREATE TABLE personal_ai_settings (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL,
    mode TEXT NOT NULL,
    managed_model TEXT,
    provider TEXT,
    model TEXT,
    models TEXT,
    base_url TEXT,
    secret TEXT,
    epoch INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_test TEXT
  );
  `,
  // Organizations: everyone who set up projects or had a plan gets a home
  // organization, as its admin, holding their projects, plan, and project count.
  (sql) => {
    sql.exec(`
      CREATE TABLE organizations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        plan TEXT,
        overage_cap TEXT,
        extra_storage_units INTEGER
      );
      CREATE TABLE memberships (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX memberships_by_organization_user ON memberships (organization_id, user_id);
      CREATE INDEX memberships_by_user ON memberships (user_id, seq);
      CREATE TABLE invites (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        organization_id TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        accepted_at INTEGER
      );
      CREATE INDEX invites_by_organization_email ON invites (organization_id, email);
      CREATE INDEX invites_by_email ON invites (email);
      ALTER TABLE projects ADD COLUMN organization_id TEXT;
      CREATE INDEX projects_by_organization ON projects (organization_id, seq);
      ALTER TABLE users ADD COLUMN home_organization_id TEXT;
    `);
    sql.run(
      `INSERT INTO organizations (id, name, created_by, created_at, plan)
       SELECT 'o_' || lower(hex(randomblob(16))), COALESCE(NULLIF(trim(name), ''), NULLIF(email, ''), 'Critiqs') || '''s organization', id, ?, plan
       FROM users WHERE plan IS NOT NULL OR EXISTS (SELECT 1 FROM projects WHERE projects.created_by = users.id) ORDER BY seq`,
      [Date.now()],
    );
    sql.exec(`
      UPDATE users SET home_organization_id = (SELECT id FROM organizations WHERE organizations.created_by = users.id);
      INSERT INTO memberships (id, organization_id, user_id, role, created_at)
        SELECT 'b_' || lower(hex(randomblob(16))), id, created_by, 'admin', created_at FROM organizations ORDER BY seq;
      UPDATE projects SET organization_id = (SELECT home_organization_id FROM users WHERE users.id = projects.created_by);
      INSERT INTO usage (id, key, count)
        SELECT 'c_' || lower(hex(randomblob(16))), 'projects:' || users.home_organization_id || substr(usage.key, 10 + length(users.id)), usage.count
        FROM usage JOIN users ON users.id = substr(usage.key, 10, instr(substr(usage.key, 10), ':') - 1)
        WHERE usage.key LIKE 'projects:%' AND users.home_organization_id IS NOT NULL;
    `);
  },
  // Plans: alert emails to an organization's admins about its Critiqs AI
  // credits, and images counted per organization, starting with what its
  // projects already store.
  `
  CREATE TABLE plan_alerts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    organization_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    month TEXT NOT NULL,
    plan TEXT NOT NULL,
    plan_label TEXT NOT NULL,
    included INTEGER NOT NULL,
    overage TEXT,
    project_id TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    claim_token TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    reason TEXT
  );
  CREATE UNIQUE INDEX plan_alerts_by_organization_kind_month_plan ON plan_alerts (organization_id, kind, month, plan);
  CREATE INDEX plan_alerts_by_status_due ON plan_alerts (status, due_at);
  CREATE INDEX plan_alerts_by_status_lease ON plan_alerts (status, lease_until);
  CREATE INDEX memberships_by_organization_role ON memberships (organization_id, role, seq);
  INSERT INTO usage (id, key, count)
    SELECT 'c_' || lower(hex(randomblob(16))), 'captureBytes:' || projects.organization_id || ':total', SUM(usage.count)
    FROM usage JOIN projects ON usage.key = 'captureBytes:' || projects.id || ':total'
    WHERE projects.organization_id IS NOT NULL
    GROUP BY projects.organization_id;
  `,
  `
  CREATE TABLE IF NOT EXISTS credit_holds (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    credits INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS credit_holds_by_scope ON credit_holds (scope, expires_at);
  `,
  // Onboarding's answers: about the person, and about each project created in it.
  `
  ALTER TABLE users ADD COLUMN role TEXT;
  ALTER TABLE users ADD COLUMN team_size TEXT;
  ALTER TABLE projects ADD COLUMN onboarding TEXT;
  `,
  // Developer setup emails: one record per project and developer address,
  // with its email's attempts as JSON, and the inboxes that reported
  // Critiqs's email as unwanted.
  `
  CREATE TABLE developer_sends (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    email TEXT NOT NULL,
    sent_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reserved_at INTEGER NOT NULL,
    email_number INTEGER NOT NULL,
    attempts TEXT NOT NULL,
    message TEXT
  );
  CREATE UNIQUE INDEX developer_sends_by_project_email ON developer_sends (project_id, email);
  CREATE TABLE email_suppressions (inbox TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
  `,
];

/**
 * Reads hashtags from every existing message, a batch at a time, and records
 * each thread's tags (explicit and written) in the registry and thread-tag
 * records. Part of migration 6, in its transaction.
 */
function backfillTags(sql: SqlDriver): void {
  const textTags = new Map<string, TextTag[]>();
  let after = 0;
  for (;;) {
    const rows = sql.all<{ seq: number; id: string; thread_id: string; body: string }>(
      "SELECT seq, id, thread_id, body FROM messages WHERE seq > ? ORDER BY seq LIMIT 500",
      [after],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const hashtags = backfillHashtags(row.body);
      sql.run("UPDATE messages SET hashtags = ? WHERE id = ?", [JSON.stringify(hashtags), row.id]);
      if (hashtags.length > 0) textTags.set(row.thread_id, updateTextTags(textTags.get(row.thread_id), [], hashtags, true));
      after = row.seq;
    }
  }
  const groups = new Map<string, string>();
  const groupFor = (projectId: string, name: string, now: number) => {
    const nameKey = groupNameKey(name);
    const known = `${projectId}:${nameKey}`;
    if (groups.has(known)) return groups.get(known)!;
    const existing = sql.get<{ id: string }>("SELECT id FROM tag_groups WHERE project_id = ? AND name_key = ?", [projectId, nameKey]);
    const id = existing?.id ?? newId("tagGroups");
    if (existing === undefined) {
      sql.run("INSERT INTO tag_groups (id, project_id, name, name_key, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'starter', ?, ?)", [
        id, projectId, name, nameKey, now, now,
      ]);
    }
    groups.set(known, id);
    return id;
  };
  let threadAfter = 0;
  for (;;) {
    const threads = sql.all<{ seq: number; id: string; project_id: string; tags: string; created_at: number; last_message_at: number }>(
      "SELECT seq, id, project_id, tags, created_at, last_message_at FROM threads WHERE seq > ? ORDER BY seq LIMIT 500",
      [threadAfter],
    );
    if (threads.length === 0) break;
    for (const thread of threads) {
      threadAfter = thread.seq;
      const written = textTags.get(thread.id) ?? [];
      sql.run("UPDATE threads SET text_tags = ? WHERE id = ?", [JSON.stringify(written), thread.id]);
      const labels = threadTags({ tags: JSON.parse(thread.tags) as string[], textTags: written });
      for (const label of labels) {
        const key = tagKey(label);
        sql.run("INSERT INTO thread_tags (id, project_id, thread_id, key) VALUES (?, ?, ?, ?)", [newId("threadTags"), thread.project_id, thread.id, key]);
        const known = sql.get<{ id: string; last_used_at: number }>("SELECT id, last_used_at FROM tags WHERE project_id = ? AND key = ?", [thread.project_id, key]);
        if (known !== undefined) {
          if (known.last_used_at < thread.last_message_at) sql.run("UPDATE tags SET last_used_at = ? WHERE id = ?", [thread.last_message_at, known.id]);
          continue;
        }
        const starter = STARTER_GROUPS.find((group) => group.keys.includes(key));
        const groupIds = starter === undefined ? [] : [groupFor(thread.project_id, starter.name, thread.created_at)];
        sql.run(
          `INSERT INTO tags (id, project_id, key, label, first_used_at, last_used_at, group_ids, grouping, epoch, attempts, next_attempt_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
          [newId("tags"), thread.project_id, key, label, thread.created_at, thread.last_message_at, JSON.stringify(groupIds), starter === undefined ? "pending" : "starter", thread.created_at],
        );
      }
    }
  }
}

const PREFIX = {
  users: "u",
  projects: "p",
  threads: "t",
  messages: "m",
  reactions: "r",
  readStates: "s",
  files: "f",
  participants: "a",
  usage: "c",
  deliveries: "d",
  notifications: "n",
  preferences: "q",
  tags: "g",
  tagGroups: "h",
  threadTags: "k",
  aiSettings: "x",
  followers: "w",
  replyEmailJobs: "j",
  personalAiSettings: "y",
  organizations: "o",
  memberships: "b",
  invites: "i",
  planAlerts: "l",
  creditHolds: "v",
  developerSends: "e",
} as const;
const ID_PATTERN = /^[uptmrsfacdnqghkxwjyobilve]_[0-9a-f]{32}$/;

function newId(table: keyof typeof PREFIX): string {
  return `${PREFIX[table]}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Creates or upgrades the schema. Refuses a database written by a newer Critiqs. */
export function migrate(sql: SqlDriver): void {
  sql.exec("PRAGMA journal_mode = WAL");
  sql.exec("PRAGMA foreign_keys = ON");
  const version = sql.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`This Critiqs database uses schema version ${version}; upgrade Critiqs to read it.`);
  }
  for (let next = version; next < SCHEMA_VERSION; next++) {
    sql.exec("BEGIN IMMEDIATE");
    try {
      const migration = MIGRATIONS[next]!;
      if (typeof migration === "string") sql.exec(migration);
      else migration(sql);
      sql.exec(`PRAGMA user_version = ${next + 1}`);
      sql.exec("COMMIT");
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
  }
}

/** A SQLite database holding Critiqs's data, with one transaction at a time. */
/**
 * Options for a SQLite store. A self-hosted deployment has no plans; give
 * `plans` only to limit usage, for example in tests of Critiqs Cloud's rules.
 */
export interface SqliteOptions {
  plans?: Record<string, Plan>;
}

export class SqliteStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly store: Store;
  /**
   * The operation whose transaction is open, seen from work it starts. Work
   * that outlives its operation, such as a timer it set, sees it closed.
   */
  private readonly active = new AsyncLocalStorage<Transaction>();

  constructor(
    private readonly sql: SqlDriver,
    options: SqliteOptions = {},
  ) {
    migrate(sql);
    this.store = sqliteStore(sql, options);
  }

  /**
   * Runs one operation in its own transaction; a thrown error rolls back
   * everything it wrote. Called from within an operation, it joins that
   * operation's transaction rather than waiting behind it. The operation must
   * await the work it joins: if it finishes while joined work is still
   * running, or joined work failed, the whole transaction rolls back. A store
   * used after its transaction ended refuses every call, so late work can
   * never write outside a transaction.
   */
  transaction<T>(operation: (store: Store) => Promise<T>): Promise<T> {
    const current = this.active.getStore();
    if (current?.open === true) {
      const joined = { settled: false, failed: false };
      current.joined.push(joined);
      return operation(current.store).then(
        (result) => {
          joined.settled = true;
          return result;
        },
        (error: unknown) => {
          joined.settled = true;
          joined.failed = true;
          throw error;
        },
      );
    }
    const transaction: Transaction = { open: true, joined: [], store: this.store };
    transaction.store = guard(this.store, () => transaction.open);
    const run = () =>
      this.active.run(transaction, async () => {
        this.sql.exec("BEGIN IMMEDIATE");
        try {
          const result = await operation(transaction.store);
          // Joined work belongs to this transaction, so it must have finished, and succeeded.
          if (transaction.joined.some((joined) => !joined.settled)) {
            throw new Error("A Critiqs operation finished before work it started in its transaction.");
          }
          if (transaction.joined.some((joined) => joined.failed)) {
            throw new Error("Work joined to this Critiqs transaction failed.");
          }
          transaction.open = false;
          this.sql.exec("COMMIT");
          return result;
        } catch (error) {
          transaction.open = false;
          // SQLite may already have ended a failed transaction.
          try {
            this.sql.exec("ROLLBACK");
          } catch {}
          throw error;
        }
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Runs work that needs SQL beyond Critiqs's store, such as sign-in state, in
   * its own transaction alongside the store; or joins the current one.
   */
  withSql<T>(work: (sql: SqlDriver, store: Store) => Promise<T> | T): Promise<T> {
    return this.transaction(async (store) => await work(this.sql, store));
  }

  /** Stores an uploaded file and returns its ID. */
  saveFile(data: Uint8Array, contentType: string | null): Promise<string> {
    return this.transaction(async () => {
      if (this.active.getStore()?.open !== true) throw new Error("This Critiqs store's transaction has ended.");
      const id = newId("files");
      this.sql.run("INSERT INTO files (id, content_type, size, created_at, data) VALUES (?, ?, ?, ?, ?)", [
        id,
        contentType,
        data.byteLength,
        Date.now(),
        data,
      ]);
      return id;
    });
  }

  /** A stored file's bytes and type, or null when there is none. */
  readFile(fileId: string): { data: Uint8Array; contentType: string | null } | null {
    if (!ID_PATTERN.test(fileId)) return null;
    const row = this.sql.get<{ data: Uint8Array; content_type: string | null }>(
      "SELECT data, content_type FROM files WHERE id = ?",
      [fileId],
    );
    return row === undefined ? null : { data: row.data, contentType: row.content_type };
  }
}

interface Transaction {
  open: boolean;
  /** Work started inside the operation that joined its transaction. */
  joined: { settled: boolean; failed: boolean }[];
  /** The store as this transaction's operation sees it. */
  store: Store;
}

/** A store whose every call fails once `isOpen` turns false. */
function guard(store: Store, isOpen: () => boolean): Store {
  const wrap = <T extends object>(target: T): T =>
    Object.fromEntries(
      Object.entries(target).map(([key, value]) => [
        key,
        typeof value === "function"
          ? (...args: unknown[]) => {
              if (!isOpen()) throw new Error("This Critiqs store's transaction has ended.");
              return value(...args);
            }
          : wrap(value as object),
      ]),
    ) as T;
  return wrap(store);
}

function sqliteStore(sql: SqlDriver, options: SqliteOptions): Store {
  const json = (value: unknown) => JSON.stringify(value);

  /**
   * One page in key order. The cursor is the last row's key: its sequence, or
   * for messages its time and then sequence, so pages never repeat or skip a
   * row when others are added or removed.
   */
  function page<Row extends { seq: number }, T>(
    query: string,
    params: SqlValue[],
    request: PageRequest,
    map: (row: Row) => T,
    byTime = false,
  ): PageResult<T> {
    const cursor = request.cursor === null || request.cursor === "" ? null : request.cursor;
    let after = "";
    let afterParams: SqlValue[] = [];
    if (cursor !== null) {
      const parts = cursor.split(":").map(Number);
      if (parts.length !== (byTime ? 2 : 1) || !parts.every((part) => Number.isSafeInteger(part) && part >= 0)) {
        throw new Error("Invalid page cursor.");
      }
      after = byTime ? " AND (created_at, seq) > (?, ?)" : " AND seq > ?";
      afterParams = parts;
    }
    const order = byTime ? "created_at, seq" : "seq";
    const rows = sql.all<Row & { created_at?: number }>(`${query}${after} ORDER BY ${order} LIMIT ?`, [
      ...params,
      ...afterParams,
      request.numItems + 1,
    ]);
    const isDone = rows.length <= request.numItems;
    const shown = rows.slice(0, request.numItems);
    const last = shown.at(-1);
    return {
      page: shown.map(map),
      isDone,
      continueCursor: last === undefined ? (cursor ?? "") : byTime ? `${last.created_at}:${last.seq}` : String(last.seq),
    };
  }

  const user = (row: UserRow): UserRecord => ({
    _id: row.id,
    tokenIdentifier: row.token,
    name: row.name,
    email: row.email,
    imageUrl: row.image_url,
    ...(row.profile_version === null ? {} : { profileVersion: row.profile_version }),
    ...(row.plan === null ? {} : { plan: row.plan }),
    ...(row.home_organization_id === null ? {} : { homeOrganizationId: row.home_organization_id }),
    ...(row.role === null ? {} : { role: row.role as Role }),
    ...(row.team_size === null ? {} : { teamSize: row.team_size as TeamSize }),
  });
  const organization = (row: OrganizationRow): OrganizationRecord => ({
    _id: row.id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.plan === null ? {} : { plan: row.plan }),
    ...(row.overage_cap === null ? {} : { overageCap: JSON.parse(row.overage_cap) as number | null }),
    ...(row.extra_storage_units === null ? {} : { extraStorageUnits: row.extra_storage_units }),
  });
  const membership = (row: MembershipRow): MembershipRecord => ({
    _id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role === "admin" ? "admin" : "member",
    createdAt: row.created_at,
  });
  const invite = (row: InviteRow): InviteRecord => ({
    _id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    role: row.role === "admin" ? "admin" : "member",
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
  });
  const developerSend = (row: DeveloperSendRow): DeveloperSendRecord => ({
    _id: row.id,
    projectId: row.project_id,
    email: row.email,
    sentBy: row.sent_by,
    createdAt: row.created_at,
    reservedAt: row.reserved_at,
    emailNumber: row.email_number,
    attempts: JSON.parse(row.attempts) as DeveloperAttempt[],
    ...(row.message === null ? {} : { message: JSON.parse(row.message) as StoredMail }),
  });
  const project = (row: ProjectRow): ProjectRecord => ({
    _id: row.id,
    name: row.name,
    tags: JSON.parse(row.tags) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.review_url === null ? {} : { reviewUrl: row.review_url }),
    ...(row.organization_id === null ? {} : { organizationId: row.organization_id }),
    ...(row.onboarding === null ? {} : { onboarding: JSON.parse(row.onboarding) as ProjectOnboarding }),
  });
  const thread = (row: ThreadRow): ThreadRecord => ({
    _id: row.id,
    projectId: row.project_id,
    status: row.status as ThreadRecord["status"],
    anchor: JSON.parse(row.anchor),
    tags: JSON.parse(row.tags) as string[],
    capture: JSON.parse(row.capture),
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    editCount: row.edit_count,
    ...(row.status_changed_by === null ? {} : { statusChangedBy: row.status_changed_by }),
    ...(row.status_changed_at === null ? {} : { statusChangedAt: row.status_changed_at }),
    ...(row.reattachment === null ? {} : { reattachment: JSON.parse(row.reattachment) }),
    ...(row.text_tags === null ? {} : { textTags: JSON.parse(row.text_tags) as TextTag[] }),
    ...(row.followers_ready === null ? {} : { followersReady: row.followers_ready === 1 }),
  });
  const message = (row: MessageRow): MessageRecord => ({
    _id: row.id,
    threadId: row.thread_id,
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    revision: row.revision,
    ...(row.mentions === null ? {} : { mentions: JSON.parse(row.mentions) as StoredMention[] }),
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.hashtags === null ? {} : { hashtags: JSON.parse(row.hashtags) as string[] }),
    ...(row.via === "agent" ? { via: "agent" as const } : {}),
  });
  const tag = (row: TagRow): TagRecord => ({
    _id: row.id,
    projectId: row.project_id,
    key: row.key,
    label: row.label,
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at,
    groupIds: JSON.parse(row.group_ids) as string[],
    grouping: row.grouping as TagRecord["grouping"],
    epoch: row.epoch,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  });
  const tagGroup = (row: TagGroupRow): TagGroupRecord => ({
    _id: row.id,
    projectId: row.project_id,
    name: row.name,
    nameKey: row.name_key,
    origin: row.origin as TagGroupRecord["origin"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const threadTag = (row: ThreadTagRow): ThreadTagRecord => ({ _id: row.id, projectId: row.project_id, threadId: row.thread_id, key: row.key });
  /** The fields every AI connection stores, a project's or a person's. */
  const connection = (row: ConnectionRow): StoredConnection => ({
    enabled: row.enabled === 1,
    mode: row.mode as StoredConnection["mode"],
    ...(row.managed_model === null ? {} : { managedModel: row.managed_model }),
    ...(row.provider === null ? {} : { provider: row.provider as StoredConnection["provider"] }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.models === null ? {} : { models: JSON.parse(row.models) as string[] }),
    ...(row.base_url === null ? {} : { baseUrl: row.base_url }),
    ...(row.secret === null ? {} : { secret: JSON.parse(row.secret) }),
    epoch: row.epoch,
    updatedAt: row.updated_at,
    ...(row.last_test === null ? {} : { lastTest: JSON.parse(row.last_test) }),
  });
  const aiSettings = (row: AiSettingsRow): AiSettingsRecord => ({
    _id: row.id,
    projectId: row.project_id,
    ...connection(row),
    updatedBy: row.updated_by,
    ...(row.rule === null ? {} : { rule: row.rule as NonNullable<AiSettingsRecord["rule"]> }),
    ...(row.allowed_models === null ? {} : { allowedModels: JSON.parse(row.allowed_models) as string[] }),
  });
  const personalAiSettings = (row: PersonalAiSettingsRow): PersonalAiSettingsRecord => ({ _id: row.id, userId: row.user_id, ...connection(row) });
  /** Connection columns to update; `null` clears an optional field, `undefined` leaves it. */
  const connectionColumns = (changes: PersonalAiSettingsChanges) => {
    const optional = (value: unknown) => (value === undefined ? undefined : value === null ? null : typeof value === "string" ? value : json(value));
    return {
      enabled: changes.enabled === undefined ? undefined : changes.enabled ? 1 : 0,
      mode: changes.mode,
      managed_model: optional(changes.managedModel),
      provider: optional(changes.provider),
      model: optional(changes.model),
      models: optional(changes.models),
      base_url: optional(changes.baseUrl),
      secret: optional(changes.secret),
      epoch: changes.epoch,
      updated_at: changes.updatedAt,
      last_test: optional(changes.lastTest),
    };
  };
  const update = (table: string, id: string, columns: Record<string, unknown>) => {
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined) as [string, SqlValue][];
    if (entries.length === 0) return;
    sql.run(`UPDATE ${table} SET ${entries.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`, [...entries.map(([, value]) => value), id]);
  };
  /** Whether messages have a full-text index (FTS5), checked once. */
  const fullText = sql.get("SELECT 1 FROM sqlite_master WHERE name = 'message_search'") !== undefined;
  const reaction = (row: ReactionRow): ReactionRecord => ({
    _id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    userId: row.user_id,
    emoji: row.emoji,
  });
  const participant = (row: ParticipantRow): ParticipantRecord => ({
    _id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    lastActiveAt: row.last_active_at,
  });
  const delivery = (row: DeliveryRow): DeliveryRecord => ({
    _id: row.id,
    recipientId: row.recipient_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    status: row.status as DeliveryRecord["status"],
    attempts: row.attempts,
    dueAt: row.due_at,
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
    ...(row.message === null ? {} : { message: JSON.parse(row.message) }),
    ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) }),
    createdAt: row.created_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  });
  const planAlert = (row: PlanAlertRow): PlanAlertRecord => ({
    _id: row.id,
    organizationId: row.organization_id,
    kind: row.kind as PlanAlertKind,
    month: row.month,
    plan: row.plan,
    planLabel: row.plan_label,
    included: row.included,
    ...(row.overage === null ? {} : { overage: JSON.parse(row.overage) as { cap: number | null } }),
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    status: row.status as PlanAlertRecord["status"],
    attempts: row.attempts,
    dueAt: row.due_at,
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
    createdAt: row.created_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  });
  const notification = (row: NotificationRow): NotificationRecord => ({
    _id: row.id,
    deliveryId: row.delivery_id,
    recipientId: row.recipient_id,
    messageId: row.message_id,
    authorId: row.author_id,
    createdAt: row.created_at,
    ...(row.kind === "mention" || row.kind === "reply" ? { kind: row.kind } : {}),
  });
  const follower = (row: FollowerRow): FollowerRecord => ({ _id: row.id, threadId: row.thread_id, userId: row.user_id, since: row.since });
  const replyEmailJob = (row: ReplyEmailJobRow): ReplyEmailJobRecord => ({
    _id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    authorId: row.author_id,
    createdAt: row.created_at,
    position: row.position,
    stage: row.stage === "scan" ? "scan" : "notify",
    cursor: row.cursor,
  });
  const preference = (row: PreferenceRow): PreferenceRecord => ({
    _id: row.id,
    userId: row.user_id,
    mentionEmails: row.mention_emails === 1,
    ...(row.reply_emails === null ? {} : { replyEmails: row.reply_emails === 1 }),
    mutedProjects: JSON.parse(row.muted_projects) as string[],
  });
  const readState = (row: ReadStateRow): ReadStateRecord => ({
    _id: row.id,
    userId: row.user_id,
    threadId: row.thread_id,
    lastReadAt: row.last_read_at,
    manualUnread: row.manual_unread === 1,
  });

  /** Updates only the given columns of one row. */
  function patch(table: string, id: string, columns: Record<string, SqlValue | undefined>) {
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined) as [string, SqlValue][];
    if (entries.length === 0) return;
    sql.run(`UPDATE ${table} SET ${entries.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`, [
      ...entries.map(([, value]) => value),
      id,
    ]);
  }

  return {
    normalizeId: (table, raw) => (ID_PATTERN.test(raw) && raw.startsWith(`${PREFIX[table]}_`) ? raw : null),

    users: {
      byToken: async (token) => {
        const row = sql.get<UserRow>("SELECT * FROM users WHERE token = ?", [token]);
        return row === undefined ? null : user(row);
      },
      get: async (id) => {
        const row = sql.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
        return row === undefined ? null : user(row);
      },
      insert: async (record) => {
        const id = newId("users");
        sql.run("INSERT INTO users (id, token, name, email, image_url, profile_version, plan, home_organization_id, role, team_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
          id,
          record.tokenIdentifier,
          record.name,
          record.email,
          record.imageUrl,
          record.profileVersion ?? null,
          record.plan ?? null,
          record.homeOrganizationId ?? null,
          record.role ?? null,
          record.teamSize ?? null,
        ]);
        return id;
      },
      patch: async (id, changes) =>
        patch("users", id, {
          name: changes.name,
          email: changes.email,
          image_url: changes.imageUrl,
          plan: changes.plan,
          profile_version: changes.profileVersion,
          home_organization_id: changes.homeOrganizationId,
          role: changes.role,
          team_size: changes.teamSize,
        }),
    },

    organizations: {
      get: async (id) => {
        const row = sql.get<OrganizationRow>("SELECT * FROM organizations WHERE id = ?", [id]);
        return row === undefined ? null : organization(row);
      },
      insert: async (record) => {
        const id = newId("organizations");
        sql.run("INSERT INTO organizations (id, name, created_by, created_at, plan, overage_cap, extra_storage_units) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          id,
          record.name,
          record.createdBy,
          record.createdAt,
          record.plan ?? null,
          record.overageCap === undefined ? null : json(record.overageCap),
          record.extraStorageUnits ?? null,
        ]);
        return id;
      },
      patch: async (id, changes) =>
        patch("organizations", id, {
          name: changes.name,
          plan: changes.plan,
          overage_cap: changes.overageCap === undefined ? undefined : changes.overageCap === "default" ? null : json(changes.overageCap),
          extra_storage_units: changes.extraStorageUnits,
        }),
    },

    memberships: {
      find: async (organizationId, userId) => {
        const row = sql.get<MembershipRow>("SELECT * FROM memberships WHERE organization_id = ? AND user_id = ?", [organizationId, userId]);
        return row === undefined ? null : membership(row);
      },
      insert: async (record) => {
        const id = newId("memberships");
        sql.run("INSERT INTO memberships (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)", [
          id,
          record.organizationId,
          record.userId,
          record.role,
          record.createdAt,
        ]);
        return id;
      },
      patch: async (id, changes) => patch("memberships", id, { role: changes.role }),
      delete: async (id) => sql.run("DELETE FROM memberships WHERE id = ?", [id]),
      forUser: async (userId, limit) =>
        sql.all<MembershipRow>("SELECT * FROM memberships WHERE user_id = ? ORDER BY seq LIMIT ?", [userId, limit]).map(membership),
      admins: async (organizationId, limit) =>
        sql
          .all<MembershipRow>("SELECT * FROM memberships WHERE organization_id = ? AND role = 'admin' ORDER BY seq LIMIT ?", [organizationId, limit])
          .map(membership),
      forOrganization: async (organizationId, limit) =>
        sql.all<MembershipRow>("SELECT * FROM memberships WHERE organization_id = ? ORDER BY seq LIMIT ?", [organizationId, limit]).map(membership),
    },

    developerSends: {
      get: async (id) => {
        const row = sql.get<DeveloperSendRow>("SELECT * FROM developer_sends WHERE id = ?", [id]);
        return row === undefined ? null : developerSend(row);
      },
      find: async (projectId, email) => {
        const row = sql.get<DeveloperSendRow>("SELECT * FROM developer_sends WHERE project_id = ? AND email = ?", [projectId, email]);
        return row === undefined ? null : developerSend(row);
      },
      forProject: async (projectId, limit) =>
        sql.all<DeveloperSendRow>("SELECT * FROM developer_sends WHERE project_id = ? ORDER BY seq LIMIT ?", [projectId, limit]).map(developerSend),
      insert: async (record) => {
        const id = newId("developerSends");
        sql.run(
          `INSERT INTO developer_sends (id, project_id, email, sent_by, created_at, reserved_at, email_number, attempts, message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            record.projectId,
            record.email,
            record.sentBy,
            record.createdAt,
            record.reservedAt,
            record.emailNumber,
            json(record.attempts),
            record.message === undefined ? null : json(record.message),
          ],
        );
        return id;
      },
      patch: async (id, changes) =>
        patch("developer_sends", id, {
          sent_by: changes.sentBy,
          reserved_at: changes.reservedAt,
          email_number: changes.emailNumber,
          attempts: changes.attempts === undefined ? undefined : json(changes.attempts),
          message: changes.message === undefined ? undefined : changes.message === null ? null : json(changes.message),
        }),
    },
    emailSuppressions: {
      has: async (inbox) => sql.get("SELECT 1 FROM email_suppressions WHERE inbox = ?", [inbox]) !== undefined,
      add: async (inbox, now) => sql.run("INSERT INTO email_suppressions (inbox, created_at) VALUES (?, ?) ON CONFLICT(inbox) DO NOTHING", [inbox, now]),
    },

    invites: {
      get: async (id) => {
        const row = sql.get<InviteRow>("SELECT * FROM invites WHERE id = ?", [id]);
        return row === undefined ? null : invite(row);
      },
      findPending: async (organizationId, email) => {
        const row = sql.get<InviteRow>("SELECT * FROM invites WHERE organization_id = ? AND email = ? AND accepted_at IS NULL ORDER BY seq LIMIT 1", [
          organizationId,
          email,
        ]);
        return row === undefined ? null : invite(row);
      },
      insert: async (record) => {
        const id = newId("invites");
        sql.run("INSERT INTO invites (id, organization_id, email, role, invited_by, created_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          id,
          record.organizationId,
          record.email,
          record.role,
          record.invitedBy,
          record.createdAt,
          record.acceptedAt ?? null,
        ]);
        return id;
      },
      patch: async (id, changes) => patch("invites", id, { accepted_at: changes.acceptedAt }),
      delete: async (id) => sql.run("DELETE FROM invites WHERE id = ?", [id]),
      pendingForOrganization: async (organizationId, limit) =>
        sql.all<InviteRow>("SELECT * FROM invites WHERE organization_id = ? AND accepted_at IS NULL ORDER BY seq LIMIT ?", [organizationId, limit]).map(invite),
      pendingForEmail: async (email, limit) =>
        sql.all<InviteRow>("SELECT * FROM invites WHERE email = ? AND accepted_at IS NULL ORDER BY seq LIMIT ?", [email, limit]).map(invite),
    },

    projects: {
      get: async (id) => {
        const row = sql.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
        return row === undefined ? null : project(row);
      },
      insert: async (record) => {
        const id = newId("projects");
        sql.run("INSERT INTO projects (id, name, tags, created_by, created_at, review_url, organization_id, onboarding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
          id,
          record.name,
          json(record.tags),
          record.createdBy,
          record.createdAt,
          record.reviewUrl ?? null,
          record.organizationId ?? null,
          record.onboarding === undefined ? null : json(record.onboarding),
        ]);
        return id;
      },
      patch: async (id, changes) => patch("projects", id, { review_url: changes.reviewUrl, organization_id: changes.organizationId }),
      listByCreator: async (userId, request) =>
        page<ProjectRow, ProjectRecord>("SELECT * FROM projects WHERE created_by = ?", [userId], request, project),
    },

    threads: {
      get: async (id) => {
        const row = sql.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", [id]);
        return row === undefined ? null : thread(row);
      },
      insert: async (record) => {
        const id = newId("threads");
        sql.run(
          `INSERT INTO threads (id, project_id, status, anchor, tags, capture, capture_file, created_by, created_at,
             last_message_at, message_count, status_changed_by, status_changed_at, reattachment, text_tags, followers_ready)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            record.projectId,
            record.status,
            json(record.anchor),
            json(record.tags),
            json(record.capture),
            record.capture.status === "failed" ? null : record.capture.fileId,
            record.createdBy,
            record.createdAt,
            record.lastMessageAt,
            record.messageCount,
            record.statusChangedBy ?? null,
            record.statusChangedAt ?? null,
            record.reattachment === undefined ? null : json(record.reattachment),
            record.textTags === undefined ? null : json(record.textTags),
            record.followersReady === undefined ? null : record.followersReady ? 1 : 0,
          ],
        );
        return id;
      },
      patch: async (id, changes) =>
        patch("threads", id, {
          status: changes.status,
          tags: changes.tags === undefined ? undefined : json(changes.tags),
          capture: changes.capture === undefined ? undefined : json(changes.capture),
          capture_file:
            changes.capture === undefined ? undefined : changes.capture.status === "failed" ? null : changes.capture.fileId,
          last_message_at: changes.lastMessageAt,
          message_count: changes.messageCount,
          edit_count: changes.editCount,
          status_changed_by: changes.statusChangedBy,
          status_changed_at: changes.statusChangedAt,
          reattachment: changes.reattachment === undefined ? undefined : json(changes.reattachment),
          text_tags: changes.textTags === undefined ? undefined : json(changes.textTags),
          followers_ready: changes.followersReady === undefined ? undefined : changes.followersReady ? 1 : 0,
        }),
      listVisible: async (projectId, request) =>
        page<ThreadRow, ThreadRecord>(
          "SELECT * FROM threads WHERE project_id = ? AND status != 'deleted'",
          [projectId],
          request,
          thread,
        ),
      byCaptureFile: async (fileId) => {
        const row = sql.get<ThreadRow>("SELECT * FROM threads WHERE capture_file = ? LIMIT 1", [fileId]);
        return row === undefined ? null : thread(row);
      },
      recent: async (projectId, limit) =>
        sql
          .all<ThreadRow>("SELECT * FROM threads WHERE project_id = ? AND status != 'deleted' ORDER BY last_message_at DESC LIMIT ?", [projectId, limit])
          .map(thread),
    },

    messages: {
      get: async (id) => {
        const row = sql.get<MessageRow>("SELECT * FROM messages WHERE id = ?", [id]);
        return row === undefined ? null : message(row);
      },
      insert: async (record) => {
        const id = newId("messages");
        sql.run(
          "INSERT INTO messages (id, thread_id, author_id, body, created_at, edited_at, revision, mentions, project_id, hashtags, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            id,
            record.threadId,
            record.authorId,
            record.body,
            record.createdAt,
            record.editedAt,
            record.revision,
            record.mentions === undefined ? null : json(record.mentions),
            record.projectId ?? null,
            record.hashtags === undefined ? null : json(record.hashtags),
            record.via ?? null,
          ],
        );
        return id;
      },
      patch: async (id, changes) =>
        patch("messages", id, {
          body: changes.body,
          edited_at: changes.editedAt,
          mentions: changes.mentions === undefined ? undefined : json(changes.mentions),
          project_id: changes.projectId,
          hashtags: changes.hashtags === undefined ? undefined : json(changes.hashtags),
        }),
      list: async (threadId, request) =>
        page<MessageRow, MessageRecord>("SELECT * FROM messages WHERE thread_id = ?", [threadId], request, message, true),
      first: async (threadId) => {
        const row = sql.get<MessageRow>("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, seq LIMIT 1", [threadId]);
        return row === undefined ? null : message(row);
      },
      latest: async (threadId, limit) =>
        sql.all<MessageRow>("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?", [threadId, limit]).map(message),

      search: async (projectId, terms, limit) => {
        const words = terms.map((term) => term.trim()).filter((term) => term !== "").slice(0, 16);
        if (words.length === 0) return [];
        if (fullText) {
          // Each word, or the start of a word; phrases match as written.
          const match = words.map((word) => `"${word.replace(/"/g, '""')}"${/\s/.test(word) ? "" : "*"}`).join(" OR ");
          return sql
            .all<MessageRow>(
              `SELECT messages.* FROM message_search JOIN messages ON messages.seq = message_search.rowid
               WHERE message_search MATCH ? AND messages.project_id = ? ORDER BY bm25(message_search) LIMIT ?`,
              [match, projectId, limit],
            )
            .map(message);
        }
        const like = words.map(() => "lower(body) LIKE ? ESCAPE '\\'").join(" OR ");
        return sql
          .all<MessageRow>(`SELECT * FROM messages WHERE project_id = ? AND (${like}) ORDER BY created_at DESC LIMIT ?`, [
            projectId,
            ...words.map((word) => `%${word.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`),
            limit,
          ])
          .map(message);
      },
    },

    reactions: {
      find: async (messageId, userId, emoji) => {
        const row = sql.get<ReactionRow>("SELECT * FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", [
          messageId,
          userId,
          emoji,
        ]);
        return row === undefined ? null : reaction(row);
      },
      insert: async (record) => {
        const id = newId("reactions");
        sql.run("INSERT INTO reactions (id, thread_id, message_id, user_id, emoji) VALUES (?, ?, ?, ?, ?)", [
          id,
          record.threadId,
          record.messageId,
          record.userId,
          record.emoji,
        ]);
        return id;
      },
      delete: async (id) => sql.run("DELETE FROM reactions WHERE id = ?", [id]),
      list: async (threadId, request) =>
        page<ReactionRow, ReactionRecord>("SELECT * FROM reactions WHERE thread_id = ?", [threadId], request, reaction),
    },

    readStates: {
      find: async (userId, threadId) => {
        const row = sql.get<ReadStateRow>("SELECT * FROM read_states WHERE user_id = ? AND thread_id = ?", [userId, threadId]);
        return row === undefined ? null : readState(row);
      },
      insert: async (record) => {
        const id = newId("readStates");
        sql.run("INSERT INTO read_states (id, user_id, thread_id, last_read_at, manual_unread) VALUES (?, ?, ?, ?, ?)", [
          id,
          record.userId,
          record.threadId,
          record.lastReadAt,
          record.manualUnread ? 1 : 0,
        ]);
        return id;
      },
      patch: async (id, changes) =>
        patch("read_states", id, {
          last_read_at: changes.lastReadAt,
          manual_unread: changes.manualUnread === undefined ? undefined : changes.manualUnread ? 1 : 0,
        }),
    },

    participants: {
      find: async (projectId, userId) => {
        const row = sql.get<ParticipantRow>("SELECT * FROM participants WHERE project_id = ? AND user_id = ?", [projectId, userId]);
        return row === undefined ? null : participant(row);
      },
      insert: async (record) => {
        const id = newId("participants");
        sql.run("INSERT INTO participants (id, project_id, user_id, last_active_at) VALUES (?, ?, ?, ?)", [
          id,
          record.projectId,
          record.userId,
          record.lastActiveAt,
        ]);
        return id;
      },
      patch: async (id, changes) => patch("participants", id, { last_active_at: changes.lastActiveAt }),
      recent: async (projectId, limit) =>
        sql
          .all<ParticipantRow>("SELECT * FROM participants WHERE project_id = ? ORDER BY last_active_at DESC, seq DESC LIMIT ?", [
            projectId,
            limit,
          ])
          .map(participant),
    },

    planAlerts: {
      get: async (id) => {
        const row = sql.get<PlanAlertRow>("SELECT * FROM plan_alerts WHERE id = ?", [id]);
        return row === undefined ? null : planAlert(row);
      },
      find: async (organizationId, kind, month, plan) => {
        const row = sql.get<PlanAlertRow>("SELECT * FROM plan_alerts WHERE organization_id = ? AND kind = ? AND month = ? AND plan = ?", [organizationId, kind, month, plan]);
        return row === undefined ? null : planAlert(row);
      },
      insert: async (record) => {
        const id = newId("planAlerts");
        sql.run(
          `INSERT INTO plan_alerts (id, organization_id, kind, month, plan, plan_label, included, overage, project_id, status, attempts, due_at,
             claim_token, lease_until, created_at, finished_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            record.organizationId,
            record.kind,
            record.month,
            record.plan,
            record.planLabel,
            record.included,
            record.overage === undefined ? null : json(record.overage),
            record.projectId ?? null,
            record.status,
            record.attempts,
            record.dueAt,
            record.claimToken ?? null,
            record.leaseUntil ?? null,
            record.createdAt,
            record.finishedAt ?? null,
            record.reason ?? null,
          ],
        );
        return id;
      },
      patch: async (id, changes) =>
        patch("plan_alerts", id, {
          status: changes.status,
          attempts: changes.attempts,
          due_at: changes.dueAt,
          claim_token: changes.claimToken,
          lease_until: changes.leaseUntil,
          finished_at: changes.finishedAt,
          reason: changes.reason,
        }),
      due: async (now, limit) =>
        sql
          .all<PlanAlertRow>(
            `SELECT * FROM (
               SELECT * FROM (SELECT * FROM plan_alerts WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?)
               UNION ALL
               SELECT * FROM (SELECT * FROM plan_alerts WHERE status = 'sending' AND lease_until <= ? ORDER BY lease_until LIMIT ?)
             ) ORDER BY due_at, seq LIMIT ?`,
            [now, limit, now, limit, limit],
          )
          .map(planAlert),
    },

    deliveries: {
      get: async (id) => {
        const row = sql.get<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", [id]);
        return row === undefined ? null : delivery(row);
      },
      insert: async (record) => {
        const id = newId("deliveries");
        sql.run(
          `INSERT INTO deliveries (id, recipient_id, project_id, thread_id, status, attempts, due_at, claim_token, lease_until,
             message, created_at, finished_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            record.recipientId,
            record.projectId,
            record.threadId,
            record.status,
            record.attempts,
            record.dueAt,
            record.claimToken ?? null,
            record.leaseUntil ?? null,
            record.message === undefined ? null : json(record.message),
            record.createdAt,
            record.finishedAt ?? null,
            record.reason ?? null,
          ],
        );
        return id;
      },
      patch: async (id, changes) =>
        patch("deliveries", id, {
          status: changes.status,
          attempts: changes.attempts,
          due_at: changes.dueAt,
          claim_token: changes.claimToken,
          lease_until: changes.leaseUntil,
          message: changes.message === undefined ? undefined : json(changes.message),
          payload: changes.payload === undefined ? undefined : json(changes.payload),
          finished_at: changes.finishedAt,
          reason: changes.reason,
        }),
      gathering: async (recipientId, threadId) => {
        const row = sql.get<DeliveryRow>(
          "SELECT * FROM deliveries WHERE recipient_id = ? AND thread_id = ? AND status = 'pending' AND attempts = 0 ORDER BY seq DESC LIMIT 1",
          [recipientId, threadId],
        );
        return row === undefined ? null : delivery(row);
      },
      due: async (now, limit) =>
        sql
          .all<DeliveryRow>(
            `SELECT * FROM (
               SELECT * FROM (SELECT * FROM deliveries WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?)
               UNION ALL
               SELECT * FROM (SELECT * FROM deliveries WHERE status = 'sending' AND lease_until <= ? ORDER BY lease_until LIMIT ?)
             ) ORDER BY due_at, seq LIMIT ?`,
            [now, limit, now, limit, limit],
          )
          .map(delivery),
      finishedBefore: async (before, limit) =>
        sql
          .all<DeliveryRow>("SELECT * FROM deliveries WHERE finished_at IS NOT NULL AND finished_at < ? ORDER BY finished_at LIMIT ?", [
            before,
            limit,
          ])
          .map(delivery),
      delete: async (id) => sql.run("DELETE FROM deliveries WHERE id = ?", [id]),
    },

    notifications: {
      insert: async (record) => {
        const id = newId("notifications");
        sql.run(
          "INSERT INTO notifications (id, delivery_id, recipient_id, message_id, author_id, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [id, record.deliveryId, record.recipientId, record.messageId, record.authorId, record.createdAt, record.kind ?? null],
        );
        return id;
      },
      forDelivery: async (deliveryId, limit) =>
        sql
          .all<NotificationRow>("SELECT * FROM notifications WHERE delivery_id = ? ORDER BY seq LIMIT ?", [deliveryId, limit])
          .map(notification),
      delete: async (id) => sql.run("DELETE FROM notifications WHERE id = ?", [id]),
    },

    followers: {
      find: async (threadId, userId) => {
        const row = sql.get<FollowerRow>("SELECT * FROM thread_followers WHERE thread_id = ? AND user_id = ?", [threadId, userId]);
        return row === undefined ? null : follower(row);
      },
      insert: async (record) => {
        const id = newId("followers");
        sql.run("INSERT INTO thread_followers (id, thread_id, user_id, since) VALUES (?, ?, ?, ?)", [id, record.threadId, record.userId, record.since]);
        return id;
      },
      list: async (threadId, request) => page<FollowerRow, FollowerRecord>("SELECT * FROM thread_followers WHERE thread_id = ?", [threadId], request, follower),
    },

    replyEmailJobs: {
      insert: async (record) => {
        const id = newId("replyEmailJobs");
        sql.run(
          "INSERT INTO reply_email_jobs (id, project_id, thread_id, message_id, author_id, created_at, position, stage, cursor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, record.projectId, record.threadId, record.messageId, record.authorId, record.createdAt, record.position, record.stage, record.cursor],
        );
        return id;
      },
      next: async () => {
        const row = sql.get<ReplyEmailJobRow>("SELECT * FROM reply_email_jobs ORDER BY created_at, seq LIMIT 1", []);
        return row === undefined ? null : replyEmailJob(row);
      },
      patch: async (id, changes) => patch("reply_email_jobs", id, { stage: changes.stage, cursor: changes.cursor }),
      delete: async (id) => sql.run("DELETE FROM reply_email_jobs WHERE id = ?", [id]),
    },

    preferences: {
      find: async (userId) => {
        const row = sql.get<PreferenceRow>("SELECT * FROM preferences WHERE user_id = ?", [userId]);
        return row === undefined ? null : preference(row);
      },
      insert: async (record) => {
        const id = newId("preferences");
        sql.run("INSERT INTO preferences (id, user_id, mention_emails, muted_projects, reply_emails) VALUES (?, ?, ?, ?, ?)", [
          id,
          record.userId,
          record.mentionEmails ? 1 : 0,
          json(record.mutedProjects),
          record.replyEmails === undefined ? null : record.replyEmails ? 1 : 0,
        ]);
        return id;
      },
      patch: async (id, changes) =>
        patch("preferences", id, {
          mention_emails: changes.mentionEmails === undefined ? undefined : changes.mentionEmails ? 1 : 0,
          reply_emails: changes.replyEmails === undefined ? undefined : changes.replyEmails ? 1 : 0,
          muted_projects: changes.mutedProjects === undefined ? undefined : json(changes.mutedProjects),
        }),
    },

    limits: {
      enabled: () => options.plans !== undefined,
      plan: async (name) => options.plans?.[name] ?? null,
    },

    usage: {
      find: async (key) => {
        const row = sql.get<{ id: string; key: string; count: number }>("SELECT id, key, count FROM usage WHERE key = ?", [key]);
        return row === undefined ? null : { _id: row.id, key: row.key, count: row.count };
      },
      insert: async (record) => {
        const id = newId("usage");
        sql.run("INSERT INTO usage (id, key, count) VALUES (?, ?, ?)", [id, record.key, record.count]);
        return id;
      },
      patch: async (id, changes) => patch("usage", id, { count: changes.count }),
      isMember: async (key, member) => sql.get("SELECT 1 FROM usage_members WHERE key = ? AND member = ?", [key, member]) !== undefined,
      addMember: async (key, member) => sql.run("INSERT OR IGNORE INTO usage_members (key, member) VALUES (?, ?)", [key, member]),
    },

    creditHolds: {
      held: async (scope, now) =>
        sql.get<{ held: number }>("SELECT coalesce(sum(credits), 0) AS held FROM credit_holds WHERE scope = ? AND expires_at > ?", [scope, now])!.held,
      insert: async (hold, now) => {
        sql.run("DELETE FROM credit_holds WHERE scope = ? AND expires_at <= ?", [hold.scope, now]);
        const id = newId("creditHolds");
        sql.run("INSERT INTO credit_holds (id, scope, credits, expires_at) VALUES (?, ?, ?, ?)", [id, hold.scope, hold.credits, hold.expiresAt]);
        return id;
      },
      delete: async (id) => sql.run("DELETE FROM credit_holds WHERE id = ?", [id]),
    },

    tags: {
      find: async (projectId, key) => {
        const row = sql.get<TagRow>("SELECT * FROM tags WHERE project_id = ? AND key = ?", [projectId, key]);
        return row === undefined ? null : tag(row);
      },
      get: async (id) => {
        const row = sql.get<TagRow>("SELECT * FROM tags WHERE id = ?", [id]);
        return row === undefined ? null : tag(row);
      },
      insert: async (record) => {
        const id = newId("tags");
        sql.run(
          `INSERT INTO tags (id, project_id, key, label, first_used_at, last_used_at, group_ids, grouping, epoch, attempts, next_attempt_at,
             claim_token, lease_until, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            record.projectId,
            record.key,
            record.label,
            record.firstUsedAt,
            record.lastUsedAt,
            json(record.groupIds),
            record.grouping,
            record.epoch,
            record.attempts,
            record.nextAttemptAt,
            record.claimToken ?? null,
            record.leaseUntil ?? null,
            record.lastError ?? null,
          ],
        );
        return id;
      },
      patch: async (id, changes) =>
        patch("tags", id, {
          label: changes.label,
          last_used_at: changes.lastUsedAt,
          group_ids: changes.groupIds === undefined ? undefined : json(changes.groupIds),
          grouping: changes.grouping,
          epoch: changes.epoch,
          attempts: changes.attempts,
          next_attempt_at: changes.nextAttemptAt,
          claim_token: changes.claimToken,
          lease_until: changes.leaseUntil,
          last_error: changes.lastError,
        }),
      list: async (projectId, limit) =>
        sql.all<TagRow>("SELECT * FROM tags WHERE project_id = ? ORDER BY last_used_at DESC, seq DESC LIMIT ?", [projectId, limit]).map(tag),
      due: async (now, limit) =>
        sql
          .all<TagRow>("SELECT * FROM tags WHERE grouping = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, seq LIMIT ?", [now, limit])
          .map(tag),
      dueInProject: async (projectId, now, limit) =>
        sql
          .all<TagRow>(
            "SELECT * FROM tags WHERE project_id = ? AND grouping = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, seq LIMIT ?",
            [projectId, now, limit],
          )
          .map(tag),
      inState: async (projectId, grouping, limit) =>
        sql.all<TagRow>("SELECT * FROM tags WHERE project_id = ? AND grouping = ? ORDER BY seq LIMIT ?", [projectId, grouping, limit]).map(tag),
    },

    tagGroups: {
      get: async (id) => {
        const row = sql.get<TagGroupRow>("SELECT * FROM tag_groups WHERE id = ?", [id]);
        return row === undefined ? null : tagGroup(row);
      },
      byName: async (projectId, nameKey) => {
        const row = sql.get<TagGroupRow>("SELECT * FROM tag_groups WHERE project_id = ? AND name_key = ?", [projectId, nameKey]);
        return row === undefined ? null : tagGroup(row);
      },
      list: async (projectId, limit) =>
        sql.all<TagGroupRow>("SELECT * FROM tag_groups WHERE project_id = ? ORDER BY name_key LIMIT ?", [projectId, limit]).map(tagGroup),
      insert: async (record) => {
        const id = newId("tagGroups");
        sql.run("INSERT INTO tag_groups (id, project_id, name, name_key, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          id,
          record.projectId,
          record.name,
          record.nameKey,
          record.origin,
          record.createdAt,
          record.updatedAt,
        ]);
        return id;
      },
      patch: async (id, changes) => patch("tag_groups", id, { name: changes.name, name_key: changes.nameKey, updated_at: changes.updatedAt }),
      delete: async (id) => sql.run("DELETE FROM tag_groups WHERE id = ?", [id]),
    },

    threadTags: {
      forThread: async (threadId) => sql.all<ThreadTagRow>("SELECT * FROM thread_tags WHERE thread_id = ? ORDER BY seq", [threadId]).map(threadTag),
      insert: async (record) => {
        const id = newId("threadTags");
        sql.run("INSERT INTO thread_tags (id, project_id, thread_id, key) VALUES (?, ?, ?, ?)", [id, record.projectId, record.threadId, record.key]);
        return id;
      },
      delete: async (id) => sql.run("DELETE FROM thread_tags WHERE id = ?", [id]),
      byKey: async (projectId, key, limit) =>
        sql.all<ThreadTagRow>("SELECT * FROM thread_tags WHERE project_id = ? AND key = ? ORDER BY seq DESC LIMIT ?", [projectId, key, limit]).map(threadTag),
    },

    aiSettings: {
      find: async (projectId) => {
        const row = sql.get<AiSettingsRow>("SELECT * FROM ai_settings WHERE project_id = ?", [projectId]);
        return row === undefined ? null : aiSettings(row);
      },
      insert: async (record) => {
        const id = newId("aiSettings");
        sql.run("INSERT INTO ai_settings (id, project_id, enabled, mode, epoch, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          id,
          record.projectId,
          record.enabled ? 1 : 0,
          record.mode,
          record.epoch,
          record.updatedAt,
          record.updatedBy,
        ]);
        update("ai_settings", id, {
          ...connectionColumns(record),
          rule: record.rule,
          allowed_models: record.allowedModels === undefined ? undefined : json(record.allowedModels),
        });
        return id;
      },
      patch: async (id, changes) =>
        update("ai_settings", id, {
          ...connectionColumns(changes),
          updated_by: changes.updatedBy,
          rule: changes.rule,
          allowed_models: changes.allowedModels === undefined ? undefined : changes.allowedModels === null ? null : json(changes.allowedModels),
        }),
    },

    personalAiSettings: {
      find: async (userId) => {
        const row = sql.get<PersonalAiSettingsRow>("SELECT * FROM personal_ai_settings WHERE user_id = ?", [userId]);
        return row === undefined ? null : personalAiSettings(row);
      },
      insert: async (record) => {
        const id = newId("personalAiSettings");
        sql.run("INSERT INTO personal_ai_settings (id, user_id, enabled, mode, epoch, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
          id,
          record.userId,
          record.enabled ? 1 : 0,
          record.mode,
          record.epoch,
          record.updatedAt,
        ]);
        update("personal_ai_settings", id, connectionColumns(record));
        return id;
      },
      patch: async (id, changes) => update("personal_ai_settings", id, connectionColumns(changes)),
      delete: async (id) => sql.run("DELETE FROM personal_ai_settings WHERE id = ?", [id]),
    },

    rateLimits: {
      hit: async (key, limit, windowMs, now) => {
        const row = sql.get<{ count: number; expires_at: number }>("SELECT count, expires_at FROM rate_limits WHERE key = ?", [key]);
        if (row !== undefined && row.expires_at > now && row.count >= limit) return false;
        const next = row === undefined || row.expires_at <= now ? { count: 1, expiresAt: now + windowMs } : { count: row.count + 1, expiresAt: row.expires_at };
        sql.run("INSERT INTO rate_limits (key, count, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at", [
          key,
          next.count,
          next.expiresAt,
        ]);
        sql.run("DELETE FROM rate_limits WHERE expires_at <= ?", [now]);
        return true;
      },
    },

    files: {
      info: async (fileId) => {
        const row = sql.get<{ content_type: string | null; size: number; created_at: number }>(
          "SELECT content_type, size, created_at FROM files WHERE id = ?",
          [fileId],
        );
        return row === undefined
          ? null
          : { ...(row.content_type === null ? {} : { contentType: row.content_type }), size: row.size, createdAt: row.created_at };
      },
      delete: async (fileId) => sql.run("DELETE FROM files WHERE id = ?", [fileId]),
    },
  };
}

interface UserRow {
  seq: number;
  id: string;
  token: string;
  name: string;
  email: string | null;
  image_url: string | null;
  profile_version: number | null;
  plan: string | null;
  home_organization_id: string | null;
  role: string | null;
  team_size: string | null;
}
interface OrganizationRow {
  seq: number;
  id: string;
  name: string;
  created_by: string;
  created_at: number;
  plan: string | null;
  overage_cap: string | null;
  extra_storage_units: number | null;
}
interface MembershipRow {
  seq: number;
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  created_at: number;
}
interface DeveloperSendRow {
  seq: number;
  id: string;
  project_id: string;
  email: string;
  sent_by: string;
  created_at: number;
  reserved_at: number;
  email_number: number;
  attempts: string;
  message: string | null;
}
interface InviteRow {
  seq: number;
  id: string;
  organization_id: string;
  email: string;
  role: string;
  invited_by: string;
  created_at: number;
  accepted_at: number | null;
}
interface ProjectRow {
  seq: number;
  id: string;
  name: string;
  tags: string;
  created_by: string;
  created_at: number;
  review_url: string | null;
  organization_id: string | null;
  onboarding: string | null;
}
interface ParticipantRow {
  seq: number;
  id: string;
  project_id: string;
  user_id: string;
  last_active_at: number;
}
interface PlanAlertRow {
  seq: number;
  id: string;
  organization_id: string;
  kind: string;
  month: string;
  plan: string;
  plan_label: string;
  included: number;
  overage: string | null;
  project_id: string | null;
  status: string;
  attempts: number;
  due_at: number;
  claim_token: string | null;
  lease_until: number | null;
  created_at: number;
  finished_at: number | null;
  reason: string | null;
}
interface DeliveryRow {
  seq: number;
  id: string;
  recipient_id: string;
  project_id: string;
  thread_id: string;
  status: string;
  attempts: number;
  due_at: number;
  claim_token: string | null;
  lease_until: number | null;
  message: string | null;
  created_at: number;
  finished_at: number | null;
  reason: string | null;
  payload: string | null;
}
interface NotificationRow {
  seq: number;
  id: string;
  delivery_id: string;
  recipient_id: string;
  message_id: string;
  author_id: string;
  created_at: number;
  kind: string | null;
}
interface FollowerRow {
  seq: number;
  id: string;
  thread_id: string;
  user_id: string;
  since: number;
}
interface ReplyEmailJobRow {
  seq: number;
  id: string;
  project_id: string;
  thread_id: string;
  message_id: string;
  author_id: string;
  created_at: number;
  position: number;
  stage: string;
  cursor: string | null;
}
interface PreferenceRow {
  seq: number;
  id: string;
  user_id: string;
  mention_emails: number;
  muted_projects: string;
  reply_emails: number | null;
}
interface ThreadRow {
  seq: number;
  id: string;
  project_id: string;
  status: string;
  anchor: string;
  tags: string;
  capture: string;
  capture_file: string | null;
  created_by: string;
  created_at: number;
  last_message_at: number;
  message_count: number;
  edit_count: number;
  status_changed_by: string | null;
  status_changed_at: number | null;
  reattachment: string | null;
  text_tags: string | null;
  followers_ready: number | null;
}
interface TagRow {
  seq: number;
  id: string;
  project_id: string;
  key: string;
  label: string;
  first_used_at: number;
  last_used_at: number;
  group_ids: string;
  grouping: string;
  epoch: number;
  attempts: number;
  next_attempt_at: number;
  claim_token: string | null;
  lease_until: number | null;
  last_error: string | null;
}
interface TagGroupRow {
  seq: number;
  id: string;
  project_id: string;
  name: string;
  name_key: string;
  origin: string;
  created_at: number;
  updated_at: number;
}
interface ThreadTagRow {
  seq: number;
  id: string;
  project_id: string;
  thread_id: string;
  key: string;
}
interface ConnectionRow {
  seq: number;
  id: string;
  enabled: number;
  mode: string;
  managed_model: string | null;
  provider: string | null;
  model: string | null;
  models: string | null;
  base_url: string | null;
  secret: string | null;
  epoch: number;
  updated_at: number;
  last_test: string | null;
}
interface AiSettingsRow extends ConnectionRow {
  project_id: string;
  updated_by: string;
  rule: string | null;
  allowed_models: string | null;
}
interface PersonalAiSettingsRow extends ConnectionRow {
  user_id: string;
}
interface MessageRow {
  seq: number;
  id: string;
  thread_id: string;
  author_id: string;
  body: string;
  created_at: number;
  edited_at: number | null;
  revision: string | null;
  mentions: string | null;
  project_id: string | null;
  hashtags: string | null;
  via: string | null;
}
interface ReactionRow {
  seq: number;
  id: string;
  thread_id: string;
  message_id: string;
  user_id: string;
  emoji: string;
}
interface ReadStateRow {
  seq: number;
  id: string;
  user_id: string;
  thread_id: string;
  last_read_at: number;
  manual_unread: number;
}
