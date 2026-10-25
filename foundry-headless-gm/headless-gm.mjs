import { chromium } from 'playwright';
import { isAbsolute } from 'node:path';
import { WorkerState } from './lib/state.mjs';
import { IpcServer } from './lib/ipc-server.mjs';
import { GmPage, bounded } from './lib/gm-page.mjs';
import { Supervisor } from './lib/supervisor.mjs';
import { fetchFoundryStatus, foundryUrl } from './lib/foundry-status.mjs';
import { createLogger, errorMessage } from './lib/log.mjs';

const password = process.env.GM_PASSWORD ?? '';
const log = createLogger(password);
let ipc;
let supervisor;
let stopping;
const abort = new AbortController();

function shutdown() {
  if (!stopping) stopping = (async () => {
    abort.abort();
    // Stop acceptance first; supervisor invalidates and closes the browser in parallel.
    const results = await Promise.allSettled([ipc?.stop(), supervisor?.stop()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  })();
  return stopping;
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  log('shutdown', { signal });
  void shutdown().then(() => { process.exitCode = 0; }, error => {
    log('shutdown-error', { error: errorMessage(error, password) });
    process.exitCode = 1;
  });
});

try {
  const once = process.argv.includes('--once');
  if (process.argv.slice(2).some(arg => arg !== '--once')) throw new Error('Usage: node headless-gm.mjs [--once]');
  const baseUrl = process.env.FOUNDRY_URL ?? 'http://127.0.0.1:30000';
  foundryUrl(baseUrl, '/api/status');
  const userName = process.env.GM_USER_NAME;
  if (!userName) throw new Error('GM_USER_NAME is required');
  if (process.env.GM_PASSWORD === undefined) throw new Error('GM_PASSWORD is required (may be empty)');
  const socketPath = process.env.FOUNDRY_GM_SOCKET ?? '/run/foundry-gm/gm.sock';
  const stateDir = process.env.FOUNDRY_GM_STATE_DIR ?? '/var/lib/foundry-gm';
  if (!isAbsolute(socketPath) || !isAbsolute(stateDir)) throw new Error('Socket and state paths must be absolute');
  const state = new WorkerState();
  const gm = new GmPage({ baseUrl, userName, password, stateDir, chromium });
  supervisor = new Supervisor({ state, gm, password, log,
    getStatus: () => fetchFoundryStatus(baseUrl, { signal: abort.signal }) });
  if (once) {
    await supervisor.tick();
    log('status', { status: state.snapshot() });
    if (state.value.state === 'ready') {
      const info = await bounded(state.page.evaluate(({ op, args }) => globalThis.foundryMcpBridge.dispatch(op, args),
        { op: 'info', args: {} }), 5000, 'Bridge info timed out');
      log('info', { info });
    } else process.exitCode = 1;
    await shutdown();
  } else {
    ipc = new IpcServer({ socketPath, state, log,
      stuckGraceMs: Number(process.env.GM_STUCK_GRACE_MS ?? 15000),
      recoverStuck: target => supervisor.recoverStuck(target) });
    await ipc.start();
    if (stopping) await ipc.stop();
    else { log('listening', { socketPath }); supervisor.start(); }
  }
} catch (error) {
  log('fatal', { error: errorMessage(error, password) });
  process.exitCode = 1;
  await shutdown().catch(error => log('shutdown-error', { error: errorMessage(error, password) }));
}
