import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcp } from '../src/mcp.mjs';

test('MCP rejects unknown fields before forwarding and wait step schema matches runtime', async t => {
  const calls = [];
  const server = createMcp({ call: async (method, args) => {
    calls.push({ method, args });
    return method === 'screenshot' ? { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', capture: {} } : { ok: true };
  } });
  const client = new Client({ name: 'contract', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  const waitStep = tools.find(tool => tool.name === 'browser_batch').inputSchema.properties.steps.items.oneOf.find(branch => branch.properties.action.const === 'wait');
  assert.equal(waitStep.properties.wait_for, undefined);
  for (const [name, args, path] of [
    ['click', { x: 20, y: 30, observation: {} }, 'observation'],
    ['click', { x: 20, y: 30, expected_target: { selector: '#go', typo: true } }, 'typo'],
    ['wait', { condition: 'url', expected: '/', wait_for: {} }, 'wait_for'],
    ['click', { selector: '#go', wait_for: { checks: [{ condition: 'url', expected: '/', timeout_ms: 100 }] } }, 'timeout_ms'],
    ['batch', { steps: [{ action: 'wait', condition: 'url', expected: '/', wait_for: { checks: [{ condition: 'url', expected: '/' }] } }] }, 'wait_for'],
  ]) {
    const result = await client.callTool({ name: `browser_${name}`, arguments: { tab_handle: 'test', ...args } });
    assert.equal(result.isError, true); assert.match(result.content[0].text, new RegExp(path));
    assert.equal(calls.length, 0);
  }
  const call = (name, args) => client.callTool({ name: `browser_${name}`, arguments: { tab_handle: 'test', ...args } });
  for (const name of ['click', 'read_text', 'wait', 'read_control', 'screenshot']) {
    assert.ok(!(await call(name, { selector: '¥45', selector_type: 'text', scope: '#plans', text_match: 'contains', ...(name === 'wait' ? { condition: 'visible' } : {}) })).isError);
    assert.equal(calls.at(-1).args.scope, '#plans');
  }
  assert.ok(!(await call('click', { x: 25, y: 35, coordinate_space: 'image', screenshot_id: 'capture', expected_target: { selector: '¥45', selector_type: 'text', scope: '#plans' } })).isError);
  assert.equal(calls.at(-1).args.expected_target.scope, '#plans');
  for (const args of [{ selector: '#go', text_match: 'exact' }, { x: 20, y: 30, coordinate_space: 'image' }, { selector: '#go', expected_target: { selector: '#go' } }]) {
    const before = calls.length;
    assert.equal((await call('click', args)).isError, true); assert.equal(calls.length, before);
  }
  assert.ok(!(await call('read_control', { ref: 'blocker', view: 'context', max_nodes: 10 })).isError);
  assert.equal(calls.at(-1).args.max_options, undefined);
  for (const args of [{ selector:'#overlay',view:'context',max_options:3 }, { selector:'#overlay',view:'context',popup_selector:'#portal' }, { selector:'#overlay',max_nodes:3 }]) {
    const before=calls.length;
    assert.equal((await call('read_control',args)).isError,true);assert.equal(calls.length,before);
  }
});
