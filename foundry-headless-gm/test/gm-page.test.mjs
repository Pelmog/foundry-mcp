import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GmPage, NoUserError, guardRoute } from '../lib/gm-page.mjs';

test('navigation response redirects are blocked before /setup can be fetched', async () => {
  const events = [];
  const response = { status: () => 302, dispose: async () => events.push('dispose') };
  const route = {
    request: () => ({ url: () => 'http://example.invalid/join', isNavigationRequest: () => true }),
    fetch: async options => { assert.equal(options.maxRedirects, 0); events.push('fetch'); return response; },
    abort: async () => events.push('abort'),
    fulfill: async () => events.push('fulfill')
  };
  await guardRoute(route, 'http://example.invalid');
  assert.deepEqual(events, ['fetch', 'abort', 'dispose']);
  events.length = 0;
  response.status = () => 200;
  await guardRoute(route, 'http://example.invalid');
  assert.deepEqual(events, ['fetch', 'fulfill', 'dispose']);
});

test('direct setup navigation is aborted without any fetch', async () => {
  let aborted = false;
  await guardRoute({ request: () => ({ url: () => 'http://example.invalid/setup', isNavigationRequest: () => true }),
    abort: async () => { aborted = true; }, fetch: () => assert.fail('must not fetch setup') }, 'http://example.invalid');
  assert.equal(aborted, true);
});

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'gm-page-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const actions = [];
  const pages = [];
  const info = { ready: true, isGM: true, userRole: 3, userName: 'Friend Computer',
    userId: 'u1', tabId: 't1', worldId: 'alpha', bridgeVersion: '2.0.0' };
  let ids = ['u1'];
  const context = new EventEmitter();
  context.pages = () => pages.filter(page => !page.closed);
  context.addInitScript = async fn => {
    actions.push('init');
    const saved = globalThis.localStorage;
    globalThis.localStorage = { setItem: (key, value) => {
      assert.equal(key, 'core.noCanvas'); assert.equal(value, 'true');
    } };
    try { fn(); } finally {
      if (saved === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = saved;
    }
  };
  context.route = async () => actions.push('route');
  context.exposeBinding = async (name, fn) => { context.binding = fn; };
  context.clearCookies = async () => actions.push('clearCookies');
  context.newPage = async () => {
    const page = new EventEmitter();
    pages.push(page);
    context.emit('page', page);
    page.isClosed = () => Boolean(page.closed);
    page.close = async () => { page.closed = true; page.emit('close'); };
    page.setDefaultTimeout = () => {};
    page.setDefaultNavigationTimeout = () => {};
    page.mainFrame = () => 'main';
    page.goto = async url => { actions.push(url); page.emit('framenavigated', 'main'); };
    page.waitForURL = async url => actions.push(url);
    page.waitForFunction = async () => {};
    page.locator = selector => {
      actions.push(selector);
      return { waitFor: async () => {}, locator: () => ({ evaluateAll: async () => ids }),
        selectOption: async id => assert.equal(id, 'u1'),
        fill: async () => actions.push('fill'), click: async () => actions.push('click') };
    };
    page.evaluate = async (_fn, payload) => payload?.op === 'info' ? info : true;
    return page;
  };
  context.close = async () => { for (const page of pages) await page.close(); context.emit('close'); };
  let launches = 0;
  const chromium = { launchPersistentContext: async (profile, options) => {
    launches++;
    assert.equal(profile, join(stateDir, 'profile'));
    assert.equal(options.chromiumSandbox, true);
    assert.equal(options.headless, true);
    assert.ok(options.args.includes('--disable-gpu'));
    assert.equal(options.args.includes('--no-sandbox'), false);
    return context;
  } };
  const lost = [];
  const gm = new GmPage({ baseUrl: 'http://example.invalid', userName: 'Friend Computer', password: '',
    stateDir, chromium, onLost: reason => lost.push(reason) });
  t.after(() => gm.close());
  return { gm, info, actions, context, pages, lost, setIds: value => { ids = value; }, launches: () => launches };
}

test('one sandboxed persistent context; noCanvas before navigation; rejoin closes old page', async t => {
  const f = await fixture(t);
  const first = await f.gm.join('alpha');
  assert.equal(first.info, f.info);
  assert.ok(f.actions.indexOf('init') < f.actions.indexOf('http://example.invalid/join'));
  assert.ok(f.actions.includes('input[name="password"]'));
  assert.ok(f.actions.includes('button[name="join"]'));
  const second = await f.gm.join('alpha');
  assert.equal(first.page.closed, true);
  assert.notEqual(first.page, second.page);
  assert.equal(f.launches(), 1);
  assert.equal(f.context.pages().length, 1);
  assert.deepEqual(f.lost, []);
  f.context.binding({ page: second.page });
  assert.deepEqual(f.lost, ['Foundry socket disconnected']);
});

test('missing named user produces NoUserError without filling a password', async t => {
  const f = await fixture(t);
  f.setIds([]);
  await assert.rejects(f.gm.join('alpha'), NoUserError);
  assert.equal(f.actions.includes('fill'), false);
});

test('a mismatched bridge identity is rejected before readiness', async t => {
  const f = await fixture(t);
  f.info.worldId = 'beta';
  await assert.rejects(f.gm.join('alpha'), /does not match/);
  assert.equal(f.gm.armed, false);
});

test('main frame navigation invalidates a ready page immediately', async t => {
  const f = await fixture(t);
  const { page } = await f.gm.join('alpha');
  page.emit('framenavigated', 'child');
  assert.deepEqual(f.lost, []);
  page.emit('framenavigated', 'main');
  assert.deepEqual(f.lost, ['GM page navigated']);
});
