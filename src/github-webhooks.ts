import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { dispatchFollowup, type FollowupSource } from './executor.js';
import { getBotGithubLogin } from './github.js';
import { findTicketByPr, logEvent } from './state.js';

export function verifyGithubSignature(req: Request, res: Response, next: NextFunction) {
  if (!config.GITHUB_WEBHOOK_SECRET) {
    console.warn('[github-webhook] rejected: GITHUB_WEBHOOK_SECRET not configured');
    res.status(503).send('github webhook not configured');
    return;
  }

  const signature = req.header('x-hub-signature-256');
  if (!signature || !signature.startsWith('sha256=')) {
    console.warn('[github-webhook] rejected: missing or malformed signature header');
    res.status(401).send('missing signature');
    return;
  }

  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    console.warn('[github-webhook] rejected: raw body missing');
    res.status(500).send('raw body missing');
    return;
  }

  const expected = createHmac('sha256', config.GITHUB_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const sigBuf = Buffer.from(signature.slice('sha256='.length), 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    console.warn('[github-webhook] rejected: signature mismatch');
    res.status(401).send('invalid signature');
    return;
  }

  next();
}

interface IssueCommentEvent {
  action: string;
  comment?: { body?: string; user?: { login?: string } };
  issue?: { number?: number; pull_request?: unknown };
  repository?: { full_name?: string };
}

interface PullRequestReviewCommentEvent {
  action: string;
  comment?: {
    id?: number;
    body?: string;
    path?: string;
    line?: number | null;
    original_line?: number | null;
    diff_hunk?: string;
    user?: { login?: string };
  };
  pull_request?: { number?: number };
  repository?: { full_name?: string };
}

interface PullRequestReviewEvent {
  action: string;
  review?: {
    body?: string | null;
    state?: string;
    user?: { login?: string };
  };
  pull_request?: { number?: number };
  repository?: { full_name?: string };
}

interface CheckRunEvent {
  action: string;
  check_run?: {
    name?: string;
    conclusion?: string;
    html_url?: string;
    details_url?: string;
    output?: { title?: string; summary?: string; text?: string };
    pull_requests?: Array<{ number?: number }>;
  };
  repository?: { full_name?: string };
}

export function handleGithubWebhook(req: Request, res: Response) {
  res.status(200).send('ok');
  try {
    const event = req.header('x-github-event');
    switch (event) {
      case 'issue_comment':
        void routeIssueComment(req.body as IssueCommentEvent).catch((err) => {
          console.error('[github-webhook] issue_comment handler error', err);
        });
        return;
      case 'pull_request_review_comment':
        void routeReviewComment(req.body as PullRequestReviewCommentEvent).catch((err) => {
          console.error('[github-webhook] review_comment handler error', err);
        });
        return;
      case 'pull_request_review':
        void routeReview(req.body as PullRequestReviewEvent).catch((err) => {
          console.error('[github-webhook] review handler error', err);
        });
        return;
      case 'check_run':
        void routeCheckRun(req.body as CheckRunEvent).catch((err) => {
          console.error('[github-webhook] check_run handler error', err);
        });
        return;
      default:
        return;
    }
  } catch (err) {
    console.error('[github-webhook] handler error', err);
  }
}

async function dispatchForPr(
  repo: string,
  prNumber: number,
  source: FollowupSource,
  eventLabel: string,
): Promise<void> {
  const ticket = findTicketByPr(repo, prNumber);
  if (!ticket) {
    console.log(`[github-webhook] no ticket for ${repo}#${prNumber}, ignoring ${eventLabel}`);
    return;
  }
  console.log(`[github-webhook] ${eventLabel} on ${repo}#${prNumber} → ticket ${ticket.issue_id}`);
  logEvent(ticket.issue_id, eventLabel, { repo, prNumber, source });
  try {
    await dispatchFollowup(ticket.issue_id, source);
  } catch (err) {
    console.error(`[github-webhook] followup dispatch failed for ${ticket.issue_id}:`, err);
  }
}

