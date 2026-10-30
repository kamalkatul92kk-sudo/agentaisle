// D1-compatible wrapper over sql.js (SQLite compiled to WebAssembly). Used by tests and the Node simulator
// so the exact same SQL that runs on Cloudflare D1 is exercised without wrangler.
import type { Database } from 'sql.js';
import type { D1Like, D1LikeStatement } from './sqlStore';

class Stmt implements D1LikeStatement {
  constructor(private db: Database, private sql: string, private params: unknown[] = []) {}
  bind(...values: unknown[]) { return new Stmt(this.db, this.sql, values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v))); }
  private rows<T>(): T[] {
    const st = this.db.prepare(this.sql);
    try {
      st.bind(this.params as any);
      const out: T[] = [];
      while (st.step()) out.push(st.getAsObject() as T);
      return out;
    } finally { st.free(); }
  }
  async first<T>() { return (this.rows<T>()[0] ?? null) as T | null; }
  async all<T>() { return { results: this.rows<T>() }; }
  async run() { this.db.run(this.sql, this.params as any); return { meta: { changes: this.db.getRowsModified() } }; }
}

export class SqlJsD1 implements D1Like {
  constructor(public db: Database) {}
  prepare(sql: string) { return new Stmt(this.db, sql); }
  async batch(stmts: D1LikeStatement[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
  exec(sql: string) { this.db.exec(sql); }
}

export async function createSqlJsD1(schemaSql: string): Promise<SqlJsD1> {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const d = new SqlJsD1(new SQL.Database());
  d.exec(schemaSql);
  return d;
}
