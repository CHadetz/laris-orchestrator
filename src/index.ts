import path from 'node:path';
import express from 'express';
import { getActivity } from './activity.js';
import { config } from './config.js';
import { buildDashboardState, DASHBOARD_HTML } from './dashboard.js';
import { dispatchExecution } from './executor.js';
import { pathExists, runGit } from './git.js';
import { handleGithubWebhook, verifyGithubSignature } from './github-webhooks.js';
import { fetchIssueContext, getBotUserId } from './linear.js';
import { scheduleOrchestrator } from './orchestrator.js';
import { reconcileOrphanedExecutors } from './recovery.js';
import { getTicket } from './state.js';
import { handleWebhook, verifyLinearSignature } from './webhooks.js';

const app = express();

// Capture raw body on webhook routes so we can HMAC-verify each, then parse JSON.
const rawBodyJsonMiddleware = [
  express.raw({ type: 'application/json', limit: '5mb' }),
  (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const buf = req.body as Buffer;
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
    try {
      req.body = JSON.parse(buf.toString('utf8'));
    } catch {
      // signature verification will fail and reject
    }
    next();
  },
];

app.use('/webhooks/linear', rawBodyJsonMiddleware);
app.use('/webhooks/github', rawBodyJsonMiddleware);

app.get('/health', (_req, res) => {
  res.send('ok');
});

// Dashboard — localhost-only by default. If you expose this via ngrok, add auth.
app.get('/', (_req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});
app.get('/api/state', (_req, res) => {
  res.json(buildDashboardState());
});

// Manual retrigger for processes that didn't finish (worker crashed mid-run,
// got restarted for code changes, etc). No auth — localhost-only by default.
app.post('/api/retry/:issueId', express.json(), async (req, res) => {
  const { issueId } = req.params;
  const kind = (req.query.kind ?? req.body?.kind) as string | undefined;

  const ticket = getTicket(issueId);
  if (!ticket) {
    res.status(404).json({ error: 'no ticket with that issue_id' });
    return;
  }
  if (getActivity(issueId)) {
    res.status(409).json({ error: 'a worker is already running for this ticket' });
    return;
  }

  try {
    if (kind === 'plan') {
      void scheduleOrchestrator(issueId).catch((err) =>
        console.error(`[retry] plan dispatch failed for ${issueId}:`, err),
      );
      res.json({ ok: true, action: 'plan scheduled' });
      return;
    }
    if (kind === 'execute') {
      if (!ticket.last_plan) {
        res.status(400).json({ error: 'no stored plan; re-plan first' });
        return;
      }
      if (ticket.state === 'split') {
        res.status(400).json({ error: "this ticket was split into subtasks; retrigger an individual child instead" });
        return;
      }
      // Best-effort: nuke any leftover worktree AND branch from the prior
      // crashed run so prepareWorktree doesn't refuse with "already exists".
      // The user explicitly asked us to start over, so force-deleting is fine.
      try {
        const ctx = await fetchIssueContext(issueId);
        const worktreePath = path.join(config.WORKTREE_ROOT, ctx.identifier);
        const branch = `agent/${ctx.identifier.toLowerCase()}`;
        if (await pathExists(worktreePath)) {
          try {
            await runGit(['worktree', 'remove', '--force', worktreePath]);
            console.log(`[retry] cleaned up leftover worktree ${worktreePath}`);
          } catch (err) {
            console.warn(`[retry] worktree cleanup failed (continuing): ${(err as Error).message}`);
          }
        }
        try {
          await runGit(['branch', '-D', branch]);
          console.log(`[retry] deleted leftover local branch ${branch}`);
        } catch {
          // Branch didn't exist — that's the expected case on a clean retry.
        }
      } catch (err) {
        console.warn(`[retry] could not pre-clean worktree/branch: ${(err as Error).message}`);
      }
      void dispatchExecution(issueId).catch((err) =>
        console.error(`[retry] execute dispatch failed for ${issueId}:`, err),
      );
      res.json({ ok: true, action: 'execution scheduled' });
      return;
    }
    res.status(400).json({ error: "kind must be 'plan' or 'execute'" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/webhooks/linear', verifyLinearSignature, handleWebhook);
app.post('/webhooks/github', verifyGithubSignature, handleGithubWebhook);

app.listen(config.PORT, async () => {
  console.log(`laris-orchestrator listening on :${config.PORT}`);
  try {
    const botId = await getBotUserId();
    console.log(`linear bot user id: ${botId}`);
  } catch (err) {
    console.error('failed to fetch bot user from Linear:', err);
  }
  try {
    await reconcileOrphanedExecutors();
  } catch (err) {
    console.error('startup reconciliation failed:', err);
  }
});
