# GM client contract (v2)

Interfaces between the four parts of the hardened Foundry MCP stack. **Every part must implement exactly
this.** If a part needs something more, change this document first.

```
Claude/Codex ──stdio/ssh──▶ MCP server (Node, root) ──Socket.IO (GM user)──▶ Foundry v13.351
                                │                                              ▲
                                │ unix socket (NDJSON)                          │ browser session
                                ▼                                              │
                        foundry-headless-gm (Node + Playwright, user foundry-gm) ─┘
                                         page.evaluate → globalThis.foundryMcpBridge.dispatch()
                                │
                                └─ fallback when the worker isn't ready: Foundry socket relay
                                   (channel module.foundry-mcp-bridge) → a human GM tab's bridge
```

| Part | Path | Owner |
|---|---|---|
| Bridge module `foundry-mcp-bridge` v2.0.0 | `foundry-mcp-module/` | MCP/bridge builder |
| MCP server | `foundry-mcp-server/` | MCP/bridge builder |
| Headless GM service | `foundry-headless-gm/` | worker builder |
| Paranoia companion module | `~/repos/paranoia/foundry/paranoia-companion/` | companion builder |

## 1. Bridge dispatch API (in every GM client)

At `ready`, if `game.user.isGM`, the bridge sets:

```js
globalThis.foundryMcpBridge = {
  version: "2.0.0",
  tabId,                         // foundry.utils.randomID(16), fixed for the life of the page
  dispatch(op, args) → Promise<JSON-serialisable result>   // throws Error on failure
};
```

Non-GM clients never define it. Results must be JSON-serialisable (use `doc.toObject()`, never live documents).

| op | args | returns |
|---|---|---|
| `info` | `{}` | `{ worldId, worldTitle, systemId, systemVersion, coreVersion, userId, userName, userRole, isGM, tabId, bridgeVersion, ready: game.ready }` |
| `exec` | `{ script: string }` | The value the script `return`s. Run as the body of an `AsyncFunction` (top-level `await` allowed), with no extra arguments. |
| `create` | `{ type: string, data: object \| object[], parent?: uuid, pack?: string, options?: object }` | `{ documents: [doc.toObject(), …] }`. World docs: `getDocumentClass(type).createDocuments(arr, {pack, ...options})`. Embedded: `(await fromUuid(parent)).createEmbeddedDocuments(type, arr, options)`. Throws if the parent isn't found or nothing was created (creation cancelled by a hook). |
| `roll` | `{ formula: string, flavor?: string, toChat?: boolean, speakerAlias?: string, rollMode?: string }` | `{ formula, total, dice: [{ faces, results: [{result, success?, active}] }], messageId? }`. Dice must include dice nested inside parenthetical terms (`roll.dice` covers them in v13). |

`dispatch` validates `op` against this table and throws `Unknown op` otherwise. It never reads `args`
through `eval` or string interpolation (except `exec`, which is the whole point of exec).

## 2. Relay protocol (Foundry socket, channel `module.foundry-mcp-bridge`)

Used only when the headless worker isn't ready. Foundry calls listeners as `(data, senderId)`, where
`senderId` is attached by the server and can't be forged. Any logged-in user can emit on the channel, so:

- The bridge **ignores every message unless `game.users.get(senderId)?.isGM`**.
- The bridge **no longer executes the legacy `{type: "exec-js"}` message** (log and ignore).
- Replies go only to the requester: `game.socket.emit(channel, payload, {recipients: [senderId]})`.

| Direction | Payload |
|---|---|
| MCP → all | `{ type: "discover", requestId }` |
| GM tab → MCP | `{ type: "discover-reply", requestId, tabId, userId, userName, bridgeVersion, worldId }` |
| MCP → all | `{ type: "call", requestId, executor: <tabId>, op, args, timeoutMs }`. Only the tab whose `tabId === executor` runs it. |
| GM tab → MCP | `{ type: "result", requestId, tabId, success: true, result }` or `{ …, success: false, error: string }` |

On the MCP side, accept a reply only if its `senderId` is a GM user in the current world's user list and
its `requestId` is pending. For `discover`, collect replies for 1500 ms and pick the first `discover-reply`,
so a given request is executed by one tab only.

## 3. Worker IPC (unix socket)

- Path: `/run/foundry-gm/gm.sock` (systemd `RuntimeDirectory=foundry-gm`), mode `0660`, owner `foundry-gm`,
  group `foundry-gm`. The MCP server runs as root, so it can always connect. Override with env `FOUNDRY_GM_SOCKET`.
- Framing: newline-delimited JSON, one request per line, one response per line. A connection may carry
  several requests, and responses may arrive out of order (match on `id`).

Request: `{ id: string, op: "status" | "call", args?: object, expectWorld?: string, timeoutMs?: number }`

- `status`: no args. Never queued.
- `call`: `args = { op, args }`, forwarded to `page.evaluate(({op, args}) => globalThis.foundryMcpBridge.dispatch(op, args))`.

Response: `{ id, ok: true, result, meta: { worldId, userId, userName, tabId, generation } }` or
`{ id, ok: false, error: string, code, meta? }`

