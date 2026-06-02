import { LinearClient } from '@linear/sdk';
import { config } from './config.js';

export const linear = new LinearClient({ apiKey: config.LINEAR_API_KEY });

let cachedViewerId: string | null = null;

export async function getBotUserId(): Promise<string> {
  if (cachedViewerId) return cachedViewerId;
  const viewer = await linear.viewer;
  cachedViewerId = viewer.id;
  return cachedViewerId;
}

export interface IssueContext {
  id: string;
  identifier: string;
  title: string;
  description: string;
  comments: string;
}

export async function fetchIssueContext(issueId: string): Promise<IssueContext> {
  const issue = await linear.issue(issueId);
  const comments = await issue.comments();
  const sorted = comments.nodes.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const parts: string[] = [];
  for (const c of sorted) {
    const user = await c.user;
    parts.push(`[${user?.name ?? 'unknown'} @ ${c.createdAt}]\n${c.body}`);
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    comments: parts.join('\n\n---\n\n'),
  };
}

export async function postComment(
  issueId: string,
  body: string,
  parentId?: string,
): Promise<string | undefined> {
  const payload = await linear.createComment({
    issueId,
    body,
    ...(parentId ? { parentId } : {}),
  });
  const created = await payload.comment;
  return created?.id;
}

export async function updateComment(commentId: string, body: string): Promise<void> {
  await linear.updateComment(commentId, { body });
}
