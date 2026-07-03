import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { extractSubtasks, inlineSubtaskBlocks, topoSort, type ParsedSubtask } from './subtasks.js';

// ---------- extractSubtasks ----------

describe('extractSubtasks', () => {
  it('returns [] when the plan has no SUBTASK blocks', () => {
    assert.deepEqual(extractSubtasks('# Plan\n\nJust prose, no blocks.'), []);
  });

  it('parses a single block with id, title, model, and depends', () => {
    const plan = `
Some narrative.

<!-- SUBTASK_START id="schema" title="DB tables" model="sonnet" depends="" -->
The body.
**Recommended execution model:** sonnet
<!-- SUBTASK_END -->
`;
    const subs = extractSubtasks(plan);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].id, 'schema');
    assert.equal(subs[0].title, 'DB tables');
    assert.equal(subs[0].model, 'sonnet');
    assert.deepEqual(subs[0].depends, []);
    assert.match(subs[0].body, /\*\*Recommended execution model:\*\* sonnet/);
  });

  it('parses depends as comma-separated, ignoring whitespace', () => {
    const plan = `
<!-- SUBTASK_START id="rest" title="REST" depends="schema, service ,  middleware" -->
body
<!-- SUBTASK_END -->
`;
    const subs = extractSubtasks(plan);
    assert.deepEqual(subs[0].depends, ['schema', 'service', 'middleware']);
  });

  it('treats absent depends attribute as []', () => {
    const plan = `
<!-- SUBTASK_START id="solo" title="Standalone" -->
body
<!-- SUBTASK_END -->
`;
    const subs = extractSubtasks(plan);
    assert.deepEqual(subs[0].depends, []);
  });

  it('treats empty depends="" as []', () => {
    const plan = `
<!-- SUBTASK_START id="solo" title="Standalone" depends="" -->
body
<!-- SUBTASK_END -->
`;
    const subs = extractSubtasks(plan);
    assert.deepEqual(subs[0].depends, []);
  });

  it('synthesizes "sub-N" ids when the planner omits id, in declaration order', () => {
    const plan = `
<!-- SUBTASK_START title="One" -->
body
<!-- SUBTASK_END -->

<!-- SUBTASK_START title="Two" -->
body
<!-- SUBTASK_END -->
`;
    const subs = extractSubtasks(plan);
    assert.deepEqual(subs.map((s) => s.id), ['sub-1', 'sub-2']);
  });

  it('parses a chain of three blocks declaring single-parent deps', () => {
    const plan = `
<!-- SUBTASK_START id="schema" title="Schema" -->
body
<!-- SUBTASK_END -->

<!-- SUBTASK_START id="service" title="Service" depends="schema" -->
body
<!-- SUBTASK_END -->

<!-- SUBTASK_START id="rest" title="REST" depends="service" -->
body
<!-- SUBTASK_END -->
`;
    const subs = extractSubtasks(plan);
    assert.deepEqual(subs.map((s) => s.id), ['schema', 'service', 'rest']);
    assert.deepEqual(subs.map((s) => s.depends), [[], ['schema'], ['service']]);
  });

  it('skips blocks missing the required title attribute', () => {
    const plan = `
<!-- SUBTASK_START id="bad" depends="other" -->
body
<!-- SUBTASK_END -->

<!-- SUBTASK_START id="good" title="Good" -->
body
<!-- SUBTASK_END -->
`;
    const subs = extractSubtasks(plan);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].id, 'good');
  });

  it('back-compat: legacy block (title + model only, no id/depends) still parses', () => {
    const plan = `
<!-- SUBTASK_START title="Legacy" model="opus" -->
body
<!-- SUBTASK_END -->
`;
    const subs = extractSubtasks(plan);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].title, 'Legacy');
    assert.equal(subs[0].model, 'opus');
    assert.equal(subs[0].id, 'sub-1');
    assert.deepEqual(subs[0].depends, []);
  });

  it('attribute order does not matter', () => {
    const plan = `
<!-- SUBTASK_START depends="a,b" model="haiku" title="Reorder" id="z" -->
body
<!-- SUBTASK_END -->
`;
    const subs = extractSubtasks(plan);
    assert.equal(subs[0].id, 'z');
    assert.equal(subs[0].title, 'Reorder');
    assert.equal(subs[0].model, 'haiku');
    assert.deepEqual(subs[0].depends, ['a', 'b']);
  });
});

// ---------- inlineSubtaskBlocks ----------

