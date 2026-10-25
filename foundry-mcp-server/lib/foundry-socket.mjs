/**
 * Foundry VTT Socket.IO Client
 *
 * Authenticates to Foundry via the /join flow and maintains a socket.io
 * connection for document CRUD, dice rolls, file browsing, etc.
 *
 * Auth flow (Foundry v13):
 *   1. GET /join → extract session cookie
 *   2. POST /join with userId + password + session cookie → authenticated session
 *   3. Connect socket.io with session cookie
 *   4. Wait for 'world' event → worldData snapshot
 */

import { io } from 'socket.io-client';
import { config, getFoundryUrl } from './config.mjs';
import { parseJoinUsers, pickUserId } from './join-users.mjs';

export const RELAY_CHANNEL = 'module.foundry-mcp-bridge';
const GM_ROLE = 3; // ASSISTANT; Foundry's User#isGM is role >= ASSISTANT

const log = (...args) => console.error('[foundry-socket]', ...args);

export class FoundrySocket {
  #socket = null;
  #sessionCookie = null;
  #worldData = null;
  #connected = false;
  #reconnectAttempts = 0;
  #maxReconnectAttempts = 5;
  #relayListeners = new Set(); // fn(data, senderId)
  #userId = '';

  get connected() { return this.#connected; }
  get worldData() { return this.#worldData; }

  /**
   * Full auth + connect flow.
   * Returns the worldData snapshot on success.
   */
  async connect() {
    const baseUrl = getFoundryUrl();
    log(`Connecting to ${baseUrl}...`);

    // Step 1: GET /join to get session cookie
    const joinPageRes = await fetch(`${baseUrl}/join`, {
      redirect: 'manual',
    });

    // Extract session cookie from Set-Cookie header
    const setCookie = joinPageRes.headers.get('set-cookie') || '';
    const joinHtml = await joinPageRes.text().catch(() => '');
    const sessionMatch = setCookie.match(/session=([^;]+)/);
    if (!sessionMatch) {
      // If we got redirected to /game, the world is already active — try /game
      const gameRes = await fetch(`${baseUrl}/game`, { redirect: 'manual' });
      const gameCookie = (gameRes.headers.get('set-cookie') || '').match(/session=([^;]+)/);
      if (!gameCookie) {
        throw new Error('Could not extract session cookie from /join or /game');
      }
      this.#sessionCookie = gameCookie[1];
    } else {
      this.#sessionCookie = sessionMatch[1];
    }

    log('Got session cookie');

    // World switches change user ids, so re-resolve the login from the user list on /join.
    this.#userId = pickUserId(parseJoinUsers(joinHtml), config);
    if (this.#userId !== config.userId) log(`Resolved user "${config.userName}" -> ${this.#userId}`);

    // Step 2: POST /join to authenticate
    const joinRes = await fetch(`${baseUrl}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session=${this.#sessionCookie}`,
      },
      body: JSON.stringify({
        action: 'join',
        userid: this.#userId,
        password: config.password || '',
      }),
      redirect: 'manual',
    });

    // Foundry returns 200 with JSON on success, or 302/303 redirect
    const joinBody = await joinRes.json().catch(() => null);
    if (joinBody?.status === 'failed') {
      throw new Error(`POST /join auth failed: ${joinBody.message || JSON.stringify(joinBody)}`);
    }
    if (joinRes.status !== 200 && joinRes.status !== 303 && joinRes.status !== 302) {
      throw new Error(`POST /join failed (${joinRes.status})`);
    }

    // Update session cookie if a new one was set
    const joinSetCookie = joinRes.headers.get('set-cookie') || '';
    const newSession = joinSetCookie.match(/session=([^;]+)/);
    if (newSession) {
      this.#sessionCookie = newSession[1];
    }

    log('Authenticated as', this.#userId, '— status:', joinBody?.status || joinRes.status);

    // Step 3: Connect socket.io
    await this.#connectSocket(baseUrl);

    return this.#worldData;
  }

  #connectSocket(baseUrl) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Socket connection timed out (30s)'));
      }, 30000);

