# Foundry MCP Server

Direct AI access to Foundry VTT via the [Model Context Protocol](https://modelcontextprotocol.io/). Connects Claude Code (or any MCP client) to a running Foundry VTT world through Socket.IO, providing 15 tools for document CRUD, search, compendium browsing, JavaScript execution, dice rolling, and more.

## Architecture

```
┌──────────────┐    stdio     ┌──────────────────┐  Socket.IO  ┌──────────────┐
│  Claude Code │◄────────────►│  MCP Server      │◄───────────►│  Foundry VTT │
│  (MCP Client)│    (SSH)     │  (Node.js)       │  localhost   │  (v12-v13)   │
└──────────────┘              └──────────────────┘              └──────┬───────┘
                                                                      │ socket relay
                                                               ┌──────▼───────┐
                                                               │  MCP Bridge  │
                                                               │  (browser    │
                                                               │   module)    │
                                                               └──────────────┘
```

**Two components:**

1. **`foundry-mcp-server/`** — Node.js MCP server. Authenticates with Foundry via HTTP + Socket.IO. Handles all document operations directly over the socket. Communicates with Claude Code via stdio (typically launched over SSH).

2. **`foundry-mcp-module/`** — Thin Foundry VTT module (~48 lines). Installed in the browser, listens on the socket relay channel `module.foundry-mcp-bridge`. Only needed for tools that require browser context: `foundry_exec_js`, `foundry_exec_macro`, `foundry_roll`, `foundry_files`.

## Prerequisites

- **Node.js** >= 18
- **Foundry VTT** v12 or v13 (tested on v13.351)
- **A running world** with a GM user
- **SSH access** to the Foundry server (if remote)
- **Claude Code** (or another MCP-compatible client)

## Project Structure

```
foundry-mcp/
├── foundry-mcp-server/
│   ├── server.mjs                 # Entry point (stdio MCP server)
│   ├── package.json
│   ├── .env                       # Connection config (create this)
│   ├── lib/
│   │   ├── config.mjs             # Environment/config loader
│   │   ├── foundry-socket.mjs     # Socket.IO client + auth
│   │   ├── tools/
│   │   │   ├── connection.mjs     # foundry_status
│   │   │   ├── documents.mjs      # foundry_get, _list, _create, _update, _delete
│   │   │   ├── search.mjs         # foundry_search
│   │   │   ├── compendiums.mjs    # foundry_packs, foundry_pack_contents
│   │   │   ├── exec.mjs           # foundry_exec_js, foundry_exec_macro
│   │   │   ├── dice.mjs           # foundry_roll
│   │   │   ├── combat.mjs         # foundry_combats
│   │   │   ├── files.mjs          # foundry_files
│   │   │   └── macros.mjs         # foundry_macros
│   │   └── resources/
│   │       └── world.mjs          # foundry://world resource
│   └── test/
│       └── smoke-test.mjs         # Connection + CRUD smoke test
│
└── foundry-mcp-module/
    ├── module.json                # Foundry module manifest
    └── scripts/
        └── mcp-bridge.mjs        # Browser-side exec-js relay
```

## Installation

### Step 1: Deploy the MCP Server

Copy or clone the repository to your Foundry server:

```bash
# If Foundry runs on a remote server
rsync -avz --exclude node_modules --exclude .env \
  foundry-mcp-server/ user@your-server:/path/to/foundry-mcp-server/

# Install dependencies on the server
ssh user@your-server "cd /path/to/foundry-mcp-server && npm install"
```

If Foundry runs locally, just install dependencies:

```bash
cd foundry-mcp-server
npm install
```

### Step 2: Configure the Server

Create a `.env` file in the `foundry-mcp-server/` directory:

```env
FOUNDRY_HOST=localhost
FOUNDRY_PORT=30000
FOUNDRY_USER_ID=<your-gm-user-id>
FOUNDRY_PASSWORD=
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FOUNDRY_HOST` | No | `localhost` | Foundry server hostname |
| `FOUNDRY_PORT` | No | `30000` | Foundry server port |
| `FOUNDRY_USER_ID` | **Yes** | — | The `_id` of a GM user |
| `FOUNDRY_PASSWORD` | No | `""` | User password (empty if none set) |

#### Finding your GM User ID

The user ID is a 16-character string like `EIwN2Llo20zGVLJ8`. You can find it by:

**Option A — Browser console** (if you can log in as GM):
```javascript
game.users.find(u => u.isGM)?.id
```

**Option B — Stop Foundry, read the database directly:**
```bash
# Stop Foundry first (LevelDB locks while running)
npm install classic-level  # temporary

node -e "
const { ClassicLevel } = require('classic-level');
const db = new ClassicLevel('/path/to/foundrydata/Data/worlds/your-world/data/users');
for await (const [key, value] of db.iterator()) {
  const user = JSON.parse(value);
  if (user.role === 4) console.log('GM:', user.name, user._id);
}
await db.close();
"
```

**Option C — Check the world's user database files** in `worlds/<world>/data/users/`.

### Step 3: Test the Connection

```bash
cd foundry-mcp-server
node server.mjs --test
```

Expected output:
```
[foundry-mcp] Testing Foundry connection...
[foundry-socket] Connecting to http://localhost:30000...
[foundry-socket] Got session cookie
[foundry-socket] Authenticated as EIwN2Llo20zGVLJ8 — status: success
[foundry-socket] Socket connected
[foundry-socket] Session authenticated, userId: EIwN2Llo20zGVLJ8
[foundry-socket] Connected — world: My World
[foundry-mcp] SUCCESS — Connected to: My World
[foundry-mcp] System: dnd5e 3.0.0
[foundry-mcp] Version: v13.351
[foundry-mcp] Users: Gamemaster
```

If the test fails, see [Troubleshooting](#troubleshooting).

### Step 4: Run the Smoke Test

```bash
npm test
```

This tests config validation, socket connection, actor listing, journal CRUD (create + delete), and optionally exec-js (requires the browser module + GM logged in).

### Step 5: Install the Browser Module (Optional)

The browser module is **only needed** for these tools:
- `foundry_exec_js` — Execute arbitrary JavaScript
- `foundry_exec_macro` — Run a macro
- `foundry_roll` — Roll dice via Foundry's Roll engine
- `foundry_files` — Browse the file system via FilePicker

All other tools (CRUD, search, compendiums, combats, macros list) work without it.

**Install via symlink:**

```bash
ln -s /path/to/foundry-mcp-module \
  /path/to/foundrydata/Data/modules/foundry-mcp-bridge
```

**Or copy the directory:**

```bash
cp -r foundry-mcp-module /path/to/foundrydata/Data/modules/foundry-mcp-bridge
```

Then enable the module in Foundry:
1. Log in as GM
2. Go to **Settings → Manage Modules**
3. Enable **Foundry MCP Bridge**
4. Save

> **Important:** The GM must be logged in with a browser for exec-js tools to work. The module runs client-side and relays script execution requests from the MCP server to the browser.

### Step 6: Register with Claude Code

Add the MCP server to Claude Code using the `claude mcp add` command:

**For a remote Foundry server (via SSH):**

```bash
claude mcp add --transport stdio --scope user foundry -- \
  ssh -i /path/to/your/key -o StrictHostKeyChecking=no \
  user@your-server \
  "cd /path/to/foundry-mcp-server && node server.mjs"
```

**For a local Foundry server:**

```bash
claude mcp add --transport stdio --scope user foundry -- \
  node /path/to/foundry-mcp-server/server.mjs
```

**Scope options:**
- `--scope user` — Available in all projects (stored in `~/.claude.json`)
- `--scope local` — Available only in the current project (default)
- `--scope project` — Shared via `.mcp.json` in the project root

After adding, **restart Claude Code** to connect to the new MCP server.

#### Verify in Claude Code

```
> What's the foundry_status?
```

Expected response: connected, world name, system, version, users.

### Managing the MCP Server

```bash
# List configured MCP servers
claude mcp list

# Remove the server
claude mcp remove foundry

# Re-add with different config
claude mcp add --transport stdio --scope user foundry -- ...
```

## Tools Reference

### Connection

#### `foundry_status`
Get connection status and world information.

**Parameters:** None

**Returns:** World title, system, version, users, pack count, modules.

---

### Documents

#### `foundry_get`
Retrieve a single document by type and ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Document type (see below) |
| `id` | string | Yes | Document `_id` |
| `pack` | string | No | Compendium pack ID |

**Supported types:** Actor, Item, JournalEntry, Scene, RollTable, Macro, Playlist, Folder, ChatMessage, Combat, Cards, Adventure

#### `foundry_list`
List all documents of a given type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Document type |
| `fields` | string[] | No | Dot-notation field paths to include (e.g., `["name", "system.attributes"]`) |
| `pack` | string | No | Compendium pack ID |

Always includes `_id` and `name`. Use `fields` to limit response size.

#### `foundry_create`
Create a new document.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Document type |
| `data` | object | Yes | Document data (must include `name`) |
| `pack` | string | No | Compendium pack ID |

#### `foundry_update`
Update an existing document (partial update — only include changed fields).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Document type |
| `id` | string | Yes | Document `_id` |
| `data` | object | Yes | Fields to update |
| `pack` | string | No | Compendium pack ID |

#### `foundry_delete`
Delete one or more documents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | Yes | Document type |
| `ids` | string[] | Yes | Array of `_id` values to delete |
| `pack` | string | No | Compendium pack ID |

---

### Search

#### `foundry_search`
Search documents by name and/or field values.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Case-insensitive substring search on `name` |
| `type` | string | No | Limit to one document type |
| `filters` | object | No | Exact-match key-value filters (dot-notation supported) |
| `limit` | number | No | Max results (default 20, max 100) |

Searches across: Actor, Item, JournalEntry, Scene, RollTable, Macro, Playlist, Cards.

---

### Compendiums

#### `foundry_packs`
List all compendium packs in the world.

**Parameters:** None

> **Note:** Returns 0 packs when using the socket protocol's `getJoinData` response (Foundry v13 limitation). Pack operations still work if you know the pack ID.

#### `foundry_pack_contents`
List documents in a compendium pack.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pack` | string | Yes | Pack ID (e.g., `"sta-compendia.talents-core"`) |
| `type` | string | Yes | Document type in the pack |
| `full` | boolean | No | Return full documents (default: index only) |

---

### JavaScript Execution

> **Requires:** `foundry-mcp-bridge` module installed + GM logged in with a browser.

#### `foundry_exec_js`
Execute JavaScript in the Foundry browser context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `script` | string | Yes | JavaScript code (use `return` for results) |
| `timeout` | number | No | Timeout in ms (default 30000, max 120000) |

The script is wrapped in a function body. Use `return` to send results back. You have full access to `game`, `canvas`, `ui`, and all Foundry APIs.

**Examples:**
```javascript
// Get world title
return game.world.title

// List all actors
return game.actors.contents.map(a => ({id: a.id, name: a.name, type: a.type}))

// Get a specific actor's data
return game.actors.get("abc123")?.toObject()
```

#### `foundry_exec_macro`
Execute a macro by name or ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No* | Macro name (case-insensitive) |
| `id` | string | No* | Macro `_id` |
| `args` | object | No | Arguments passed to macro scope |

*One of `name` or `id` is required.

---

### Dice

#### `foundry_roll`
Roll dice using Foundry's Roll engine.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `formula` | string | Yes | Dice notation (e.g., `"2d20"`, `"4d6kh3+2"`) |
| `flavor` | string | No | Label (if provided, posts to chat) |

> **Requires:** `foundry-mcp-bridge` module (uses browser-side Roll class).

---

### Combat

#### `foundry_combats`
List all active combat encounters with combatants.

**Parameters:** None

---

### Files

#### `foundry_files`
Browse the Foundry file system.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | No | Directory path (default `"/"`) |
| `source` | string | No | `"data"` (user data) or `"public"` (core assets) |

> **Requires:** `foundry-mcp-bridge` module (uses browser-side FilePicker).

---

### Macros

#### `foundry_macros`
List all macros in the world (name, type, truncated command).

**Parameters:** None

---

## Foundry v13 Protocol Details

This section documents the Foundry VTT v13 socket protocol, discovered through source analysis. Useful if you're debugging connection issues or building similar tools.

### Authentication Flow

```
1. GET /join
   → Response: Set-Cookie: session=<value>

2. POST /join
   Headers: Content-Type: application/json
            Cookie: session=<value>
   Body: {"action": "join", "userid": "<id>", "password": "<pwd>"}
   → Response: {"status": "success"} + possibly new Set-Cookie

3. Socket.IO connect
   URL: http://host:port
   Options: {
     query: { session: "<cookie-value>" },  // NOT Cookie header!
     transports: ['websocket', 'polling']
   }

4. Wait for 'session' event → confirms authentication

5. Emit 'getJoinData' with callback → receives world data snapshot
```

**Critical details:**
- The `action: "join"` field in POST body is **required** — Foundry dispatches on this field.
- Socket auth uses `query: { session }`, **not** the Cookie header. Foundry's SocketServer sets `cookie: false`.
- Foundry v13 uses a **pull model** for world data — there is no `world` push event. The client must emit `getJoinData` after the `session` event.

### modifyDocument Format

All document operations go through the socket `modifyDocument` event:

```javascript
socket.emit('modifyDocument', {
  action: 'get' | 'create' | 'update' | 'delete',
  type: 'Actor' | 'Item' | ...,
  operation: { ... }  // action-specific
}, callback);
```

**Operation shapes by action:**

| Action | Operation |
|--------|-----------|
| `get` | `{ query: { _id: "..." }, pack: "..." }` or `{ query: {} }` for all |
| `create` | `{ data: [{ name: "...", ... }], pack: "..." }` |
| `update` | `{ updates: [{ _id: "...", ...changes }], diff: true, pack: "..." }` |
| `delete` | `{ ids: ["id1", "id2"], pack: "..." }` |

### worldData Structure (from getJoinData)

```javascript
{
  world: {
    id: "my-world",
    title: "My World",
    system: "dnd5e",        // string, not an object
    systemVersion: "3.0.0",
    packs: [],              // empty in getJoinData response
    ...
  },
  release: {
    generation: 13,
    build: 351,
    ...
  },
  users: [
    { _id: "...", name: "Gamemaster", role: 4, ... },
    ...
  ],
  modules: [...]  // minimal — core translation modules only
}
```

## Troubleshooting

### Connection test fails with "Authentication failed"

- Verify `FOUNDRY_USER_ID` is correct (16-character alphanumeric string).
- Ensure the user exists in the world and has GM role (role 4).
- If the user has a password, set `FOUNDRY_PASSWORD` in `.env`.
- Make sure a world is running (not stuck on the setup screen).

### Connection test hangs or times out

- Check that Foundry is running and accessible: `curl http://localhost:30000/join`
- If remote, verify the port is correct and not firewalled.
- Check if another client is consuming the connection (Foundry has user limits).

### MCP tools don't appear in Claude Code

- MCP servers must be added via `claude mcp add`, which stores config in `~/.claude.json` (user scope) or project `.mcp.json` (project scope). **Do not** manually add to `~/.claude/settings.json` — that file is for app settings only.
- After adding or changing MCP config, **restart Claude Code** completely.
- Test the server manually: `ssh ... "cd /path && node server.mjs --test"`
- The MCP stdio transport must start **before** any slow operations (like connecting to Foundry). If you modify `server.mjs`, ensure `server.connect(transport)` runs before `foundrySocket.connect()`.

### exec-js times out or returns errors

- The `foundry-mcp-bridge` module must be installed **and enabled** in the world.
- A GM user must be **logged in with a browser** — the module runs client-side.
- Check the browser console for errors (`F12` → Console tab).
- The module only processes requests when `game.user.isGM` is true.

### `foundry_packs` returns 0

This is expected. Foundry v13's `getJoinData` response does not include compendium pack metadata. Pack operations (`foundry_pack_contents`, CRUD with `pack` parameter) still work if you know the pack ID. You can discover pack IDs via `foundry_exec_js`:

```javascript
return game.packs.map(p => ({id: p.metadata.id, label: p.metadata.label, type: p.metadata.type}))
```

### LevelDB errors when reading user database

Foundry locks its LevelDB files while running. Stop Foundry before reading databases directly. Use `classic-level` (not the `fvtt` CLI, which has a known bug with `Iterator is not open`).

### Socket disconnects unexpectedly

- Foundry may disconnect idle sockets. The MCP server has built-in reconnection (5 attempts, 1-10s backoff).
- If Foundry restarts (e.g., world change), the MCP server will need to be restarted too.

## Deploying Updates

When you modify the MCP server code locally:

```bash
# Deploy to remote server (exclude .env to preserve server config)
rsync -avz --delete --exclude node_modules --exclude .env \
  -e "ssh -i /path/to/key" \
  foundry-mcp-server/ user@server:/path/to/foundry-mcp-server/

# If you added new dependencies
ssh user@server "cd /path/to/foundry-mcp-server && npm install"

# Restart Claude Code to reconnect
# (The MCP server process is managed by Claude Code's stdio transport)
```

> **Warning:** Do not use `rsync --delete` without `--exclude .env` — it will delete the server's environment config.

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.12.1 | MCP protocol (stdio transport, tool registration) |
| `socket.io-client` | ^4.8.1 | Socket.IO client for Foundry VTT |
| `zod` | ^3.24.0 | Input schema validation for tool parameters |

## License

ISC
