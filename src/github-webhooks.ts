import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { dispatchFollowup } from './executor.js';
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
  comment?: {
    body?: string;
    user?: { login?: string };
  };
  issue?: {
    number?: number;
    pull_request?: unknown;
  };
  repository?: {
    full_name?: string;
  };
}

export function handleGithubWebhook(req: Request, res: Response) {
  res.status(200).send('ok');
  try {
    const event = req.header('x-github-event');
    if (event !== 'issue_comment') {
      return;
    }
    void routeIssueComment(req.body as IssueCommentEvent).catch((err) => {
      console.error('[github-webhook] handler error', err);
    });
  } catch (err) {
    console.error('[github-webhook] handler error', err);
  }
}

async function routeIssueComment(payload: IssueCommentEvent): Promise<void> {
  if (payload.action !== 'created') return;
  if (!payload.issue?.pull_request) {
    // This is a regular issue comment, not a PR comment — ignore.
    return;
  }

  const repo = payload.repository?.full_name;
  const prNumber = payload.issue.number;
  const commenter = payload.comment?.user?.login;
  const body = payload.comment?.body;

  if (!repo || !prNumber || !commenter || !body) {
    console.log(`[github-webhook] issue_comment.created missing fields, skipping`);
    return;
  }

  const botLogin = await getBotGithubLogin();
  if (botLogin && commenter === botLogin) {
    console.log(`[github-webhook] skip self-comment by ${commenter}`);
    return;
  }

  const ticket = findTicketByPr(repo, prNumber);
  if (!ticket) {
    console.log(`[github-webhook] no ticket for ${repo}#${prNumber}, ignoring`);
    return;
  }

  console.log(`[github-webhook] PR comment ${repo}#${prNumber} by ${commenter} → ticket ${ticket.issue_id}`);
  logEvent(ticket.issue_id, 'pr_comment', { repo, prNumber, commenter, body });
  void dispatchFollowup(ticket.issue_id, commenter, body).catch((err) => {
    console.error(`[github-webhook] followup dispatch failed for ${ticket.issue_id}:`, err);
  });
}