      this.#socket = io(baseUrl, {
        path: '/socket.io',
        transports: ['websocket', 'polling'],
        // Foundry uses query.session (not cookies) for socket auth
        query: { session: this.#sessionCookie },
        reconnection: true,
        reconnectionAttempts: this.#maxReconnectAttempts,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
      });

      this.#socket.on('connect', () => {
        log('Socket connected');
      });

      // Foundry v13: session event confirms auth, then we request world data
      this.#socket.once('session', (sessionData) => {
        if (!sessionData?.userId) {
          clearTimeout(timeout);
          reject(new Error('Socket session not authenticated (userId is null). Check FOUNDRY_USER_ID/FOUNDRY_USER_NAME and FOUNDRY_PASSWORD.'));
          return;
        }
        log('Session authenticated, userId:', sessionData.userId);

        // Request world data via getJoinData (Foundry v13 pull model)
        this.#socket.emit('getJoinData', (data) => {
          clearTimeout(timeout);
          if (!data || !data.world) {
            reject(new Error('getJoinData returned no world data'));
            return;
          }
          this.#worldData = data;
          this.#connected = true;
          this.#reconnectAttempts = 0;
          log('Connected — world:', data.world?.title || 'unknown');
          resolve(data);
        });
      });

      this.#socket.on('disconnect', (reason) => {
        this.#connected = false;
        log('Disconnected:', reason);
      });

      this.#socket.on('reconnect', (attempt) => {
        log('Reconnected after', attempt, 'attempts');
        this.#connected = true;
      });

      this.#socket.on('reconnect_failed', () => {
        this.#connected = false;
        log('Reconnect failed after max attempts');
      });

      this.#socket.on('connect_error', (err) => {
        clearTimeout(timeout);
        log('Connection error:', err.message);
        if (!this.#connected) {
          reject(new Error(`Socket connection failed: ${err.message}`));
        }
      });

      // Relay messages from GM browser tabs. Foundry passes (data, senderId); the
      // server attaches senderId, so listeners can trust it (but must still check it is a GM).
      this.#socket.on(RELAY_CHANNEL, (data, senderId) => {
        for (const fn of this.#relayListeners) {
          try { fn(data, senderId); } catch (err) { log('Relay listener error:', err.message); }
        }
      });
    });
  }

  /**
   * Core document operation via Foundry's modifyDocument socket event.
   *
   * Foundry v13 format: { action, type, operation: { ... } }
   * The operation object varies by action:
   *   get:    { query, pack }
   *   create: { data: [...], pack }
   *   update: { updates: [...], diff, pack }
   *   delete: { ids: [...], pack }
   *
   * @param {string} action - 'get' | 'create' | 'update' | 'delete'
   * @param {string} type - Document type ('Actor', 'Item', 'JournalEntry', etc.)
   * @param {Object} operation - Action-specific operation object
   * @returns {Promise<any>} - Response from Foundry
   */
  async modifyDocument(action, type, operation = {}) {
    this.#ensureConnected();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`modifyDocument ${action} ${type} timed out (30s)`));
      }, 30000);

      this.#socket.emit('modifyDocument', {
        action,
        type,
        operation,
      }, (response) => {
        clearTimeout(timeout);
        if (response?.error) {
          reject(new Error(response.error.message || JSON.stringify(response.error)));
        } else {
          resolve(response?.result ?? response);
        }
      });
    });
  }

  /**
   * Execute a script in a GM browser client. Thin wrapper over gm-client's
   * browserCall("exec"); kept for the test scripts. Imported lazily because
   * gm-client imports this module.
   */
  async execJs(script, timeoutMs = 30000) {
    const { browserCall } = await import('./gm-client.mjs');
    return (await browserCall('exec', { script }, { timeoutMs })).result;
  }

  /** Send a relay message to the other clients (never echoed back to us). */
  emitRelay(payload) {
    this.#ensureConnected();
    this.#socket.emit(RELAY_CHANNEL, payload);
  }

  /** Subscribe to relay messages as fn(data, senderId). Returns an unsubscribe function. */
  onRelay(fn) {
    this.#relayListeners.add(fn);
    return () => this.#relayListeners.delete(fn);
  }

  /** True if userId is a GM (role >= 3) in the world's user list from getJoinData. */
  isGmUser(userId) {
    const user = (this.#worldData?.users || []).find((u) => u._id === userId);
    return !!user && user.role >= GM_ROLE;
  }

  /**
   * Emit an event whose server handler takes several arguments before the
   * callback, e.g. manageFiles(data, options, callback).
   */
  async emitWithAck(event, ...args) {
    this.#ensureConnected();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Socket emit '${event}' timed out (30s)`));
      }, 30000);

      this.#socket.emit(event, ...args, (response) => {
        clearTimeout(timeout);
        if (response?.error) {
          reject(new Error(response.error.message || (typeof response.error === 'string' ? response.error : JSON.stringify(response.error))));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * Emit a raw socket event (for dice rolls, file browsing, etc.)
   */
  async emit(event, data) {
    this.#ensureConnected();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Socket emit '${event}' timed out (30s)`));
      }, 30000);

      this.#socket.emit(event, data, (response) => {
        clearTimeout(timeout);
        if (response?.error) {
          reject(new Error(response.error.message || JSON.stringify(response.error)));
        } else {
          resolve(response);
        }
      });
    });
  }

  /**
   * Disconnect the socket.
   */
  disconnect() {
    if (this.#socket) {
      this.#socket.disconnect();
      this.#socket = null;
    }
    this.#connected = false;
    this.#worldData = null;
  }

  #ensureConnected() {
    if (!this.#connected || !this.#socket) {
      throw new Error('Not connected to Foundry. Call connect() first.');
    }
  }
}

// Singleton instance
export const foundrySocket = new FoundrySocket();
