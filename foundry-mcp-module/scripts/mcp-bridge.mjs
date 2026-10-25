/**
 * Foundry MCP Bridge Module (v2)
 *
 * Exposes `globalThis.foundryMcpBridge` in GM clients. Two callers use it:
 *   - the headless GM worker, via page.evaluate -> dispatch()
 *   - the MCP server's socket relay (fallback when no worker is ready), via the
 *     `module.foundry-mcp-bridge` socket channel, answered only by the tab whose
 *     tabId matches the request's executor.
 *
 * Contract: docs/gm-client-contract.md sections 1-2.
 */

const MODULE_ID = 'foundry-mcp-bridge';
const CHANNEL = `module.${MODULE_ID}`;
const VERSION = '2.0.0';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Round-trip through JSON so callers never receive live documents or undefined. */
function plain(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

const OPS = {
  info() {
    return {
      worldId: game.world.id,
      worldTitle: game.world.title,
      systemId: game.system.id,
      systemVersion: game.system.version,
      coreVersion: game.version,
      userId: game.user.id,
      userName: game.user.name,
      userRole: game.user.role,
      isGM: game.user.isGM,
      tabId: globalThis.foundryMcpBridge.tabId,
      bridgeVersion: VERSION,
      ready: game.ready,
    };
  },

  async exec({ script } = {}) {
    if (typeof script !== 'string') throw new Error('exec requires a string "script"');
    return plain(await new AsyncFunction(script)());
  },

  async create({ type, data, parent, pack, options } = {}) {
    if (typeof type !== 'string' || !type) throw new Error('create requires a string "type"');
    if (!data || typeof data !== 'object') throw new Error('create requires "data" (object or array)');
    const arr = Array.isArray(data) ? data : [data];
    let created;
    if (parent) {
      const parentDoc = await fromUuid(parent);
      if (!parentDoc) throw new Error(`Parent not found: ${parent}`);
      created = await parentDoc.createEmbeddedDocuments(type, arr, options ?? {});
    } else {
      const cls = foundry.utils.getDocumentClass(type);
      created = await cls.createDocuments(arr, { ...(options ?? {}), ...(pack ? { pack } : {}) });
    }
    // A preCreate hook returning false yields an empty array rather than an error.
    if (!created?.length) throw new Error(`Nothing was created (creation may have been cancelled by a hook)`);
    return { documents: created.map((d) => d.toObject()) };
  },

  async roll({ formula, flavor, toChat, speakerAlias, rollMode } = {}) {
    if (typeof formula !== 'string' || !formula) throw new Error('roll requires a string "formula"');
    const roll = await new Roll(formula).evaluate();
    let messageId;
    if (toChat) {
      const speaker = speakerAlias ? { alias: speakerAlias } : ChatMessage.getSpeaker();
      const message = await roll.toMessage({ flavor, speaker }, rollMode ? { rollMode } : {});
      messageId = message?.id;
    }
    return {
      formula: roll.formula,
      total: roll.total,
      // roll.dice includes dice nested in parenthetical terms in v13
      dice: roll.dice.map((d) => ({
        faces: d.faces,
        results: d.results.map((r) => {
          const out = { result: r.result, active: r.active };
          if (r.success !== undefined) out.success = r.success;
          return out;
        }),
      })),
      ...(messageId ? { messageId } : {}),
    };
  },
};

async function dispatch(op, args) {
  if (!Object.hasOwn(OPS, op)) throw new Error(`Unknown op: ${op}`);
  return OPS[op](args ?? {});
}

Hooks.once('ready', () => {
  // Non-GM clients never expose the bridge or listen on the channel.
  if (!game.user.isGM) return;

  const tabId = foundry.utils.randomID(16);
  globalThis.foundryMcpBridge = { version: VERSION, tabId, dispatch };

  console.log(`${MODULE_ID} | Ready (v${VERSION}, tab ${tabId})`);

  // Foundry calls socket listeners as (data, senderId); the server attaches senderId.
  // Any logged-in user can emit on this channel, so every message is checked.
  game.socket.on(CHANNEL, async (data, senderId) => {
    if (!game.users.get(senderId)?.isGM) {
      console.warn(`${MODULE_ID} | Ignored message from non-GM sender ${senderId}`);
      return;
    }
    // The reply goes only to the requester, never broadcast to every client.
    const reply = (payload) => game.socket.emit(CHANNEL, payload, { recipients: [senderId] });

    switch (data?.type) {
      case 'discover':
        if (!data.requestId) return;
        reply({
          type: 'discover-reply',
          requestId: data.requestId,
          tabId,
          userId: game.user.id,
          userName: game.user.name,
          bridgeVersion: VERSION,
          worldId: game.world.id,
        });
        break;

      case 'call':
        if (!data.requestId || data.executor !== tabId) return;
        try {
          const result = await dispatch(data.op, data.args);
          reply({ type: 'result', requestId: data.requestId, tabId, success: true, result: plain(result) });
        } catch (err) {
          console.error(`${MODULE_ID} | ${data.op} failed:`, err);
          reply({ type: 'result', requestId: data.requestId, tabId, success: false, error: err.message });
        }
        break;

      case 'exec-js':
        console.warn(`${MODULE_ID} | Ignored legacy exec-js message from ${senderId}; use call/exec`);
        break;

      default:
        break;
    }
  });
});
