/**
 * The few calls Critiqs needs from a SQLite library, so the same store works
 * with Bun's built-in SQLite, Node's `node:sqlite`, or better-sqlite3.
 */
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): void;
  get<T>(sql: string, params?: SqlValue[]): T | undefined;
  all<T>(sql: string, params?: SqlValue[]): T[];
}

export type SqlValue = string | number | bigint | null | Uint8Array;

/** A driver over Bun's `bun:sqlite` Database. */
export function bunDriver(db: {
  exec(sql: string): unknown;
  query(sql: string): { run(...params: SqlValue[]): unknown; get(...params: SqlValue[]): unknown; all(...params: SqlValue[]): unknown[] };
}): SqlDriver {
  return {
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => void db.query(sql).run(...params),
    get: <T>(sql: string, params: SqlValue[] = []) => (db.query(sql).get(...params) ?? undefined) as T | undefined,
    all: <T>(sql: string, params: SqlValue[] = []) => db.query(sql).all(...params) as T[],
  };
}

/** A driver over Node's `node:sqlite` DatabaseSync, or better-sqlite3, which share `prepare`. */
export function preparedDriver(db: {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...params: SqlValue[]): unknown; get(...params: SqlValue[]): unknown; all(...params: SqlValue[]): unknown[] };
}): SqlDriver {
  return {
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => void db.prepare(sql).run(...params),
    get: <T>(sql: string, params: SqlValue[] = []) => (db.prepare(sql).get(...params) ?? undefined) as T | undefined,
    all: <T>(sql: string, params: SqlValue[] = []) => db.prepare(sql).all(...params) as T[],
  };
}
