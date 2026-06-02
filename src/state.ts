import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.DB_PATH), { recursive: true });

export const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    issue_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'planning',
    session_id TEXT,
    last_plan TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

for (const col of [
  'pr_url TEXT',
  'pr_repo TEXT',
  'pr_number INTEGER',
  'executor_session_id TEXT',
  'plan_comment_id TEXT',
]) {
  try {
    db.exec(`ALTER TABLE tickets ADD COLUMN ${col}`);
  } catch (err) {
    if (!/duplicate column name/i.test((err as Error).message)) throw err;
  }
}

db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_pr ON tickets(pr_repo, pr_number)');

export type TicketState = 'planning' | 'executing' | 'done' | 'failed';

export interface TicketRow {
  issue_id: string;
  state: TicketState;
  session_id: string | null;
  last_plan: string | null;
  pr_url: string | null;
  pr_repo: string | null;
  pr_number: number | null;
  executor_session_id: string | null;
  plan_comment_id: string | null;
  created_at: number;
  updated_at: number;
}

export function getTicket(issueId: string): TicketRow | undefined {
  return db.prepare('SELECT * FROM tickets WHERE issue_id = ?').get(issueId) as TicketRow | undefined;
}

export function upsertTicket(issueId: string, state: TicketState) {
  db.prepare(`
    INSERT INTO tickets (issue_id, state) VALUES (?, ?)
    ON CONFLICT(issue_id) DO UPDATE SET state = excluded.state, updated_at = unixepoch()
  `).run(issueId, state);
}

export function claimForExecution(issueId: string): boolean {
  const result = db
    .prepare(
      `UPDATE tickets SET state = 'executing', updated_at = unixepoch()
       WHERE issue_id = ? AND state = 'planning'`,
    )
    .run(issueId);
  return result.changes > 0;
}

export function saveSession(issueId: string, sessionId: string, plan: string) {
  db.prepare(`
    UPDATE tickets
    SET session_id = ?, last_plan = ?, updated_at = unixepoch()
    WHERE issue_id = ?
  `).run(sessionId, plan, issueId);
}

export function saveSessionOnly(issueId: string, sessionId: string) {
  db.prepare(`
    UPDATE tickets
    SET session_id = ?, updated_at = unixepoch()
    WHERE issue_id = ?
  `).run(sessionId, issueId);
}

export function savePlanCommentId(issueId: string, planCommentId: string) {
  db.prepare(`
    UPDATE tickets
    SET plan_comment_id = ?, updated_at = unixepoch()
    WHERE issue_id = ?
  `).run(planCommentId, issueId);
}

export function logEvent(issueId: string, type: string, payload: unknown) {
  db.prepare('INSERT INTO events (issue_id, type, payload) VALUES (?, ?, ?)')
    .run(issueId, type, JSON.stringify(payload));
}

export function savePrInfo(
  issueId: string,
  prUrl: string,
  prRepo: string,
  prNumber: number,
  executorSessionId: string,
) {
  db.prepare(`
    UPDATE tickets
    SET pr_url = ?, pr_repo = ?, pr_number = ?, executor_session_id = ?, updated_at = unixepoch()
    WHERE issue_id = ?
  `).run(prUrl, prRepo, prNumber, executorSessionId, issueId);
}

export function findTicketByPr(prRepo: string, prNumber: number): TicketRow | undefined {
  return db
    .prepare('SELECT * FROM tickets WHERE pr_repo = ? AND pr_number = ?')
    .get(prRepo, prNumber) as TicketRow | undefined;
}
