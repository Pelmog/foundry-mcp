import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerState } from '../lib/state.mjs';
import { Supervisor } from '../lib/supervisor.mjs';
import { NoUserError, navigationAllowed, bounded } from '../lib/gm-page.mjs';
import { fetchFoundryStatus, foundryUrl } from '../lib/foundry-status.mjs';
import { createLogger } from '../lib/log.mjs';

function setup() {
  const state = new WorkerState();
  let status = { active: true, world: 'alpha' };
  let time = 0;
  const gm = {
    joins: [], closes: 0, good: true, error: null,
    async healthy() { return this.good; },
    async join(worldId) {
      this.joins.push(worldId);
      if (this.error) throw this.error;
      this.page = {};
      return { page: this.page, info: { worldId, worldTitle: worldId, systemId: 'paranoia',
        userId: 'gm', userName: 'Friend Computer', tabId: String(this.joins.length) } };
    },
    async closePage() { this.closes++; this.page = null; },
    async close() { this.closes++; }
  };
  const supervisor = new Supervisor({ state, gm, now: () => time, getStatus: async () => {
    if (status instanceof Error) throw status;
    return status;
  } });
  return { state, gm, supervisor, setStatus: value => { status = value; },
    advance: ms => { time += ms; } };
}

test('no world stays idle without joining; active world joins once', async () => {
  const f = setup();
  f.setStatus({ active: false, world: null });
  await f.supervisor.tick();
  assert.equal(f.state.value.state, 'no-world');
  assert.deepEqual(f.gm.joins, []);
  f.setStatus({ active: true, world: 'alpha' });
  await f.supervisor.tick();
  assert.equal(f.state.value.state, 'ready');
  assert.equal(f.state.value.generation, 1);
  await f.supervisor.tick();
  assert.deepEqual(f.gm.joins, ['alpha']);
});

test('world switch and same-world restart each rejoin and increment generation', async () => {
  const f = setup();
  await f.supervisor.tick();
  f.setStatus({ active: true, world: 'beta' });
  await f.supervisor.tick();
  assert.equal(f.state.value.worldId, 'beta');
  assert.equal(f.state.value.generation, 2);
  f.gm.onLost('Foundry socket disconnected');
  assert.equal(f.state.value.state, 'error');
  await f.supervisor.tick();
  assert.equal(f.state.value.generation, 3);
  assert.deepEqual(f.gm.joins, ['alpha', 'beta', 'beta']);
});

test('unhealthy page or wrong user detected by health probe is rejoined', async () => {
  const f = setup();
  await f.supervisor.tick();
  f.gm.good = false;
  await f.supervisor.tick();
  assert.equal(f.state.value.generation, 2);
});

test('missing user is no-user, backs off to five minutes, world change resets backoff', async () => {
  const f = setup();
  f.gm.error = new NoUserError('absent');
  for (const delay of [15000, 30000, 60000, 120000, 240000, 300000, 300000]) {
    await f.supervisor.tick();
    assert.equal(f.state.value.state, 'no-user');
    const count = f.gm.joins.length;
    f.advance(delay - 1);
    await f.supervisor.tick();
    assert.equal(f.gm.joins.length, count);
    f.advance(1);
  }
  assert.equal(f.state.value.generation, 0);
  f.gm.error = null;
  f.setStatus({ active: true, world: 'beta' });
  await f.supervisor.tick();
  assert.equal(f.state.value.state, 'ready');
  assert.equal(f.state.value.generation, 1);
});

test('status failure immediately invalidates the loaded page', async () => {
  const f = setup();
  await f.supervisor.tick();
  f.setStatus(new Error('offline'));
  await f.supervisor.tick();
  assert.equal(f.state.value.state, 'error');
  assert.equal(f.state.page, null);
  assert.equal(f.state.value.lastError, 'offline');
});

test('watchdog ticks do not overlap', async () => {
  const f = setup();
  let release;
  let checks = 0;
  f.supervisor.getStatus = () => { checks++; return new Promise(resolve => { release = resolve; }); };
  const a = f.supervisor.tick();
  const b = f.supervisor.tick();
  assert.equal(a, b);
  assert.equal(checks, 1);
  release({ active: false });
  await a;
});

test('a watchdog health check started before recovery cannot overwrite recovery state', async () => {
  const f = setup();
  await f.supervisor.tick();
  const oldPage = f.state.page;
  let rejectHealth;
  let entered;
  const checking = new Promise(resolve => { entered = resolve; });
  f.gm.healthy = () => new Promise((_, reject) => { rejectHealth = reject; entered(); });
  const oldTick = f.supervisor.tick();
  await checking;
  await f.supervisor.recoverStuck({ page: oldPage });
  rejectHealth(new Error('old page closed'));
  await oldTick;
  assert.equal(f.state.value.state, 'joining');
  assert.equal(f.state.value.generation, 2);
  assert.equal(f.supervisor.nextJoin, 0);
  assert.equal(f.supervisor.failures, 0);
  await f.supervisor.tick();
  assert.equal(f.state.value.state, 'ready');
  assert.equal(f.state.value.generation, 2);
});

test('recovery from an obsolete page cannot close a replacement', async () => {
  const f = setup();
  await f.supervisor.tick();
  const oldPage = f.state.page;
  f.gm.good = false;
  await f.supervisor.tick();
  const currentPage = f.state.page;
  const closes = f.gm.closes;
  await f.supervisor.recoverStuck({ page: oldPage });
  assert.equal(f.state.value.state, 'ready');
  assert.equal(f.state.page, currentPage);
  assert.equal(f.state.value.generation, 2);
  assert.equal(f.gm.closes, closes);
});

test('status fetch is bounded, refuses redirects and validates response shape', async () => {
  let options;
  const result = await fetchFoundryStatus('http://example.invalid/foundry/', {
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://example.invalid/foundry/api/status');
      options = init;
      return { ok: true, json: async () => ({ active: true, world: 'alpha' }) };
    }
  });
  assert.equal(result.world, 'alpha');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  await assert.rejects(fetchFoundryStatus('http://example.invalid', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ active: true }) })
  }), /Invalid Foundry/);
  await assert.rejects(fetchFoundryStatus('http://example.invalid', {
    fetchImpl: async () => ({ ok: false, status: 503 })
  }), /HTTP 503/);
});

test('navigation guard blocks setup redirects, encoded setup, and other origins', () => {
  const base = 'http://127.0.0.1:30000';
  for (const path of ['/setup', '/setup/', '/%73etup', '/prefix/setup', '/setup?x=1']) {
    assert.equal(navigationAllowed(base + path, base), false);
  }
  assert.equal(navigationAllowed(base + '/game', base), true);
  assert.equal(navigationAllowed(base + '/join', base), true);
  assert.equal(navigationAllowed('https://example.invalid/game', base), false);
  assert.throws(() => foundryUrl('http://user:secret@example.invalid', '/join'), /without credentials/);
});

test('structured logs redact a password even inside nested error messages', () => {
  const lines = [];
  const log = createLogger('fake-test-value', line => lines.push(line));
  log('failure', { error: 'fill fake-test-value failed', nested: { value: 'fake-test-value' } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('fake-test-value'), false);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, 'failure');
  assert.equal(parsed.nested.value, '[REDACTED]');
});

test('health-check deadline rejects a hung browser', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 5, 'hung'), /hung/);
});
