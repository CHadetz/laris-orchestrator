/**
 * In-memory registry of currently-running per-ticket workers. Lets the
 * dashboard distinguish "this ticket's persisted state is 'planning'" from
 * "a planner subagent is actively running on this ticket right now".
 *
 * Process death wipes the registry, which is correct: no workers are running
 * after a crash, and startup reconciliation (recovery.ts) handles any rows
 * that were left in 'executing' on disk.
 */

export type ActivityKind = 'planner' | 'executor' | 'followup';

export interface ActivityEntry {
  issueId: string;
  kind: ActivityKind;
  startedAt: number; // unix seconds
  detail?: string;
}

const activities = new Map<string, ActivityEntry>();

/** Register an active worker for a ticket. Returns a cleanup function that
 *  removes the entry — call it in `finally`. Only one entry per ticket; per-
 *  ticket serialization elsewhere (`inFlight` maps) guarantees this is safe. */
function startActivity(
  issueId: string,
  kind: ActivityKind,
  detail?: string,
): () => void {
  const entry: ActivityEntry = {
    issueId,
    kind,
    startedAt: Math.floor(Date.now() / 1000),
    detail,
  };
  activities.set(issueId, entry);
  return () => {
    // Defensive: only delete if it's still us. Lets nested activities (which
    // shouldn't happen, but might during refactors) not stomp each other.
    if (activities.get(issueId) === entry) activities.delete(issueId);
  };
}

/** Run `fn` while marking the ticket as having an active worker of `kind`.
 *  Cleans up automatically on success and on throw. */
export async function withActivity<T>(
  issueId: string,
  kind: ActivityKind,
  fn: () => Promise<T>,
  detail?: string,
): Promise<T> {
  const end = startActivity(issueId, kind, detail);
  try {
    return await fn();
  } finally {
    end();
  }
}

/** Read all currently-running activities. Snapshot, safe to iterate. */
export function listActivities(): ActivityEntry[] {
  return Array.from(activities.values());
}

/** Look up the active worker for a single ticket, if any. */
export function getActivity(issueId: string): ActivityEntry | undefined {
  return activities.get(issueId);
}
