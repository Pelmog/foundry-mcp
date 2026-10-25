import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, lstat, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { IpcServer } from '../lib/ipc-server.mjs';
import { WorkerState } from '../lib/state.mjs';
import { Supervisor } from '../lib/supervisor.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const identity = { worldId: 'alpha', worldTitle: 'Alpha', systemId: 'paranoia',
  userId: 'u1', userName: 'Friend Computer', tabId: 'tab1' };
const call = (id, extra = {}) => ({ id, op: 'call', args: { op: 'info', args: {} }, ...extra });

async function fixture(t, dispatch = async payload => payload, ready = true, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gm-'));
  const path = join(dir, 'gm.sock');
  const state = new WorkerState();
  const calls = [];
  const page = { async evaluate(fn, payload) {
    assert.match(fn.toString(), /globalThis\.foundryMcpBridge\.dispatch\(op, args\)/);
    calls.push(payload);
    return dispatch(payload);
  } };
  if (ready) state.transition('ready', identity, page);
  const server = new IpcServer({ socketPath: path, state, ...options });
  await server.start();
  const socket = net.createConnection(path);
  await once(socket, 'connect');
  socket.setEncoding('utf8');
  const replies = [];
  const waiting = [];
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
    for (const check of [...waiting]) check();
  });
  const until = predicate => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.splice(waiting.indexOf(check), 1); reject(new Error('Reply timeout')); }, 2000);
    const check = () => {
      const result = predicate();
      if (!result) return;
      clearTimeout(timer);
      const index = waiting.indexOf(check);
      if (index >= 0) waiting.splice(index, 1);
      resolve(result);
    };
    waiting.push(check);
    check();
  });
  t.after(async () => { socket.destroy(); await server.stop(); await rm(dir, { recursive: true, force: true }); });
  return { dir, path, state, page, server, calls, replies, socket, until,
    send: request => socket.write(JSON.stringify(request) + '\n'),
    reply: id => until(() => replies.find(reply => reply.id === id)) };
}

function recoverySupervisor(f, dispatch = async () => 'fresh-page', closing = Promise.resolve()) {
  const gm = {
    page: f.page, closes: 0, joins: 0,
    async closePage() { this.closes++; await closing; this.page = null; },
    async healthy() { return true; },
    async join() {
      this.joins++;
      this.page = { evaluate: async (_fn, payload) => dispatch(payload) };
      return { page: this.page, info: { ...identity, tabId: 'fresh-tab' } };
    }
  };
  const supervisor = new Supervisor({ state: f.state, gm,
    getStatus: async () => ({ active: true, world: 'alpha' }) });
  supervisor.worldId = 'alpha';
  f.server.recoverStuck = target => supervisor.recoverStuck(target);
  return { supervisor, gm };
}

test('never-settling dispatch recovers after grace, advances generation and permits a fresh call', async t => {
  const logs = [];
  const closing = deferred();
  const f = await fixture(t, () => new Promise(() => {}), true, {
    log: (event, fields) => logs.push({ event, ...fields })
  });
  const { supervisor, gm } = recoverySupervisor(f, undefined, closing.promise);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.send(call('stuck', { timeoutMs: 25 }));
  f.send(call('queued'));
  f.send({ id: 'accepted', op: 'status' });
  await f.reply('accepted');
  t.mock.timers.tick(25);
  assert.equal((await f.reply('stuck')).code, 'TIMEOUT');
  t.mock.timers.tick(14999);
  f.send({ id: 'grace', op: 'status' });
  assert.equal((await f.reply('grace')).result.state, 'ready');
  assert.equal(gm.closes, 0);
  const changed = once(f.state, 'change');
  t.mock.timers.tick(1);
  await changed;
  assert.equal(f.state.value.state, 'joining');
  assert.equal(f.state.value.generation, 2);
  assert.equal((await f.reply('queued')).code, 'NOT_READY');
  f.send(call('during-close'));
  assert.equal((await f.reply('during-close')).code, 'NOT_READY');
  const tickWhileClosing = supervisor.tick();
  assert.equal(gm.joins, 0);
  assert.equal(gm.closes, 1);
  closing.resolve();
  await tickWhileClosing;
  await new Promise(setImmediate);
  assert.equal(f.server.active, null);
  await supervisor.tick();
  assert.equal(f.state.value.generation, 2);
  assert.equal(gm.joins, 1);
  f.send(call('next'));
  const next = await f.reply('next');
  assert.equal(next.result, 'fresh-page');
  assert.equal(next.meta.generation, 2);
  assert.equal(next.meta.tabId, 'fresh-tab');
  assert.equal(f.calls.length, 1);
  assert.equal(f.replies.filter(reply => reply.id === 'stuck').length, 1);
  assert.equal(logs.filter(log => log.event === 'dispatch-stuck').length, 1);
  t.mock.timers.reset();
});

