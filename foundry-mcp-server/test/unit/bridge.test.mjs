import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal Foundry globals so the module can run under node.
const hooks = {};
const emitted = [];
const listeners = {};
const users = new Map([['gm1', { isGM: true }], ['p1', { isGM: false }]]);

globalThis.Hooks = { once: (name, fn) => { hooks[name] = fn; } };
globalThis.foundry = { utils: { randomID: () => 'TAB0000000000000', getDocumentClass: () => ({ createDocuments: async (arr) => arr.map((a) => ({ toObject: () => a })) }) } };
globalThis.game = {
  user: { isGM: true, id: 'me', name: 'Friend Computer', role: 3 },
  users: { get: (id) => users.get(id) },
  world: { id: 'w1', title: 'World' },
  system: { id: 'sys', version: '1' },
  version: '13.351',
  ready: true,
  socket: {
    on: (ch, fn) => { listeners[ch] = fn; },
    emit: (...args) => emitted.push(args),
  },
};

await import('../../../foundry-mcp-module/scripts/mcp-bridge.mjs');
hooks.ready();
const CH = 'module.foundry-mcp-bridge';
const flush = () => new Promise((r) => setImmediate(r));

test('sets the dispatch API for GMs', async () => {
  const b = globalThis.foundryMcpBridge;
  assert.equal(b.version, '2.0.0');
  assert.equal(b.tabId, 'TAB0000000000000');
  const info = await b.dispatch('info', {});
  assert.equal(info.worldId, 'w1');
  assert.equal(info.tabId, b.tabId);
  assert.equal(info.bridgeVersion, '2.0.0');
  assert.deepEqual(await b.dispatch('exec', { script: 'return 1 + await Promise.resolve(1)' }), 2);
  assert.equal(await b.dispatch('exec', { script: 'return undefined' }), null);
  await assert.rejects(b.dispatch('nope', {}), /Unknown op/);
  await assert.rejects(b.dispatch('toString', {}), /Unknown op/);
  const created = await b.dispatch('create', { type: 'Actor', data: { name: 'A' } });
  assert.deepEqual(created, { documents: [{ name: 'A' }] });
});

test('non-GM senders are ignored entirely', async () => {
  emitted.length = 0;
  await listeners[CH]({ type: 'discover', requestId: 'r1' }, 'p1');
  await listeners[CH]({ type: 'call', requestId: 'r2', executor: 'TAB0000000000000', op: 'exec', args: { script: 'return 1' } }, 'p1');
  await flush();
  assert.equal(emitted.length, 0);
});

test('discover replies only to the requester', async () => {
  emitted.length = 0;
  await listeners[CH]({ type: 'discover', requestId: 'r3' }, 'gm1');
  assert.equal(emitted.length, 1);
  const [channel, payload, opts] = emitted[0];
  assert.equal(channel, CH);
  assert.deepEqual(opts, { recipients: ['gm1'] });
  assert.equal(payload.type, 'discover-reply');
  assert.equal(payload.tabId, 'TAB0000000000000');
  assert.equal(payload.worldId, 'w1');
});

test('call runs only when executor matches this tab', async () => {
  emitted.length = 0;
  await listeners[CH]({ type: 'call', requestId: 'r4', executor: 'OTHER', op: 'exec', args: { script: 'return 1' } }, 'gm1');
  assert.equal(emitted.length, 0);
  await listeners[CH]({ type: 'call', requestId: 'r5', executor: 'TAB0000000000000', op: 'exec', args: { script: 'return 7' } }, 'gm1');
  assert.deepEqual(emitted[0][1], { type: 'result', requestId: 'r5', tabId: 'TAB0000000000000', success: true, result: 7 });
  assert.deepEqual(emitted[0][2], { recipients: ['gm1'] });
  await listeners[CH]({ type: 'call', requestId: 'r6', executor: 'TAB0000000000000', op: 'exec', args: { script: 'throw new Error("bad")' } }, 'gm1');
  assert.equal(emitted[1][1].success, false);
  assert.equal(emitted[1][1].error, 'bad');
});

test('legacy exec-js is logged and not executed', async () => {
  emitted.length = 0;
  globalThis.__ran = false;
  await listeners[CH]({ type: 'exec-js', requestId: 'r7', script: 'globalThis.__ran = true' }, 'gm1');
  assert.equal(globalThis.__ran, false);
  assert.equal(emitted.length, 0);
});
