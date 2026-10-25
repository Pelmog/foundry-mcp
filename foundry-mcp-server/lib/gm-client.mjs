/**
 * GM client seam: run an operation in a GM browser client.
 *
 *   browserCall(op, args, {timeoutMs}) -> {result, via: "worker" | "relay", meta}
 *
 * 1. Headless worker over a unix socket (NDJSON), if ready in the current world.
 * 2. Otherwise the Foundry socket relay to one human GM tab (discover, then call).
 * 3. Otherwise a clear error. Never a silent fallback to something with different semantics.
 *
 * Contract: docs/gm-client-contract.md sections 2-4.
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { foundrySocket } from './foundry-socket.mjs';

const log = (...args) => console.error('[gm-client]', ...args);

export const NO_GM_CLIENT =
  'No GM client available: start foundry-headless-gm on the server, or open the world as GM in a browser.';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;

export class GmClientError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GmClientError';
    this.code = code;
  }
}

/** One request/response exchange with the worker. Resolves null if it can't be reached. */
function workerExchange(socketPath, request, { connectTimeoutMs, responseTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    let buffer = '';
    let connected = false;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      fn(value);
    };
    // Short while connecting (a dead worker must not stall every tool call), then
    // long enough for the worker's own TIMEOUT response to arrive first.
    let timer = setTimeout(() => finish(resolve, null), connectTimeoutMs);

    conn.on('connect', () => {
      connected = true;
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(reject, new GmClientError('Worker did not respond; the call may still have run', 'NO_RESPONSE')),
        responseTimeoutMs
      );
      conn.write(`${JSON.stringify(request)}\n`);
    });
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === request.id) return finish(resolve, msg); // match on id; ignore others
      }
    });
    conn.on('error', (err) => {
      if (!connected) finish(resolve, null); // ENOENT / ECONNREFUSED / EACCES: no worker
      else finish(reject, new GmClientError(`Worker connection error: ${err.message}; the call may still have run`, 'NO_RESPONSE'));
    });
    conn.on('close', () => {
      if (connected) finish(reject, new GmClientError('Worker closed the connection; the call may still have run', 'NO_RESPONSE'));
      else finish(resolve, null);
    });
  });
}

