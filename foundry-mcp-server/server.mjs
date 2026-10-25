#!/usr/bin/env node
/**
 * Foundry MCP Server
 *
 * Provides 15 MCP tools for direct access to a Foundry VTT world
 * via Socket.IO. Runs over stdio (spawned by Claude Code via SSH).
 *
 * Usage:
 *   node server.mjs              # Normal operation (stdio)
 *   node server.mjs --test       # Test socket connection only
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { validateConfig } from './lib/config.mjs';
import { foundrySocket } from './lib/foundry-socket.mjs';

// Tool registrations
import { registerConnectionTools } from './lib/tools/connection.mjs';
import { registerDocumentTools } from './lib/tools/documents.mjs';
import { registerSearchTools } from './lib/tools/search.mjs';
import { registerCompendiumTools } from './lib/tools/compendiums.mjs';
import { registerExecTools } from './lib/tools/exec.mjs';
import { registerDiceTools } from './lib/tools/dice.mjs';
import { registerCombatTools } from './lib/tools/combat.mjs';
import { registerFileTools } from './lib/tools/files.mjs';
import { registerMacroTools } from './lib/tools/macros.mjs';
import { registerWorldResource } from './lib/resources/world.mjs';

const log = (...args) => console.error('[foundry-mcp]', ...args);

// ── Connection test mode ─────────────────────────────────────
if (process.argv.includes('--test')) {
  log('Testing Foundry connection...');
  try {
    validateConfig();
    const worldData = await foundrySocket.connect();
    log('SUCCESS — Connected to:', worldData?.world?.title);
    log('System:', worldData?.world?.system, worldData?.world?.systemVersion);
    log('Version:', `v${worldData?.release?.generation}.${worldData?.release?.build}`);
    log('Users:', (worldData?.users || []).map(u => u.name).join(', '));
    foundrySocket.disconnect();
    process.exit(0);
  } catch (err) {
    log('FAILED:', err.message);
    process.exit(1);
  }
}

// ── MCP Server ───────────────────────────────────────────────
const server = new McpServer({
  name: 'foundry-mcp-server',
  version: '1.0.0',
});

// Register all tools
registerConnectionTools(server);
registerDocumentTools(server);
registerSearchTools(server);
registerCompendiumTools(server);
registerExecTools(server);
registerDiceTools(server);
registerCombatTools(server);
registerFileTools(server);
registerMacroTools(server);

// Register resources
registerWorldResource(server);

// ── Shutdown ─────────────────────────────────────────────────
// Over SSH the client going away only closes stdin; socket.io's reconnect timers
// would otherwise keep this process alive as an orphan holding a GM socket.
let stopping = false;
function shutdown(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  log('Shutting down:', reason);
  const deadline = setTimeout(() => process.exit(code), 1500);
  deadline.unref();
  try {
    foundrySocket.disconnect();
  } finally {
    process.exit(code);
  }
}

process.stdin.once('end', () => shutdown('stdin end'));
process.stdin.once('close', () => shutdown('stdin close'));
process.stdin.once('error', (err) => shutdown(`stdin error: ${err.code || err.message}`, 1));
process.stdout.on('error', (err) => shutdown(`stdout error: ${err.code || err.message}`, 1));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => shutdown(signal));
}
// Belt and braces: if the SSH session dies without an EOF we get re-parented to init.
setInterval(() => {
  if (process.ppid === 1) shutdown('parent exited');
}, 30000).unref();

// ── Startup ──────────────────────────────────────────────────
async function main() {
  // Validate config
  try {
    validateConfig();
  } catch (err) {
    log('Config error:', err.message);
    process.exit(1);
  }

  // Start MCP stdio transport FIRST — Claude Code needs a quick response
  const transport = new StdioServerTransport();
  transport.onclose = () => shutdown('transport closed');
  await server.connect(transport);
  log('MCP server running via stdio');

  // Connect to Foundry in the background (tools will wait or report errors)
  try {
    log('Connecting to Foundry VTT...');
    const worldData = await foundrySocket.connect();
    log('Connected to world:', worldData?.world?.title);
  } catch (err) {
    log('WARNING: Failed to connect to Foundry:', err.message);
    log('Tools will return errors until connection is established.');
  }
}

main().catch((err) => {
  log('Fatal error:', err.message);
  process.exit(1);
});
