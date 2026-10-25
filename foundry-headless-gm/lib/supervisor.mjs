import { NoUserError } from './gm-page.mjs';
import { errorMessage } from './log.mjs';

export class Supervisor {
  constructor({ state, gm, getStatus, log = () => {}, password = '', now = Date.now }) {
    Object.assign(this, { state, gm, getStatus, log, password, now });
    this.failures = 0;
    this.nextJoin = 0;
    this.worldId = null;
    this.stopping = false;
    this.pending = null;
    this.recovery = null;
    this.epoch = 0;
    gm.onLost = reason => {
      if (!this.stopping) this.transition('error', { worldId: this.worldId, lastError: reason });
    };
  }

  transition(state, fields = {}, page = null, options) {
    this.state.transition(state, fields, page, options);
    this.log('state', this.state.snapshot());
  }

  tick() {
    if (this.stopping) return Promise.resolve();
    if (this.recovery) return this.recovery;
    if (!this.pending) this.pending = this.check().finally(() => { this.pending = null; });
    return this.pending;
  }

  async check() {
    const epoch = this.epoch;
    const stale = () => this.stopping || epoch !== this.epoch;
    try {
      const status = await this.getStatus();
      if (stale()) return;
      if (!status.active) {
        this.worldId = null;
        this.failures = 0;
        this.nextJoin = 0;
        this.transition('no-world');
        await this.gm.closePage();
        return;
      }
      if (status.world !== this.worldId) {
        this.worldId = status.world;
        this.failures = 0;
        this.nextJoin = 0;
        this.transition('joining', { worldId: status.world });
        await this.gm.closePage();
        if (stale()) return;
      }
      const healthy = this.state.value.state === 'ready' && await this.gm.healthy(status.world, this.state.tabId);
      if (stale() || healthy) return;
      if (this.state.value.state === 'ready') {
        this.transition('joining', { worldId: status.world });
        await this.gm.closePage();
        if (stale()) return;
      }
      if (this.now() < this.nextJoin) return;
      this.transition('joining', { worldId: status.world });
      const { info, page } = await this.gm.join(status.world);
      if (stale()) return;
      this.failures = 0;
      this.nextJoin = 0;
      const { worldId, worldTitle, systemId, userId, userName, tabId } = info;
      this.transition('ready', { worldId, worldTitle, systemId, userId, userName, tabId }, page);
    } catch (error) {
      if (stale()) return;
      this.failures += 1;
      const retryMs = Math.min(15000 * 2 ** Math.min(this.failures - 1, 5), 300000);
      this.nextJoin = this.now() + retryMs;
      this.transition(error instanceof NoUserError ? 'no-user' : 'error', {
        ...(this.worldId ? { worldId: this.worldId } : {}), lastError: errorMessage(error, this.password)
      });
      await this.gm.closePage();
      this.log('retry', { retryMs });
    }
  }

  recoverStuck({ page }) {
    // A timeout from an older page must not close a replacement already joined.
    if (this.stopping || this.gm.page !== page) return Promise.resolve();
    if (this.recovery) return this.recovery;
    this.epoch += 1;
    this.failures = 0;
    this.nextJoin = 0;
    this.transition('joining', { worldId: this.worldId, lastError: 'Recovering stuck dispatch' },
      null, { reserveGeneration: true });
    this.recovery = this.gm.closePage().catch(error => {
      if (!this.stopping) this.transition('error', {
        worldId: this.worldId, lastError: errorMessage(error, this.password)
      });
      throw error;
    }).finally(() => { this.recovery = null; });
    return this.recovery;
  }

  start() {
    const run = () => { void this.tick().catch(error => this.log('watchdog-error', {
      error: errorMessage(error, this.password)
    })); };
    this.timer = setInterval(run, 15000);
    run();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.transition('error', { lastError: 'Worker is stopping' });
    await this.gm.close();
    await this.recovery?.catch(() => {});
    await this.pending;
    // A launch already in progress when SIGTERM arrived must also be closed.
    await this.gm.close();
  }
}