async function routeIssueComment(payload: IssueCommentEvent): Promise<void> {
  if (payload.action !== 'created') return;
  if (!payload.issue?.pull_request) return; // regular issue comment, not PR

  const repo = payload.repository?.full_name;
  const prNumber = payload.issue.number;
  const commenter = payload.comment?.user?.login;
  const body = payload.comment?.body;
  if (!repo || !prNumber || !commenter || !body) return;

  const botLogin = await getBotGithubLogin();
  if (botLogin && commenter === botLogin) {
    console.log(`[github-webhook] skip self-comment by ${commenter}`);
    return;
  }

  await dispatchForPr(repo, prNumber, { kind: 'pr_comment', commenter, body }, 'pr_comment');
}

async function routeReviewComment(payload: PullRequestReviewCommentEvent): Promise<void> {
  if (payload.action !== 'created') return;
  const repo = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  const commenter = payload.comment?.user?.login;
  const body = payload.comment?.body;
  const commentId = payload.comment?.id;
  const filePath = payload.comment?.path;
  if (!repo || !prNumber || !commenter || !body || !commentId || !filePath) return;

  const botLogin = await getBotGithubLogin();
  if (botLogin && commenter === botLogin) {
    console.log(`[github-webhook] skip self review-comment by ${commenter}`);
    return;
  }

  await dispatchForPr(
    repo,
    prNumber,
    {
      kind: 'review_comment',
      commenter,
      body,
      filePath,
      line: payload.comment?.line ?? payload.comment?.original_line ?? undefined,
      diffHunk: payload.comment?.diff_hunk,
      commentId,
    },
    'review_comment',
  );
}

async function routeReview(payload: PullRequestReviewEvent): Promise<void> {
  if (payload.action !== 'submitted') return;
  const state = payload.review?.state;
  // Skip plain approvals — no work to do — and skip dismissals.
  if (state !== 'changes_requested' && state !== 'commented') return;

  const repo = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  const commenter = payload.review?.user?.login;
  const body = payload.review?.body;
  if (!repo || !prNumber || !commenter) return;
  // Empty body on `commented` review usually means it's just a wrapper for line
  // comments — those arrive as separate review_comment events. Skip the empty
  // wrapper to avoid spamming a no-op subagent run.
  if (!body || !body.trim()) {
    console.log(`[github-webhook] review on ${repo}#${prNumber} has empty body, skipping (line comments handled separately)`);
    return;
  }

  const botLogin = await getBotGithubLogin();
  if (botLogin && commenter === botLogin) {
    console.log(`[github-webhook] skip self review by ${commenter}`);
    return;
  }

  await dispatchForPr(repo, prNumber, { kind: 'review', commenter, body, state }, 'review');
}

async function routeCheckRun(payload: CheckRunEvent): Promise<void> {
  if (payload.action !== 'completed') return;
  const conclusion = payload.check_run?.conclusion;
  // Only react to failures — success / skipped / neutral are noise.
  if (conclusion !== 'failure' && conclusion !== 'timed_out') return;

  const repo = payload.repository?.full_name;
  const prs = payload.check_run?.pull_requests ?? [];
  const checkName = payload.check_run?.name;
  if (!repo || !checkName || prs.length === 0) {
    if (prs.length === 0) {
      console.log(`[github-webhook] check_run ${checkName} on ${repo} not attached to any PR, ignoring`);
    }
    return;
  }

  // Aggregate output text we have on hand; subagent can dig deeper via `gh run view`.
  const out = payload.check_run?.output;
  const output = [out?.title, out?.summary, out?.text].filter(Boolean).join('\n\n').trim();

  for (const pr of prs) {
    const prNumber = pr.number;
    if (!prNumber) continue;
    await dispatchForPr(
      repo,
      prNumber,
      {
        kind: 'ci_failure',
        checkName,
        conclusion,
        output: output || '(no output captured in webhook payload)',
        detailsUrl: payload.check_run?.html_url ?? payload.check_run?.details_url,
      },
      `check_run:${checkName}`,
    );
  }
}
