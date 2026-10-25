import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGmClient, NO_GM_CLIENT } from '../../lib/gm-client.mjs';

const WORLD = 'world-a';

/** Fake headless worker. handler(req, reply, conn) is called for each request line. */
async function startWorker(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmw-'));
  const sock = path.join(dir, 'gm.sock');
  const requests = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const req = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        requests.push(req);
        handler(req, (msg) => conn.write(`${JSON.stringify(msg)}\n`), conn);
      }
    });
    conn.on('error', () => {});
  });
  await new Promise((r) => server.listen(sock, r));
  return {
    sock,
    requests,
    close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const status = (state, worldId = WORLD) => ({ state, worldId, generation: 1, since: new Date().toISOString() });

/** Worker that answers status with `st` and calls with `onCall(req)`. */
const simpleWorker = (st, onCall) => startWorker((req, reply) => {
  if (req.op === 'status') reply({ id: req.id, ok: true, result: st });
  else reply({ id: req.id, ...onCall(req) });
});

/** Fake foundry-socket with a scripted relay. */
function fakeSocket({ tabs = [{ sender: 'gm1', tabId: 'tab1' }], resultSender = 'gm1', connected = true } = {}) {
  const handlers = new Set();
  const emitted = [];
  const deliver = (data, sender) => setImmediate(() => handlers.forEach((h) => h(data, sender)));
  return {
    connected,
    worldData: {
      world: { id: WORLD },
      users: [{ _id: 'gm1', role: 3 }, { _id: 'gm2', role: 4 }, { _id: 'p1', role: 1 }],
    },
    emitted,
    onRelay(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    isGmUser(id) { return this.worldData.users.some((u) => u._id === id && u.role >= 3); },
    emitRelay(payload) {
      emitted.push(payload);
      if (payload.type === 'discover') {
        for (const t of tabs) {
          deliver({ type: 'discover-reply', requestId: payload.requestId, tabId: t.tabId, userId: t.sender, userName: 'x', bridgeVersion: '2.0.0', worldId: WORLD }, t.sender);
        }
      } else if (payload.type === 'call') {
        // a non-GM forges a result first; only the GM's may count
        deliver({ type: 'result', requestId: payload.requestId, tabId: payload.executor, success: true, result: 'FORGED' }, 'p1');
        deliver({ type: 'result', requestId: payload.requestId, tabId: payload.executor, success: true, result: `relay:${payload.op}` }, resultSender);
      }
    },
  };
}

const client = (socket, worker, extra = {}) => createGmClient({
  socket, workerSocketPath: () => worker?.sock ?? '/nonexistent/gm.sock', discoverWindowMs: 60, connectTimeoutMs: 200, ...extra,
});

test('worker ready in the current world -> via worker, with expectWorld', async () => {
  const w = await simpleWorker(status('ready'), () => ({ ok: true, result: { v: 1 }, meta: { tabId: 't' } }));
  try {
    const sock = fakeSocket();
    const out = await client(sock, w).browserCall('exec', { script: 'return 1' }, { timeoutMs: 5000 });
    assert.deepEqual(out, { result: { v: 1 }, via: 'worker', meta: { tabId: 't' } });
    const call = w.requests.find((r) => r.op === 'call');
    assert.equal(call.expectWorld, WORLD);
    assert.deepEqual(call.args, { op: 'exec', args: { script: 'return 1' } });
    assert.equal(sock.emitted.length, 0);
  } finally { w.close(); }
});

test('worker not ready -> relay', async () => {
  const w = await simpleWorker(status('joining'), () => assert.fail('must not call'));
  try {
    const out = await client(fakeSocket(), w).browserCall('roll', { formula: '1d6' });
    assert.equal(out.via, 'relay');
    assert.equal(out.result, 'relay:roll');
    assert.equal(out.meta.tabId, 'tab1');
  } finally { w.close(); }
});

test('worker ready in a different world -> relay', async () => {
  const w = await simpleWorker(status('ready', 'other-world'), () => assert.fail('must not call'));
  try {
    const out = await client(fakeSocket(), w).browserCall('exec', {});
    assert.equal(out.via, 'relay');
  } finally { w.close(); }
});

test('worker rejects the call with WRONG_WORLD -> relay (nothing ran)', async () => {
  const w = await simpleWorker(status('ready'), () => ({ ok: false, error: 'wrong world', code: 'WRONG_WORLD' }));
  try {
    const out = await client(fakeSocket(), w).browserCall('exec', {});
    assert.equal(out.via, 'relay');
  } finally { w.close(); }
});

test('no worker and no relay tabs -> the documented error', async () => {
  const sock = fakeSocket({ tabs: [] });
  await assert.rejects(client(sock, null).browserCall('exec', {}), (e) => {
    assert.equal(e.message, NO_GM_CLIENT);
    assert.equal(e.code, 'NO_GM_CLIENT');
    return true;
  });
});

test('TIMEOUT from the worker is propagated and never retried on the relay', async () => {
  const w = await simpleWorker(status('ready'), () => ({ ok: false, error: 'timed out', code: 'TIMEOUT' }));
  try {
    const sock = fakeSocket();
    await assert.rejects(client(sock, w).browserCall('exec', {}), (e) => e.code === 'TIMEOUT' && /timed out/.test(e.message));
    assert.equal(sock.emitted.length, 0);
    assert.equal(w.requests.filter((r) => r.op === 'call').length, 1);
  } finally { w.close(); }
});

test('NOT_READY during a call is not retried on the relay (it may have partly run)', async () => {
  const w = await simpleWorker(status('ready'), () => ({ ok: false, error: 'page reloaded', code: 'NOT_READY' }));
  try {
    const sock = fakeSocket();
    await assert.rejects(client(sock, w).browserCall('create', {}), (e) => e.code === 'NOT_READY' && /partly run/.test(e.message));
    assert.equal(sock.emitted.length, 0);
  } finally { w.close(); }
});

test('worker EXEC_ERROR surfaces its message', async () => {
  const w = await simpleWorker(status('ready'), () => ({ ok: false, error: 'boom', code: 'EXEC_ERROR' }));
  try {
    await assert.rejects(client(fakeSocket(), w).browserCall('exec', {}), (e) => e.code === 'EXEC_ERROR' && e.message === 'boom');
  } finally { w.close(); }
});

test('out-of-order responses are matched to the right caller', async () => {
  const held = [];
  const w = await startWorker((req, reply) => {
    if (req.op === 'status') return reply({ id: req.id, ok: true, result: status('ready') });
    held.push({ req, reply });
    if (held.length === 2) {
      // answer the second request first, and prefix each with a stray line carrying another id
      for (const { req: r, reply: rp } of [held[1], held[0]]) {
        rp({ id: 'stray', ok: true, result: 'WRONG' });
        rp({ id: r.id, ok: true, result: r.args.args.n, meta: {} });
      }
    }
  });
  try {
    const c = client(fakeSocket(), w);
    const [a, b] = await Promise.all([
      c.browserCall('exec', { n: 'first' }),
      c.browserCall('exec', { n: 'second' }),
    ]);
    assert.equal(a.result, 'first');
    assert.equal(b.result, 'second');
  } finally { w.close(); }
});

test('worker status is cached briefly', async () => {
  const w = await simpleWorker(status('ready'), () => ({ ok: true, result: 1, meta: {} }));
  try {
    let t = 1000;
    const c = client(fakeSocket(), w, { now: () => t, statusCacheMs: 2000 });
    await c.browserCall('exec', {});
    await c.browserCall('exec', {});
    assert.equal(w.requests.filter((r) => r.op === 'status').length, 1);
    t += 2500;
    await c.browserCall('exec', {});
    assert.equal(w.requests.filter((r) => r.op === 'status').length, 2);
  } finally { w.close(); }
});

test('relay: results and discover replies from non-GM senders are ignored', async () => {
  // call result: the fake delivers FORGED from player p1 before the real one from gm1
  const out = await client(fakeSocket(), null).browserCall('exec', {});
  assert.equal(out.result, 'relay:exec');

  // only a player answers discover -> no GM client
  const onlyPlayer = fakeSocket({ tabs: [{ sender: 'p1', tabId: 'evil' }] });
  await assert.rejects(client(onlyPlayer, null).browserCall('exec', {}), (e) => e.message === NO_GM_CLIENT);

  // a real GM tab whose result only ever arrives from a player -> times out, never resolves FORGED
  const forgedOnly = fakeSocket({ resultSender: 'p1' });
  await assert.rejects(
    client(forgedOnly, null).browserCall('exec', {}, { timeoutMs: 100 }),
    (e) => e.code === 'TIMEOUT'
  );
});

test('relay call targets the discovered tab and carries op/args/timeout', async () => {
  const sock = fakeSocket();
  await client(sock, null).browserCall('exec', { script: 's' }, { timeoutMs: 4000 });
  const call = sock.emitted.find((p) => p.type === 'call');
  assert.equal(call.executor, 'tab1');
  assert.equal(call.op, 'exec');
  assert.deepEqual(call.args, { script: 's' });
  assert.equal(call.timeoutMs, 4000);
});
