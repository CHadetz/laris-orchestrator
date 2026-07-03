/**
 * Pure helpers for parsing and ordering subtask blocks. Side-effect-free so
 * unit tests can import this without booting the env validator / DB / Linear
 * client.
 */

export interface ParsedSubtask {
  /** Planner-local id, kebab-case. Synthesized as "sub-N" if the planner omitted it. */
  id: string;
  title: string;
  body: string;
  /** Optional model override from the opening tag's model="..." attribute. */
  model?: string;
  /** Sibling ids this subtask must come after. Empty = independent. */
  depends: string[];
}

const SUBTASK_BLOCK_RE =
  /<!--\s*SUBTASK_START\b([^>]*?)-->\s*\n?([\s\S]*?)\n?\s*<!--\s*SUBTASK_END\s*-->/gi;

/** Remove SUBTASK_START/END markers but keep the body content in place.
 *  Used when SPLIT_STRATEGY=off so a single subagent sees the planner's
 *  per-subtask phase content as plain plan sections. */
export function inlineSubtaskBlocks(text: string): string {
  return text.replace(SUBTASK_BLOCK_RE, (_full, _attrs, body) => String(body).trim());
}

export function extractSubtasks(plan: string): ParsedSubtask[] {
  const out: ParsedSubtask[] = [];
  let synth = 0;
  for (const m of plan.matchAll(SUBTASK_BLOCK_RE)) {
    const attrs = m[1] ?? '';
    const titleMatch = /title\s*=\s*"([^"]+)"/i.exec(attrs);
    const modelMatch = /model\s*=\s*"([^"]+)"/i.exec(attrs);
    const idMatch = /\bid\s*=\s*"([^"]+)"/i.exec(attrs);
    const dependsMatch = /\bdepends\s*=\s*"([^"]*)"/i.exec(attrs);
    if (!titleMatch) {
      // Skip malformed blocks rather than throwing — caller handles the empty case.
      continue;
    }
    const id = idMatch?.[1].trim() || `sub-${++synth}`;
    const depends = dependsMatch
      ? dependsMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    out.push({
      id,
      title: titleMatch[1].trim(),
      body: m[2].trim(),
      ...(modelMatch ? { model: modelMatch[1].trim() } : {}),
      depends,
    });
  }
  return out;
}

export interface TopoResult {
  /** Dispatch waves: each inner array is a set of subtask ids that may run concurrently. */
  order: string[][];
  /** Set when the graph is unbuildable. */
  error?: 'cycle' | 'unknown_dep';
  /** For 'cycle': one cycle path with the start id repeated at the end (e.g. ["a","b","a"]). */
  cyclePath?: string[];
  /** For 'unknown_dep': the offending edge. */
  unknownDep?: { from: string; to: string };
}

export function topoSort(subtasks: ParsedSubtask[]): TopoResult {
  const ids = new Set(subtasks.map((s) => s.id));
  for (const s of subtasks) {
    for (const dep of s.depends) {
      if (!ids.has(dep)) {
        return { order: [], error: 'unknown_dep', unknownDep: { from: s.id, to: dep } };
      }
    }
  }

  const inDegree = new Map<string, number>();
  for (const s of subtasks) inDegree.set(s.id, s.depends.length);
  const dependents = new Map<string, string[]>();
  for (const s of subtasks) {
    for (const dep of s.depends) {
      const list = dependents.get(dep) ?? [];
      list.push(s.id);
      dependents.set(dep, list);
    }
  }

  const order: string[][] = [];
  const remaining = new Set(subtasks.map((s) => s.id));
  while (remaining.size > 0) {
    const wave: string[] = [];
    // Preserve planner declaration order within a wave for stable output.
    for (const s of subtasks) {
      if (remaining.has(s.id) && (inDegree.get(s.id) ?? 0) === 0) wave.push(s.id);
    }
    if (wave.length === 0) {
      return { order: [], error: 'cycle', cyclePath: findCycle(subtasks, remaining) };
    }
    order.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      for (const dep of dependents.get(id) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) - 1);
      }
    }
  }
  return { order };
}

function findCycle(subtasks: ParsedSubtask[], remaining: Set<string>): string[] {
  const depsMap = new Map(subtasks.map((s) => [s.id, s.depends]));
  const start = remaining.values().next().value;
  if (!start) return [];
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();
  function dfs(node: string): string[] | null {
    if (onStack.has(node)) {
      const idx = stack.indexOf(node);
      return idx >= 0 ? [...stack.slice(idx), node] : null;
    }
    if (visited.has(node) || !remaining.has(node)) return null;
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const dep of depsMap.get(node) ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    onStack.delete(node);
    return null;
  }
  return dfs(start) ?? [];
}
