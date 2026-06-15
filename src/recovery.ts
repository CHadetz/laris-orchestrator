import { spawn } from 'node:child_process';
import { budgetNote } from './budget.js';
import { config } from './config.js';
import { fetchIssueContext, postComment } from './linear.js';
import { listExecutingTickets, savePrInfo, upsertTicket, type TicketRow } from './state.js';

/**
 * At startup, look for tickets stuck in 'executing' from a previous worker run
 * and try to reconcile. If we find an open/recent PR on the matching
 * `agent/<identifier>` branch, mark the ticket done and post a recovery
 * comment on Linear. Tickets we can't match are left alone for manual review.
 *
 * Pairs with the mid-stream session-id persistence in runSubagent — if the
 * crash happened after the session_id was emitted, executor_session_id is
 * already saved, so PR-comment follow-ups will still work.
 */
export async function reconcileOrphanedExecutors(): Promise<void> {
  const orphans = listExecutingTickets();
  if (orphans.length === 0) {
    return;
  }
  console.log(`[recover] checking ${orphans.length} orphan ticket(s) stuck in 'executing'`);
  for (const ticket of orphans) {
    try {
      await reconcileOne(ticket);
    } catch (err) {
      console.error(`[recover] ${ticket.issue_id}: ${(err as Error).message}`);
    }
  }
}

async function reconcileOne(ticket: TicketRow): Promise<void> {
  const ctx = await fetchIssueContext(ticket.issue_id);
  const branch = `agent/${ctx.identifier.toLowerCase()}`;
  const prs = await listPrsForBranch(branch);

  if (prs.length === 0) {
    console.log(`[recover] ${ctx.identifier}: no PR found for branch ${branch}, leaving as 'executing' for manual review`);
    return;
  }

  // Prefer the most recently opened PR — there shouldn't be more than one per branch.
  const pr = prs.sort((a, b) => b.number - a.number)[0];
  const prRef = parsePrUrl(pr.url);
  if (!prRef) {
    console.warn(`[recover] ${ctx.identifier}: PR URL ${pr.url} could not be parsed`);
    return;
  }

  // Preserve any executor_session_id that mid-stream persistence already saved.
  // savePrInfo overwrites it, so use the existing one or empty string.
  const sessionId = ticket.executor_session_id ?? '';
  savePrInfo(ticket.issue_id, pr.url, prRef.repo, prRef.number, sessionId);
  upsertTicket(ticket.issue_id, 'done');

  const sessionNote = ticket.executor_session_id
    ? ''
    : '\n\n_Note: the executor session id was lost in the restart — PR-comment follow-ups won\'t resume the original context. Open a new Linear ticket if you need agent edits on this PR._';

  await postComment(
    ticket.issue_id,
    `Execution recovered after worker restart. PR opened: ${pr.url}\n\n${budgetNote(ticket.issue_id)}${sessionNote}`,
  );
  console.log(`[recover] ${ctx.identifier}: reconciled to 'done' with PR ${pr.url}`);
}

interface GhPrSummary {
  number: number;
  url: string;
  state: string;
}

function listPrsForBranch(branch: string): Promise<GhPrSummary[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '5', '--json', 'number,url,state'],
      {
        cwd: config.REPO_PATH,
        env: {
          ...process.env,
          ...(config.GITHUB_TOKEN
            ? { GITHUB_TOKEN: config.GITHUB_TOKEN, GH_TOKEN: config.GITHUB_TOKEN }
            : {}),
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`gh pr list exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as GhPrSummary[]);
      } catch (e) {
        reject(new Error(`failed to parse gh pr list output: ${e}\nstdout:\n${stdout}`));
      }
    });
    child.on('error', reject);
  });
}

function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { repo: m[1], number: parseInt(m[2], 10) };
}