describe('inlineSubtaskBlocks', () => {
  it('returns text unchanged when there are no blocks', () => {
    const input = '# Plan\n\nJust prose.';
    assert.equal(inlineSubtaskBlocks(input), input);
  });

  it('strips a single block\'s markers and preserves its body', () => {
    const plan = `# Plan

<!-- SUBTASK_START id="schema" title="Schema" -->
## Schema
Create the tables.
<!-- SUBTASK_END -->

After.`;
    const out = inlineSubtaskBlocks(plan);
    assert.match(out, /## Schema/);
    assert.match(out, /Create the tables\./);
    assert.doesNotMatch(out, /SUBTASK_START/);
    assert.doesNotMatch(out, /SUBTASK_END/);
  });

  it('inlines multiple blocks in order', () => {
    const plan = `<!-- SUBTASK_START id="a" title="A" -->
Body A
<!-- SUBTASK_END -->

<!-- SUBTASK_START id="b" title="B" depends="a" -->
Body B
<!-- SUBTASK_END -->`;
    const out = inlineSubtaskBlocks(plan);
    assert.match(out, /Body A/);
    assert.match(out, /Body B/);
    assert.ok(out.indexOf('Body A') < out.indexOf('Body B'));
    assert.doesNotMatch(out, /SUBTASK_/);
  });

  it('does not touch prose outside blocks', () => {
    const plan = `Before block.

<!-- SUBTASK_START id="x" title="X" -->
Inside.
<!-- SUBTASK_END -->

After block.`;
    const out = inlineSubtaskBlocks(plan);
    assert.match(out, /Before block\./);
    assert.match(out, /After block\./);
    assert.match(out, /Inside\./);
  });
});

// ---------- topoSort ----------

function sub(id: string, depends: string[] = []): ParsedSubtask {
  return { id, title: id, body: '', depends };
}

describe('topoSort', () => {
  it('returns a single wave for a flat set of independent subtasks', () => {
    const r = topoSort([sub('a'), sub('b'), sub('c')]);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.order, [['a', 'b', 'c']]);
  });

  it('returns N single-item waves for a linear chain', () => {
    const r = topoSort([
      sub('schema'),
      sub('service', ['schema']),
      sub('rest', ['service']),
      sub('ui', ['rest']),
    ]);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.order, [['schema'], ['service'], ['rest'], ['ui']]);
  });

  it('groups a fan-out diamond: A → {B,C} → D', () => {
    const r = topoSort([
      sub('a'),
      sub('b', ['a']),
      sub('c', ['a']),
      sub('d', ['b', 'c']),
    ]);
    assert.equal(r.error, undefined);
    assert.equal(r.order.length, 3);
    assert.deepEqual(r.order[0], ['a']);
    assert.deepEqual(r.order[1].slice().sort(), ['b', 'c']);
    assert.deepEqual(r.order[2], ['d']);
  });

  it('respects planner declaration order within a wave', () => {
    const r = topoSort([sub('zebra'), sub('apple'), sub('mango')]);
    assert.deepEqual(r.order, [['zebra', 'apple', 'mango']]);
  });

  it('preserves real-world ordering: independent foundation with two parallel consumers', () => {
    const r = topoSort([
      sub('hook'),
      sub('products-page', ['hook']),
      sub('leads-page', ['hook']),
      sub('deals-page', ['hook']),
    ]);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.order[0], ['hook']);
    assert.deepEqual(r.order[1].slice().sort(), ['deals-page', 'leads-page', 'products-page']);
  });

  it('flags an unknown dependency reference', () => {
    const r = topoSort([sub('a'), sub('b', ['ghost'])]);
    assert.equal(r.error, 'unknown_dep');
    assert.deepEqual(r.unknownDep, { from: 'b', to: 'ghost' });
    assert.deepEqual(r.order, []);
  });

  it('detects a direct cycle (A → A)', () => {
    const r = topoSort([sub('a', ['a'])]);
    assert.equal(r.error, 'cycle');
    assert.ok(r.cyclePath && r.cyclePath.includes('a'));
  });

  it('detects an indirect cycle (A → B → A)', () => {
    const r = topoSort([sub('a', ['b']), sub('b', ['a'])]);
    assert.equal(r.error, 'cycle');
    assert.ok(r.cyclePath && r.cyclePath.length >= 3);
    // Cycle path must close on itself.
    assert.equal(r.cyclePath![0], r.cyclePath![r.cyclePath!.length - 1]);
  });

  it('detects a longer indirect cycle (A → B → C → A)', () => {
    const r = topoSort([
      sub('a', ['c']),
      sub('b', ['a']),
      sub('c', ['b']),
    ]);
    assert.equal(r.error, 'cycle');
    assert.ok(r.cyclePath && r.cyclePath.length >= 4);
  });

  it('handles an empty input gracefully', () => {
    const r = topoSort([]);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.order, []);
  });

  it('keeps a single self-described subtask as its own wave', () => {
    const r = topoSort([sub('only')]);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.order, [['only']]);
  });
});
