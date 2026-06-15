import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { dispatchExecution } from './executor.js';
import { getBotUserId, setIssueState } from './linear.js';
import { scheduleOrchestrator } from './orchestrator.js';
import { claimForExecution, logEvent } from './state.js';

export function verifyLinearSignature(req: Request, res: Response, next: NextFunction) {
  const signature = req.header('linear-signature');
  if (!signature) {
    console.warn('[webhook] rejected: missing linear-signature header');
    res.status(401).send('missing signature');
    return;
  }

  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    console.warn('[webhook] rejected: raw body missing (express middleware misconfigured?)');
    res.status(500).send('raw body missing');
    return;
  }

  const expected = createHmac('sha256', config.LINEAR_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    console.warn('[webhook] rejected: signature mismatch (check LINEAR_WEBHOOK_SECRET)');
    res.status(401).send('invalid signature');
    return;
  }

  next();
}

export async function handleWebhook(req: Request, res: Response) {
  res.status(200).send('ok'); // ack immediately; Linear retries on 5xx
  try {
    const botId = await getBotUserId();
    await routeEvent(req.body, botId);
  } catch (err) {
    console.error('[webhook] handler error', err);
  }
}

interface LinearEvent {
  type?: string;
  action?: string;
  data?: any;
  actor?: { id?: string; name?: string };
}

async function routeEvent(event: LinearEvent, botId: string) {
  const { type, action, data, actor } = event;
  console.log(`[webhook] ${type}/${action} actor=${actor?.name ?? '?'}(${actor?.id ?? '?'}) bot=${botId}`);

  if (actor?.id && actor.id === botId) {
    console.log(`[skip] event from bot itself: ${type}/${action}`);
    return;
  }

  if (type === 'Issue' && action === 'create' && data?.id) {
    console.log(`[issue.create] ${data.identifier} - ${data.title}`);
    logEvent(data.id, 'issue.create', data);
    await scheduleOrchestrator(data.id);
    return;
  }

  if (type === 'Comment' && action === 'create' && data) {
    const issueId = data.issue?.id ?? data.issueId;
    if (!issueId) return;
    const commentId: string | undefined = data.id;
    const incomingParentId: string | undefined = data.parentId ?? data.parent?.id;
    // Reply parent: if user's comment is already inside a thread, continue that thread.
    // Otherwise, start a thread by replying to the user's comment.
    const replyParentId = incomingParentId ?? commentId;
    console.log(`[comment.create] on issue ${issueId} by ${actor?.name ?? 'unknown'} (commentId=${commentId} parentId=${incomingParentId ?? 'none'})`);
    logEvent(issueId, 'comment.create', data);
    await scheduleOrchestrator(issueId, replyParentId ? { replyParentId } : undefined);
    return;
  }

  if (type === 'Issue' && action === 'update' && data?.id) {
    const labels: Array<{ name?: string }> = data.labels ?? [];
    const labelNames = labels.map((l) => l?.name).filter(Boolean);
    const hasApproval = labelNames.includes(config.APPROVAL_LABEL);
    console.log(`[issue.update] ${data.identifier} labels=[${labelNames.join(', ')}] approvalLabel=${config.APPROVAL_LABEL} matched=${hasApproval}`);
    if (hasApproval) {
      if (!claimForExecution(data.id)) {
        console.log(`[approval] ${data.identifier}: not in planning state, skipping`);
        return;
      }
      console.log(`[approval] ${data.identifier}: dispatching execution`);
      logEvent(data.id, 'approval', data);
      // Reflect approval in the Linear workflow state. For tickets that split,
      // children take over the "real" In Progress / In Review transitions —
      // the parent stays in In Progress as a rollup container.
      void setIssueState(data.id, config.IN_PROGRESS_STATE_NAME);
      void dispatchExecution(data.id).catch((err) => {
        console.error(`[approval] dispatch failed for ${data.identifier}:`, err);
      });
    }
    return;
  }

  console.log(`[ignored] ${type}/${action}`);
}