test('settlement during a configured grace period cancels recovery', async t => {
  const gate = deferred();
  const logs = [];
  const f = await fixture(t, () => gate.promise, true, {
    stuckGraceMs: 500, log: event => logs.push(event)
  });
  const { gm } = recoverySupervisor(f);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.send(call('late', { timeoutMs: 25 }));
  f.send({ id: 'accepted', op: 'status' });
  await f.reply('accepted');
  t.mock.timers.tick(25);
  assert.equal((await f.reply('late')).code, 'TIMEOUT');
  t.mock.timers.tick(499);
  gate.resolve('settled');
  await new Promise(setImmediate);
  t.mock.timers.tick(1000);
  f.send(call('next'));
  assert.equal((await f.reply('next')).result, 'settled');
  assert.equal(gm.closes, 0);
  assert.equal(gm.joins, 0);
  assert.equal(f.state.value.generation, 1);
  assert.equal(f.state.value.state, 'ready');
  assert.equal(logs.includes('dispatch-stuck'), false);
  assert.equal(f.replies.filter(reply => reply.id === 'late').length, 1);
  t.mock.timers.reset();
});

test('late settlement after recovery cannot release a fresh dispatch slot', async t => {
  const old = deferred();
  const fresh = deferred();
  let freshCalls = 0;
  const f = await fixture(t, () => old.promise, true, { stuckGraceMs: 10 });
  const { supervisor } = recoverySupervisor(f, async () => { freshCalls++; return fresh.promise; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.send(call('old', { timeoutMs: 5 }));
  f.send({ id: 'accepted', op: 'status' });
  await f.reply('accepted');
  t.mock.timers.tick(5);
  assert.equal((await f.reply('old')).code, 'TIMEOUT');
  t.mock.timers.tick(10);
  await new Promise(setImmediate);
  await supervisor.tick();
  f.send(call('fresh-active'));
  f.send(call('fresh-queued'));
  f.send({ id: 'fresh-barrier', op: 'status' });
  await f.reply('fresh-barrier');
  old.resolve('obsolete');
  await new Promise(setImmediate);
  assert.equal(freshCalls, 1);
  fresh.resolve('new');
  assert.equal((await f.reply('fresh-active')).result, 'new');
  assert.equal((await f.reply('fresh-queued')).result, 'new');
  assert.equal(freshCalls, 2);
  assert.equal(f.replies.filter(reply => reply.id === 'old').length, 1);
  t.mock.timers.reset();
});

test('invalid recovery grace configuration is rejected', () => {
  for (const stuckGraceMs of [0, -1, NaN, Infinity, 1.5, 2147483648]) {
    assert.throws(() => new IpcServer({ socketPath: '/unused', state: new WorkerState(), stuckGraceMs }),
      /GM_STUCK_GRACE_MS/);
  }
});

test('ready dispatch and complete metadata; socket mode 0660', async t => {
  const f = await fixture(t, async () => ({ works: true }));
  f.send(call('one', { expectWorld: 'alpha' }));
  assert.deepEqual(await f.reply('one'), { id: 'one', ok: true, result: { works: true },
    meta: { worldId: 'alpha', userId: 'u1', userName: 'Friend Computer', tabId: 'tab1', generation: 1 } });
  assert.equal((await lstat(f.path)).mode & 0o777, 0o660);
});

test('every non-ready state rejects calls but status always answers', async t => {
  const f = await fixture(t, undefined, false);
  for (const state of ['starting', 'no-world', 'joining', 'no-user', 'error']) {
    f.state.transition(state);
    f.send(call(state));
    f.send({ id: `${state}-status`, op: 'status' });
    assert.equal((await f.reply(state)).code, 'NOT_READY');
    const status = await f.reply(`${state}-status`);
    assert.equal(status.result.state, state);
    assert.equal(status.result.generation, 0);
    assert.ok(Number.isFinite(Date.parse(status.result.since)));
  }
  assert.equal(f.calls.length, 0);
});

test('WRONG_WORLD never dispatches', async t => {
  const f = await fixture(t);
  f.send(call('wrong', { expectWorld: 'beta' }));
  assert.equal((await f.reply('wrong')).code, 'WRONG_WORLD');
  assert.equal(f.calls.length, 0);
});

test('page exceptions preserve their message as EXEC_ERROR', async t => {
  const f = await fixture(t, async () => { throw new Error('hook cancelled creation'); });
  f.send(call('error'));
  const reply = await f.reply('error');
  assert.equal(reply.code, 'EXEC_ERROR');
  assert.equal(reply.error, 'hook cancelled creation');
});

test('status bypasses a long call, ids can arrive out of order, calls stay serial', async t => {
  const gate = deferred();
  let count = 0;
  const f = await fixture(t, async () => ++count === 1 ? gate.promise : count);
  f.send(call('z'));
  f.send(call('a'));
  f.send({ id: 'status', op: 'status' });
  assert.equal((await f.reply('status')).result.state, 'ready');
  assert.deepEqual(f.replies.map(r => r.id), ['status']);
  assert.equal(f.calls.length, 1);
  gate.resolve('first');
  assert.equal((await f.reply('z')).result, 'first');
  assert.equal((await f.reply('a')).result, 2);
  assert.deepEqual(f.replies.map(r => r.id), ['status', 'z', 'a']);
});

test('TIMEOUT never retries or overlaps execution; queue timeout never dispatches', async t => {
  const gate = deferred();
  const f = await fixture(t, async () => gate.promise);
  f.send(call('timed', { timeoutMs: 25 }));
  f.send(call('waiting', { timeoutMs: 60 }));
  assert.equal((await f.reply('timed')).code, 'TIMEOUT');
  assert.equal((await f.reply('waiting')).code, 'TIMEOUT');
  assert.equal(f.calls.length, 1);
  f.send(call('later'));
  f.send({ id: 'still-alive', op: 'status' });
  await f.reply('still-alive');
  assert.equal(f.calls.length, 1);
  gate.resolve('late');
  assert.equal((await f.reply('later')).result, 'late');
  assert.equal(f.calls.length, 2);
  assert.equal(f.replies.filter(r => r.id === 'timed').length, 1);
});

for (const [label, timeoutMs, deadline] of [['default', undefined, 30000], ['maximum', 999999, 120000]]) {
  test(`${label} timeout boundary is ${deadline} ms`, async t => {
    const gate = deferred();
    const f = await fixture(t, async () => gate.promise);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.send(call('deadline', timeoutMs === undefined ? {} : { timeoutMs }));
    f.send({ id: 'accepted', op: 'status' });
    await f.reply('accepted');
    t.mock.timers.tick(deadline - 1);
    f.send({ id: 'before-deadline', op: 'status' });
    await f.reply('before-deadline');
    assert.equal(f.replies.some(reply => reply.id === 'deadline'), false);
    t.mock.timers.tick(1);
    assert.equal((await f.reply('deadline')).code, 'TIMEOUT');
    gate.resolve('late');
    t.mock.timers.reset();
  });
}

test('serialization applies across separate connections', async t => {
  const gate = deferred();
  const f = await fixture(t, async () => gate.promise);
  f.send(call('first'));
  f.send({ id: 'barrier', op: 'status' });
  await f.reply('barrier');
  const second = net.createConnection(f.path);
  t.after(() => second.destroy());
  await once(second, 'connect');
  second.write(JSON.stringify(call('second')) + '\n');
  // Status on the second connection proves its earlier call has been admitted.
  const status = once(second, 'data');
  second.write(JSON.stringify({ id: 'status', op: 'status' }) + '\n');
  assert.equal(JSON.parse(String((await status)[0]).trim()).id, 'status');
  assert.equal(f.calls.length, 1);
  const result = once(second, 'data');
  gate.resolve('done');
  assert.equal((await f.reply('first')).ok, true);
  assert.equal(JSON.parse(String((await result)[0]).trim()).id, 'second');
  assert.equal(f.calls.length, 2);
});

test('BUSY at 50 waiting, plus one active; status still bypasses full queue', async t => {
  const gate = deferred();
  const f = await fixture(t, async () => gate.promise);
  for (let i = 0; i < 52; i++) f.send(call(String(i)));
  assert.equal((await f.reply('51')).code, 'BUSY');
  assert.equal(f.server.queue.length, 50);
  assert.equal(f.calls.length, 1);
  f.send({ id: 'status', op: 'status' });
  assert.equal((await f.reply('status')).ok, true);
  gate.resolve('done');
  await f.reply('50');
  assert.deepEqual(f.replies.filter(r => r.ok && r.id !== 'status').map(r => r.id),
    Array.from({ length: 51 }, (_, i) => String(i)));
});

test('malformed JSON and invalid envelopes yield BAD_REQUEST and connection survives', async t => {
  const f = await fixture(t);
  f.socket.write('{bad\n');
  assert.equal((await f.reply(null)).code, 'BAD_REQUEST');
  const invalid = [null, [], { id: 1, op: 'status' }, { id: 'unknown', op: 'no' },
    { id: 'status-args', op: 'status', args: {} }, call('args', { args: [] }),
    call('op', { args: { op: 'wrong', args: {} } }), call('missing', { args: { op: 'info' } }),
    call('zero', { timeoutMs: 0 }), call('negative', { timeoutMs: -1 }),
    call('fraction', { timeoutMs: 1.1 }), call('string', { timeoutMs: '30' }),
    call('world', { expectWorld: 5 })];
  for (const request of invalid) f.send(request);
  f.send({ id: 'valid', op: 'status' });
  await f.reply('valid');
  assert.equal(f.replies.filter(r => r.code === 'BAD_REQUEST').length, invalid.length + 1);
  assert.equal(f.calls.length, 0);
});

test('fragmented and coalesced NDJSON including Unicode ids', async t => {
  const f = await fixture(t);
  f.socket.write('{"id":"日本');
  f.socket.write('","op":"status"}\n{"id":"next","op":"status"}\n');
  assert.equal((await f.reply('日本')).ok, true);
  assert.equal((await f.reply('next')).ok, true);
});

test('generation change fails active and queued calls NOT_READY without replay', async t => {
  const gate = deferred();
  const f = await fixture(t, async () => gate.promise);
  f.send(call('active'));
  f.send(call('queued'));
  f.send({ id: 'barrier', op: 'status' });
  await f.reply('barrier');
  f.state.transition('ready', { ...identity, tabId: 'tab2' }, f.page);
  for (const id of ['active', 'queued']) assert.equal((await f.reply(id)).code, 'NOT_READY');
  assert.equal(f.calls.length, 1);
  gate.resolve('old');
  f.send(call('new'));
  assert.equal((await f.reply('new')).meta.generation, 2);
  assert.equal(f.calls.length, 2);
  assert.equal(f.replies.filter(r => r.id === 'active').length, 1);
});

test('page reload invalidation fails calls immediately', async t => {
  const gate = deferred();
  const f = await fixture(t, async () => gate.promise);
  f.send(call('active'));
  f.send({ id: 'barrier', op: 'status' });
  await f.reply('barrier');
  f.state.transition('joining', { worldId: 'alpha' });
  assert.equal((await f.reply('active')).code, 'NOT_READY');
  gate.resolve();
});

test('graceful stop fails active and queued work, removes socket', async t => {
  const gate = deferred();
  const f = await fixture(t, async () => gate.promise);
  f.send(call('active'));
  f.send(call('queued'));
  f.send({ id: 'barrier', op: 'status' });
  await f.reply('barrier');
  await f.server.stop();
  assert.equal((await f.reply('active')).code, 'NOT_READY');
  assert.equal((await f.reply('queued')).code, 'NOT_READY');
  await assert.rejects(lstat(f.path), { code: 'ENOENT' });
  gate.resolve();
});

test('an active worker socket and ordinary files are never unlinked', async t => {
  const f = await fixture(t);
  const other = new IpcServer({ socketPath: f.path, state: new WorkerState() });
  await assert.rejects(other.start(), /already in use/);
  await other.stop();
  assert.ok((await lstat(f.path)).isSocket());
  const path = join(f.dir, 'ordinary');
  await writeFile(path, 'keep');
  const nonSocket = new IpcServer({ socketPath: path, state: new WorkerState() });
  await assert.rejects(nonSocket.start(), /non-socket/);
  await nonSocket.stop();
  assert.equal(await readFile(path, 'utf8'), 'keep');
});

test('a stale socket left by a killed process is replaced', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gm-stale-'));
  const path = join(dir, 'gm.sock');
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import net from "node:net"; net.createServer().listen(process.argv[1], () => process.stdout.write("ready"));', path],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal((await lstat(path)).isSocket(), true);
  const server = new IpcServer({ socketPath: path, state: new WorkerState() });
  t.after(() => server.stop());
  await server.start();
  assert.equal((await lstat(path)).mode & 0o777, 0o660);
  await server.stop();
});