`status` result:
`{ state: "starting"|"no-world"|"joining"|"ready"|"no-user"|"error", worldId?, worldTitle?, systemId?, userId?, userName?, generation, since: ISO8601, lastError? }`.
`generation` increments on every successful (re)join.

| code | meaning |
|---|---|
| `NOT_READY` | No ready GM page (starting, joining, no world, no user, error) |
| `WRONG_WORLD` | `expectWorld` given and differs from the loaded world |
| `TIMEOUT` | The call exceeded `timeoutMs` (default 30000, max 120000). **The call may still have run**, so the worker never retries. |
| `EXEC_ERROR` | `dispatch` threw. `error` carries the message. |
| `BUSY` | The queue is full (more than 50 waiting) |
| `BAD_REQUEST` | Malformed JSON or unknown op |

`call`s run **one at a time, in order**. A crash or page reload fails in-flight calls with `NOT_READY`
and never replays them.

## 4. MCP server routing

A single seam in `lib/gm-client.mjs`:

```js
browserCall(op, args, { timeoutMs }) → { result, via: "worker" | "relay", meta }
```

1. If the worker socket exists and `status.state === "ready"` and `status.worldId === <current world id>`,
   send a `call` to the worker with `expectWorld`.
2. Otherwise run relay `discover` → `call` against one human GM tab.
3. Otherwise throw: `No GM client available: start foundry-headless-gm on the server, or open the world as GM in a browser.`

Tool behaviour:

| Tool | Path |
|---|---|
| `foundry_exec_js`, `foundry_exec_macro` | `browserCall("exec")` |
| `foundry_roll` | `browserCall("roll")` |
| `foundry_create` | Actor and Item (and any create with `parent`) → `browserCall("create")`. **No silent fallback:** without a GM client it errors, unless the caller passes `raw: true` (new optional boolean), which uses the socket `modifyDocument` and returns `warning: "raw create: system defaults and creation hooks not applied"`. Other types use the socket as today. The response always includes `via`. |
| `foundry_files` | Try the socket `manageFiles` (`{action: "browseFiles", storage, target}`) first, then `browserCall("exec")` |
| `foundry_packs`, `foundry_pack_contents` | Try the socket first (pack list from world data; `modifyDocument get` with `pack` and an index), then `browserCall` |
| `foundry_status` | Adds `gmClient: { worker: <status or null>, relayTabs: <count from a discover> }` |

Login: if `FOUNDRY_USER_ID` isn't a user in the active world, resolve the id from `FOUNDRY_USER_NAME` via
the `/join` page's user list, so world switches don't break the MCP login.

## 5. Headless GM service (`foundry-headless-gm`)

- Runs as system user `foundry-gm` under systemd (`foundry-headless-gm.service`), `Restart=always`,
  `MemoryMax=1200M`. Config in `/etc/foundry-headless-gm.env` (root:foundry-gm 0640):
  `FOUNDRY_URL=http://127.0.0.1:30000`, `GM_USER_NAME=Friend Computer`, `GM_PASSWORD=…`, `FOUNDRY_GM_SOCKET`.
- The Foundry user "Friend Computer" has role **ASSISTANT (3)** in each world, so `game.users.activeGM`
  still prefers a human GAMEMASTER when one is present. A world without that user → state `no-user`, idle.
- Uses Playwright `chromium-headless-shell`. Before navigation: `localStorage.setItem("core.noCanvas", "true")`
  via `addInitScript` (client setting, JSON value), so no WebGL is needed.
- Watchdog every 15 s:
  1. `GET /api/status`. If no world is active → `no-world`, close the page.
  2. If the world differs from the loaded one, or the page isn't `game.ready`, or `game.user.name !== GM_USER_NAME` → (re)join:
     open `/join`, find the user id by name in the user select, log in through the form, wait for
     `game.ready && globalThis.foundryMcpBridge`.
- **Never** opens `/setup`, never launches or switches worlds, and never handles the admin password.
- CLI: `node headless-gm.mjs --once` joins, prints the `status` JSON and `info`, and exits non-zero on
  failure (for debugging).
- Logs are structured JSON lines on stdout (journald).

## 6. Paranoia companion module (`paranoia-companion`)

Separate from the bridge (gameplay, not tooling). Not `library: true`, so it loads after the system.
Requires the `paranoia` system. At `init` it:

- Aliases `CONFIG.Actor.dataModels.accomplice` to `acomplice` when the former is missing (a no-op once
  upstream fixes the typo).
- Extends `CONFIG.Actor.documentClass`: `prepareDerivedData` sets `system.securityClearance` from a robust
  resolver (flag `paranoia-companion.clearance` override → right-anchored name parse → 0). It also
  overrides `updateSecurityClearanceFromName` to use the same resolver.
- Extends `CONFIG.Combatant.documentClass`: initiative = 99 if the actor is flagged as The Computer, else
  clearance + jumps (combatant flag `paranoia-companion.jumps`, 0–5). It sets initiative on
  `preCreateCombatant` and adds combat tracker context entries (`getCombatantContextOptions`):
  "Jump one clearance (−1 NODE)", "Reset jumps", "Toggle: The Computer".
