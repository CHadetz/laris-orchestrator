import { config } from './config.js';
import { addCost, getTicket } from './state.js';

export class BudgetExceededError extends Error {
  readonly spent: number;
  readonly cap: number;
  constructor(spent: number, cap: number) {
    super(`budget exceeded: spent $${spent.toFixed(4)} of $${cap.toFixed(2)} cap`);
    this.name = 'BudgetExceededError';
    this.spent = spent;
    this.cap = cap;
  }
}

/**
 * Throw BudgetExceededError if the ticket has already crossed the per-ticket
 * cap. No-op when MAX_COST_USD_PER_TICKET is 0 (unset).
 *
 * Call this BEFORE spawning a subagent so we don't pay for a run we're about
 * to discard. Note: this is a coarse pre-spawn check; the spawned subagent
 * itself can still exceed the cap by however much one call costs.
 */
export function assertBudget(issueId: string): void {
  if (!config.MAX_COST_USD_PER_TICKET) return;
  const ticket = getTicket(issueId);
  const spent = ticket?.total_cost_usd ?? 0;
  if (spent >= config.MAX_COST_USD_PER_TICKET) {
    throw new BudgetExceededError(spent, config.MAX_COST_USD_PER_TICKET);
  }
}

/** Add cost to the ticket and return the new total. Safe with null/undefined. */
export function recordCost(issueId: string, cost: number | undefined): number {
  if (!cost) return getTicket(issueId)?.total_cost_usd ?? 0;
  return addCost(issueId, cost);
}

/** Format a budget summary suffix for status comments. */
export function budgetNote(issueId: string): string {
  const spent = getTicket(issueId)?.total_cost_usd ?? 0;
  if (!config.MAX_COST_USD_PER_TICKET) {
    return `(cost so far: $${spent.toFixed(4)})`;
  }
  return `(cost: $${spent.toFixed(4)} of $${config.MAX_COST_USD_PER_TICKET.toFixed(2)} cap)`;
}
