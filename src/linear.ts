import { LinearClient } from '@linear/sdk';
import { config } from './config.js';
import { cacheTicketMeta } from './state.js';

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
  teamId: string;
}

export async function fetchIssueContext(issueId: string): Promise<IssueContext> {
  const issue = await linear.issue(issueId);
  const [comments, team] = await Promise.all([issue.comments(), issue.team]);
  const sorted = comments.nodes.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const parts: string[] = [];
  for (const c of sorted) {
    const user = await c.user;
    parts.push(`[${user?.name ?? 'unknown'} @ ${c.createdAt}]\n${c.body}`);
  }

  cacheTicketMeta(issue.id, issue.identifier, issue.title);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    comments: parts.join('\n\n---\n\n'),
    teamId: team?.id ?? '',
  };
}

export interface CreatedChildIssue {
  id: string;
  identifier: string;
}

export async function createChildIssue(opts: {
  teamId: string;
  parentId: string;
  title: string;
  description: string;
}): Promise<CreatedChildIssue | undefined> {
  const payload = await linear.createIssue({
    teamId: opts.teamId,
    parentId: opts.parentId,
    title: opts.title,
    description: opts.description,
  });
  const issue = await payload.issue;
  if (!issue) return undefined;
  return { id: issue.id, identifier: issue.identifier };
}

// Cache state-name → state-id per team. Linear workflow states are team-scoped
// and don't change often; one fetch per team per process is enough.
const stateIdCache = new Map<string, Map<string, string>>();

async function getStateIdForTeam(
  teamId: string,
  stateName: string,
): Promise<string | undefined> {
  let teamStates = stateIdCache.get(teamId);
  if (!teamStates) {
    teamStates = new Map();
    const states = await linear.workflowStates({
      filter: { team: { id: { eq: teamId } } },
    });
    for (const state of states.nodes) {
      teamStates.set(state.name.toLowerCase(), state.id);
    }
    stateIdCache.set(teamId, teamStates);
  }
  return teamStates.get(stateName.toLowerCase());
}

/** Best-effort: set the issue's workflow state. Logs and swallows errors so
 *  state plumbing never blocks the executor. */
export async function setIssueState(issueId: string, stateName: string): Promise<void> {
  try {
    const issue = await linear.issue(issueId);
    const team = await issue.team;
    if (!team) {
      console.warn(`[linear] issue ${issueId} has no team — cannot set state`);
      return;
    }
    const stateId = await getStateIdForTeam(team.id, stateName);
    if (!stateId) {
      console.warn(
        `[linear] team ${team.id} has no workflow state named "${stateName}" — skipping transition for ${issueId}`,
      );
      return;
    }
    await linear.updateIssue(issueId, { stateId });
    console.log(`[linear] ${issueId} → "${stateName}"`);
  } catch (err) {
    console.error(`[linear] failed to set state "${stateName}" on ${issueId}:`, err);
  }
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
