import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { foundryUrl } from './foundry-status.mjs';

export class NoUserError extends Error {}

export async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function navigationAllowed(rawUrl, base) {
  const url = new URL(rawUrl);
  const root = new URL(base);
  const path = decodeURIComponent(url.pathname);
  return url.origin === root.origin && !path.split('/').includes('setup');
}

export async function guardRoute(route, baseUrl) {
  const request = route.request();
  let blocked;
  try {
    const path = decodeURIComponent(new URL(request.url()).pathname);
    blocked = path.split('/').includes('setup')
      || (request.isNavigationRequest() && !navigationAllowed(request.url(), baseUrl));
  } catch { blocked = true; }
  if (blocked) return route.abort('blockedbyclient');
  if (!request.isNavigationRequest()) return route.continue();
  // Playwright routing may only intercept the FIRST request in a redirect chain.
  // Fetch navigation without following redirects and reject all redirects, so a
  // world stopping between /api/status and /join cannot navigate to /setup.
  const response = await route.fetch({ maxRedirects: 0, timeout: 30000 });
  try {
    if (response.status() >= 300 && response.status() < 400) return await route.abort('blockedbyclient');
    await route.fulfill({ response });
  } finally { await response.dispose(); }
}

export class GmPage {
  constructor({ baseUrl, userName, password, stateDir, onLost = () => {}, chromium }) {
    Object.assign(this, { baseUrl, userName, password, stateDir, onLost, chromium });
    this.context = null;
    this.page = null;
    this.armed = false;
    this.stopping = false;
  }

  lost(reason) {
    if (!this.armed) return;
    this.armed = false;
    this.onLost(reason);
  }

  async ensureContext() {
    if (this.context) return;
    if (this.stopping) throw new Error('Worker is stopping');
    await mkdir(this.stateDir, { recursive: true, mode: 0o750 });
    // With headless:true and no channel, Playwright selects chromium-headless-shell.
    // chromiumSandbox defaults to false in Playwright, so explicitly enable it.
    const context = await this.chromium.launchPersistentContext(join(this.stateDir, 'profile'), {
      headless: true, chromiumSandbox: true, serviceWorkers: 'block',
      timeout: 30000,
      args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check']
    });
    this.context = context;
    if (this.stopping) { await context.close(); throw new Error('Worker is stopping'); }
    context.on('close', () => {
      if (this.context === context) { this.context = null; this.page = null; this.lost('Browser closed'); }
    });
    await context.addInitScript(() => {
      try { localStorage.setItem('core.noCanvas', 'true'); } catch { /* about:blank has no storage */ }
    });
    // Block /setup even if Foundry redirects there during the status/join race.
    await context.route('**/*', async route => {
      try { await guardRoute(route, this.baseUrl); }
      catch { await route.abort('failed').catch(() => {}); }
    });
    await context.exposeBinding('__foundryGmDisconnected', ({ page }) => {
      if (page === this.page) this.lost('Foundry socket disconnected');
    });
    context.on('page', page => {
      // The worker never needs popup windows or a second live game page.
      if (this.page && page !== this.page) void page.close().catch(() => {});
    });
    for (const page of context.pages()) await page.close();
  }

  async closePage() {
    this.armed = false;
    const page = this.page;
    if (page && !page.isClosed()) await page.close({ runBeforeUnload: false });
    // Retain the page on a failed close, so the watchdog retries closing it
    // before creating a replacement (and never leaves two live GM pages).
    if (this.page === page) this.page = null;
  }

  async join(worldId) {
    await this.closePage();
    await this.ensureContext();
    if (this.stopping) throw new Error('Worker is stopping');
    await this.context.clearCookies();
    const page = await this.context.newPage();
    this.page = page;
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);
    page.on('close', () => this.lost('GM page closed'));
    page.on('crash', () => this.lost('GM page crashed'));
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) this.lost('GM page navigated');
    });
    await page.goto(foundryUrl(this.baseUrl, '/join'), { waitUntil: 'domcontentloaded' });
    const users = page.locator('select[name="userid"]');
    await users.waitFor();
    // The v13 join UI is populated asynchronously; wait for user options to arrive.
    await page.waitForFunction(() => [...document.querySelectorAll('select[name="userid"] option')]
      .some(option => option.value));
    const ids = await users.locator('option').evaluateAll((options, name) => options
      .filter(option => option.textContent.trim() === name).map(option => option.value), this.userName);
    if (!ids.length) throw new NoUserError('Configured GM user is absent from this world');
    if (ids.length !== 1 || !ids[0]) throw new Error('Configured GM user name is ambiguous');
    await users.selectOption(ids[0]);
    // Do not attach request/console/trace logging: the login form contains the password.
    await page.locator('input[name="password"]').fill(this.password);
    await page.locator('button[name="join"]').click();
    await page.waitForURL(foundryUrl(this.baseUrl, '/game'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.game?.ready
      && typeof globalThis.foundryMcpBridge?.dispatch === 'function', { }, { timeout: 60000 });
    const info = await bounded(page.evaluate(({ op, args }) => globalThis.foundryMcpBridge.dispatch(op, args),
      { op: 'info', args: {} }), 5000, 'Bridge info timed out');
    if (!info?.ready || !info.isGM || info.userRole !== 3 || info.userName !== this.userName || info.worldId !== worldId
        || !info.userId || !info.tabId || info.bridgeVersion !== '2.0.0') {
      throw new Error('Bridge identity, version, or world does not match the GM contract');
    }
    await bounded(page.evaluate(() => {
      game.socket.on('disconnect', () => { void globalThis.__foundryGmDisconnected(); });
      if (!game.socket.connected) throw new Error('Foundry socket disconnected during join');
    }), 5000, 'Socket check timed out');
    if (this.stopping) throw new Error('Worker is stopping');
    this.armed = true;
    return { page, info };
  }

  async healthy(worldId, tabId) {
    if (!this.page || this.page.isClosed() || !this.armed) return false;
    return bounded(this.page.evaluate(({ worldId, userName, tabId }) => Boolean(
      globalThis.game?.ready && game.socket?.connected && game.world?.id === worldId
      && game.user?.name === userName && game.user?.isGM
      && typeof globalThis.foundryMcpBridge?.dispatch === 'function'
      && foundryMcpBridge.tabId === tabId
    ), { worldId, userName: this.userName, tabId }), 5000, 'GM page health check timed out');
  }

  async close() {
    this.stopping = true;
    this.armed = false;
    if (this.context) await this.context.close();
    this.context = null;
    this.page = null;
  }
}
