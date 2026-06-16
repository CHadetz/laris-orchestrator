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
  'total_cost_usd REAL NOT NULL DEFAULT 0',
  'parent_issue_id TEXT',
  'identifier TEXT',
  'title TEXT',
  'base_branch TEXT',
]) {
  try {
    db.exec(`ALTER TABLE tickets ADD COLUMN ${col}`);
  } catch (err) {
    if (!/duplicate column name/i.test((err as Error).message)) throw err;
  }
}

db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_pr ON tickets(pr_repo, pr_number)');

export type TicketState = 'planning' | 'executing' | 'done' | 'failed' | 'split';

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
  total_cost_usd: number;
  parent_issue_id: string | null;
  identifier: string | null;
  title: string | null;
  /** Per-ticket base branch override. Used by B2 child tickets so their PRs
   *  target the parent's feature branch instead of the configured BASE_BRANCH. */
  base_branch: string | null;
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

/** Add the given cost (USD) to the ticket's cumulative spend and return the new
 *  total. If the ticket has a parent (B2 child), the parent's total is bumped
 *  too so the parent ticket always shows the rollup across all its children. */
export function addCost(issueId: string, deltaUsd: number): number {
  if (!deltaUsd || deltaUsd <= 0) {
    const row = db
      .prepare('SELECT total_cost_usd FROM tickets WHERE issue_id = ?')
      .get(issueId) as { total_cost_usd: number } | undefined;
    return row?.total_cost_usd ?? 0;
  }
  const row = db
    .prepare(
      `UPDATE tickets SET total_cost_usd = total_cost_usd + ?, updated_at = unixepoch()
       WHERE issue_id = ?
       RETURNING total_cost_usd, parent_issue_id`,
    )
    .get(deltaUsd, issueId) as
    | { total_cost_usd: number; parent_issue_id: string | null }
    | undefined;
  if (row?.parent_issue_id) {
    db.prepare(
      `UPDATE tickets SET total_cost_usd = total_cost_usd + ?, updated_at = unixepoch()
       WHERE issue_id = ?`,
    ).run(deltaUsd, row.parent_issue_id);
  }
  return row?.total_cost_usd ?? 0;
}

/** List all children of a parent ticket. */
export function listChildren(parentIssueId: string): TicketRow[] {
  return db
    .prepare('SELECT * FROM tickets WHERE parent_issue_id = ?')
    .all(parentIssueId) as TicketRow[];
}

/** Persist just the executor session id mid-stream so a crash doesn't lose it. */
export function setExecutorSessionId(issueId: string, sessionId: string): void {
  db.prepare(`
    UPDATE tickets SET executor_session_id = ?, updated_at = unixepoch()
    WHERE issue_id = ?
  `).run(sessionId, issueId);
}

/** List tickets stuck in 'executing' — used by startup reconciliation. */
export function listExecutingTickets(): TicketRow[] {
  return db.prepare("SELECT * FROM tickets WHERE state = 'executing'").all() as TicketRow[];
}

/** Cache Linear identifier + title on the ticket row so the dashboard can render
 *  without round-tripping Linear. Called from fetchIssueContext side-effect. */
export function cacheTicketMeta(issueId: string, identifier: string, title: string): void {
  db.prepare(`
    INSERT INTO tickets (issue_id, state, identifier, title)
    VALUES (?, 'planning', ?, ?)
    ON CONFLICT(issue_id) DO UPDATE SET
      identifier = excluded.identifier,
      title = excluded.title
  `).run(issueId, identifier, title);
}

/** All tickets, newest-updated first. Used by the dashboard. */
export function listAllTickets(): TicketRow[] {
  return db
    .prepare('SELECT * FROM tickets ORDER BY updated_at DESC')
    .all() as TicketRow[];
}

export interface EventRow {
  id: number;
  issue_id: string;
  type: string;
  payload: string;
  created_at: number;
}

/** Recent events across all tickets. */
export function listRecentEvents(limit = 100): EventRow[] {
  return db
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
    .all(limit) as EventRow[];
}

/** Create a child ticket row (for B2 subtask splitting) with last_plan pre-populated. */
export function createChildTicket(
  childIssueId: string,
  parentIssueId: string,
  lastPlan: string,
  baseBranch: string,
): void {
  db.prepare(
    `INSERT INTO tickets (issue_id, state, last_plan, parent_issue_id, base_branch)
     VALUES (?, 'executing', ?, ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET
       state = 'executing',
       last_plan = excluded.last_plan,
       parent_issue_id = excluded.parent_issue_id,
       base_branch = excluded.base_branch,
       updated_at = unixepoch()`,
  ).run(childIssueId, lastPlan, parentIssueId, baseBranch);
}

/** Persist the parent's chosen feature branch so the rollup comment can mention it. */
export function setBaseBranch(issueId: string, baseBranch: string): void {
  db.prepare(`
    UPDATE tickets SET base_branch = ?, updated_at = unixepoch()
    WHERE issue_id = ?
  `).run(baseBranch, issueId);
}