export function createGmClient({
  socket = foundrySocket,
  workerSocketPath = () => config.gmSocket,
  connectTimeoutMs = 500,
  statusCacheMs = 2000,
  discoverWindowMs = 1500,
  now = Date.now,
} = {}) {
  let statusCache = null; // { at, status }
  const pending = new Map(); // requestId -> fn(data, senderId)
  let unsubscribe = null;

  // ── Worker ────────────────────────────────────────────────
  async function workerStatus({ fresh = false } = {}) {
    if (!fresh && statusCache && now() - statusCache.at < statusCacheMs) return statusCache.status;
    let status = null;
    try {
      const res = await workerExchange(
        workerSocketPath(),
        { id: randomUUID(), op: 'status' },
        { connectTimeoutMs, responseTimeoutMs: 2000 }
      );
      status = res?.ok ? res.result : null;
    } catch (err) {
      log('worker status failed:', err.message);
    }
    statusCache = { at: now(), status };
    return status;
  }

  async function workerCall(op, args, timeoutMs, expectWorld) {
    const res = await workerExchange(
      workerSocketPath(),
      { id: randomUUID(), op: 'call', args: { op, args }, expectWorld, timeoutMs },
      { connectTimeoutMs, responseTimeoutMs: timeoutMs + 5000 }
    );
    if (!res) return { ok: false, unreachable: true };
    if (res.ok) return { ok: true, result: res.result, meta: res.meta };
    return { ok: false, error: res.error || 'worker error', code: res.code };
  }

  // ── Relay ─────────────────────────────────────────────────
  function ensureRelaySubscription() {
    if (unsubscribe) return;
    unsubscribe = socket.onRelay((data, senderId) => {
      // Any logged-in user can emit on this channel; only a GM's reply may be believed.
      if (!socket.isGmUser(senderId)) {
        log(`ignored relay message from non-GM sender ${senderId}`);
        return;
      }
      pending.get(data?.requestId)?.(data, senderId);
    });
  }

  function relayRequest(payload, onMessage, timeoutMs, onTimeout) {
    ensureRelaySubscription();
    return new Promise((resolve, reject) => {
      const done = (fn, value) => {
        clearTimeout(timer);
        pending.delete(payload.requestId);
        fn(value);
      };
      const timer = setTimeout(() => onTimeout(done, resolve, reject), timeoutMs);
      pending.set(payload.requestId, (data) => onMessage(data, (v) => done(resolve, v), (e) => done(reject, e)));
      try {
        socket.emitRelay(payload);
      } catch (err) {
        done(reject, err);
      }
    });
  }

  /** Discover GM tabs. firstOnly resolves on the first reply instead of waiting out the window. */
  function discover({ firstOnly = false, windowMs = discoverWindowMs } = {}) {
    const replies = [];
    const worldId = socket.worldData?.world?.id;
    return relayRequest(
      { type: 'discover', requestId: randomUUID() },
      (data, resolve) => {
        if (data.type !== 'discover-reply' || !data.tabId) return;
        if (worldId && data.worldId && data.worldId !== worldId) return;
        replies.push(data);
        if (firstOnly) resolve(replies);
      },
      windowMs,
      (done, resolve) => done(resolve, replies)
    );
  }

  async function relayCall(op, args, timeoutMs) {
    const [tab] = await discover({ firstOnly: true });
    if (!tab) return null;
    const requestId = randomUUID();
    const data = await relayRequest(
      { type: 'call', requestId, executor: tab.tabId, op, args, timeoutMs },
      (msg, resolve) => { if (msg.type === 'result') resolve(msg); },
      timeoutMs,
      (done, resolve, reject) => done(reject, new GmClientError(`Relay call timed out after ${timeoutMs}ms; it may still have run`, 'TIMEOUT'))
    );
    if (!data.success) throw new GmClientError(data.error || 'relay call failed', 'EXEC_ERROR');
    return {
      result: data.result,
      meta: { tabId: tab.tabId, userId: tab.userId, userName: tab.userName, bridgeVersion: tab.bridgeVersion, worldId: tab.worldId },
    };
  }

  // ── Public ────────────────────────────────────────────────
  async function browserCall(op, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    timeoutMs = Math.min(Math.max(Math.trunc(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
    const worldId = socket.worldData?.world?.id;

    const status = worldId ? await workerStatus() : null;
    if (status?.state === 'ready' && status.worldId === worldId) {
      const out = await workerCall(op, args, timeoutMs, worldId);
      if (out.ok) return { result: out.result, via: 'worker', meta: out.meta };
      statusCache = null;
      if (out.unreachable || out.code === 'WRONG_WORLD') {
        // Rejected before dispatch, so the relay can't double-run it.
      } else {
        // A NOT_READY during a call can be a page crash mid-run; the worker never replays and
        // neither do we, since a retry on the relay could run a create twice.
        throw new GmClientError(
          out.code === 'NOT_READY' ? `${out.error} (the call may have partly run; not retried)` : out.error,
          out.code
        );
      }
    }

    if (socket.connected) {
      const out = await relayCall(op, args, timeoutMs);
      if (out) return { ...out, via: 'relay' };
    }
    throw new GmClientError(NO_GM_CLIENT, 'NO_GM_CLIENT');
  }

  async function gmStatus() {
    const worker = await workerStatus();
    let relayTabs = null;
    if (socket.connected) {
      try {
        relayTabs = (await discover()).length;
      } catch (err) {
        log('discover failed:', err.message);
      }
    }
    return { worker, relayTabs };
  }

  return { browserCall, gmStatus, workerStatus, discover };
}

const defaultClient = createGmClient();
export const browserCall = (op, args, opts) => defaultClient.browserCall(op, args, opts);
export const gmStatus = () => defaultClient.gmStatus();
