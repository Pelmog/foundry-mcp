import net from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bridgeOps = new Set(['info', 'exec', 'create', 'roll']);
const MAX_LINE_BYTES = 1024 * 1024;

function validate(request) {
  if (!record(request) || typeof request.id !== 'string' || !request.id.length) return false;
  if (!['status', 'call'].includes(request.op)) return false;
  if (request.expectWorld !== undefined && typeof request.expectWorld !== 'string') return false;
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0)) return false;
  if (request.op === 'status') return request.args === undefined;
  return record(request.args) && bridgeOps.has(request.args.op) && record(request.args.args);
}

async function removeStaleSocket(path) {
  const stat = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!stat) return;
  if (!stat.isSocket()) throw new Error('Refusing to remove a non-socket at the IPC path');
  // Do not unlink a socket owned by an already-running worker.
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(path);
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); reject(new Error('IPC socket is already in use')); });
    probe.once('timeout', () => { probe.destroy(); reject(new Error('IPC socket probe timed out')); });
    probe.once('error', error => {
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve();
      else reject(error);
    });
  });
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

export class IpcServer {
  constructor({ socketPath, state, log = () => {}, stuckGraceMs = 15000, recoverStuck }) {
    if (!Number.isInteger(stuckGraceMs) || stuckGraceMs < 1 || stuckGraceMs > 2147483647) {
      throw new Error('GM_STUCK_GRACE_MS must be an integer between 1 and 2147483647');
    }
    this.socketPath = socketPath;
    this.state = state;
    this.log = log;
    this.stuckGraceMs = stuckGraceMs;
    this.recoverStuck = recoverStuck ?? (async ({ page, generation }) => {
      if (state.page === page && state.value.generation === generation) {
        state.transition('joining', { worldId: state.value.worldId }, null, { reserveGeneration: true });
      }
      await page.close({ runBeforeUnload: false });
    });
    this.recovering = null;
    this.queue = [];
    this.active = null;
    this.clients = new Set();
    this.stopping = false;
    this.onChange = () => {
      const invalid = item => this.state.value.state !== 'ready'
        || item.generation !== this.state.value.generation || item.page !== this.state.page;
      if (this.active && invalid(this.active)) this.fail(this.active, 'NOT_READY', 'GM page changed');
      for (const item of [...this.queue]) {
        if (invalid(item)) this.fail(item, 'NOT_READY', 'GM page changed');
      }
      this.queue = this.queue.filter(item => !item.done);
    };
    state.on('change', this.onChange);
  }

  async start() {
    await removeStaleSocket(this.socketPath);
    this.server = net.createServer(socket => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => { this.server.off('error', reject); resolve(); });
    });
    this.owned = true;
    this.identity = await lstat(this.socketPath);
    await chmod(this.socketPath, 0o660);
    this.server.on('error', error => this.log('ipc-error', { code: error.code }));
  }

  accept(socket) {
    if (this.stopping) return socket.destroy();
    this.clients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    const send = response => {
      if (socket.destroyed || socket.writableEnded) return;
      // Bound slow readers as well as oversized requests.
      if (socket.writableLength > MAX_LINE_BYTES * 4) return socket.destroy();
      socket.write(JSON.stringify(response) + '\n');
    };
    socket.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          send({ id: null, ok: false, code: 'BAD_REQUEST', error: 'Request exceeds 1 MiB' });
          socket.end();
          return;
        }
        let request;
        try { request = JSON.parse(line); } catch {
          send({ id: null, ok: false, code: 'BAD_REQUEST', error: 'Malformed JSON' });
          continue;
        }
        this.handle(request, send, socket);
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        send({ id: null, ok: false, code: 'BAD_REQUEST', error: 'Request exceeds 1 MiB' });
        socket.end();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.clients.delete(socket);
      for (const item of this.queue.filter(item => item.socket === socket)) {
        this.fail(item, 'NOT_READY', 'Client disconnected');
      }
      this.queue = this.queue.filter(item => !item.done);
    });
  }

  handle(request, send, socket) {
    const id = typeof request?.id === 'string' ? request.id : null;
    const reject = (code, error) => send({ id, ok: false, error, code, meta: this.state.meta() });
    if (!validate(request)) return reject('BAD_REQUEST', 'Invalid request');
    if (this.stopping) return reject('NOT_READY', 'Worker is stopping');
    if (request.op === 'status') {
      return send({ id, ok: true, result: this.state.snapshot(), meta: this.state.meta() });
    }
    if (this.state.value.state !== 'ready' || !this.state.page) return reject('NOT_READY', 'No ready GM page');
    if (request.expectWorld !== undefined && request.expectWorld !== this.state.value.worldId) {
      return reject('WRONG_WORLD', 'Loaded world does not match expectWorld');
    }
    if (this.queue.length >= 50) return reject('BUSY', '50 calls are already waiting');
    const item = { request, send, socket, page: this.state.page,
      generation: this.state.value.generation, meta: this.state.meta(), done: false };
    // Deadline includes time in the queue. A queued timeout is never dispatched.
    item.timer = setTimeout(() => {
      this.fail(item, 'TIMEOUT', 'Call deadline exceeded; it may still have run and will not be retried');
      this.queue = this.queue.filter(entry => entry !== item);
      // Only a dispatch that actually occupies the slot can wedge the page.
      // Expiring in the waiting queue must not initiate recovery.
      if (this.active === item) {
        item.graceTimer = setTimeout(() => this.recover(item), this.stuckGraceMs);
      }
    }, Math.min(request.timeoutMs ?? 30000, 120000));
    this.queue.push(item);
    this.pump();
  }

  respond(item, response) {
    if (item.done) return;
    item.done = true;
    clearTimeout(item.timer);
    item.send({ id: item.request.id, ...response, meta: item.meta });
  }

  fail(item, code, error) { this.respond(item, { ok: false, error, code }); }

  recover(item) {
    if (this.stopping || this.active !== item || item.settled || this.recovering) return;
    this.log('dispatch-stuck', { generation: item.generation, worldId: item.meta.worldId,
      graceMs: this.stuckGraceMs });
    const recovery = Promise.resolve().then(() => this.recoverStuck({ page: item.page, generation: item.generation }));
    this.recovering = recovery;
    void recovery.catch(() => {
      this.log('dispatch-recovery-error', { generation: item.generation });
    }).finally(() => {
      // The old evaluate may NEVER settle, even after the page is closed.
      if (this.active === item) this.active = null;
      if (this.recovering === recovery) this.recovering = null;
      this.pump();
    });
  }

  pump() {
    if (this.active || this.stopping || this.recovering) return;
    const item = this.queue.shift();
    if (!item) return;
    if (item.done) return this.pump();
    if (this.state.value.state !== 'ready' || item.generation !== this.state.value.generation
        || item.page !== this.state.page) {
      this.fail(item, 'NOT_READY', 'GM page changed');
      return this.pump();
    }
    this.active = item;
    // Retain the slot during the grace period; recovery closes the old page
    // before releasing it. A timeout alone must not overlap two mutations.
    Promise.resolve().then(() => {
      if (item.done) return;
      return item.page.evaluate(({ op, args }) => globalThis.foundryMcpBridge.dispatch(op, args), item.request.args);
    }).then(result => {
      // Validate serialisability before attempting socket.write; undefined becomes null.
      const json = JSON.parse(JSON.stringify(result ?? null));
      this.respond(item, { ok: true, result: json });
    }, error => {
      this.fail(item, 'EXEC_ERROR', String(error?.message ?? error));
    }).catch(error => {
      this.fail(item, 'EXEC_ERROR', String(error?.message ?? error));
    }).finally(() => {
      item.settled = true;
      clearTimeout(item.graceTimer);
      // Late settlement from a recovered page must not clear a fresh call's slot.
      if (this.active === item) this.active = null;
      this.pump();
    });
  }

  async stop() {
    this.stopping = true;
    if (this.active) clearTimeout(this.active.graceTimer);
    this.state.off('change', this.onChange);
    if (this.active) this.fail(this.active, 'NOT_READY', 'Worker is stopping');
    for (const item of this.queue) this.fail(item, 'NOT_READY', 'Worker is stopping');
    this.queue = [];
    const closed = this.server?.listening
      ? new Promise(resolve => this.server.close(resolve)) : Promise.resolve();
    for (const client of this.clients) client.end();
    // Give final replies a chance to flush without letting idle peers hold shutdown open.
    const force = setTimeout(() => { for (const client of this.clients) client.destroy(); }, 250);
    await closed;
    clearTimeout(force);
    if (this.owned) {
      const current = await lstat(this.socketPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (current?.ino === this.identity.ino && current?.dev === this.identity.dev) await unlink(this.socketPath);
      this.owned = false;
    }
  }
}
