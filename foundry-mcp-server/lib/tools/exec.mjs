/**
 * Execution tools: foundry_exec_js, foundry_exec_macro
 *
 * These tools use the foundry-mcp-bridge module running in the GM's browser
 * to execute JavaScript in the full Foundry browser context (with access to
 * game.*, canvas.*, ui.*, etc.)
 */

import { z } from 'zod';
import { foundrySocket } from '../foundry-socket.mjs';

export function registerExecTools(server) {

  // ── foundry_exec_js ────────────────────────────────────────
  server.registerTool(
    'foundry_exec_js',
    {
      title: 'Execute JavaScript in Foundry',
      description:
        'Execute arbitrary JavaScript code in the Foundry VTT browser context. ' +
        'The code runs in the GM\'s browser with full access to the game.* API.\n\n' +
        'The script is wrapped in a function body — use "return" to send values back.\n\n' +
        'Args:\n' +
        '  - script: JavaScript code to execute. Use "return" for results.\n' +
        '  - timeout: Timeout in ms (default 30000)\n\n' +
        'Examples:\n' +
        '  - "return game.world.title"\n' +
        '  - "return game.actors.contents.map(a => ({id: a.id, name: a.name}))"\n' +
        '  - "return game.users.find(u => u.isGM)?.name"\n\n' +
        'Requires: foundry-mcp-bridge module installed and GM logged in.',
      inputSchema: {
        script: z.string().describe('JavaScript code to execute (use "return" for results)'),
        timeout: z.number().int().min(1000).max(120000).default(30000)
          .describe('Timeout in milliseconds'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ script, timeout }) => {
      try {
        const result = await foundrySocket.execJs(script, timeout);
        return {
          content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `exec-js error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── foundry_exec_macro ─────────────────────────────────────
  server.registerTool(
    'foundry_exec_macro',
    {
      title: 'Execute Foundry Macro',
      description:
        'Execute an existing macro by name or ID in the Foundry VTT browser context.\n\n' +
        'Args:\n' +
        '  - name: Macro name (searched case-insensitive)\n' +
        '  - id: Macro _id (alternative to name)\n' +
        '  - args: Optional arguments object passed to the macro scope\n\n' +
        'Requires: foundry-mcp-bridge module installed and GM logged in.',
      inputSchema: {
        name: z.string().optional().describe('Macro name (case-insensitive search)'),
        id: z.string().optional().describe('Macro _id (alternative to name)'),
        args: z.record(z.any()).optional().describe('Arguments to pass to macro scope'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, id, args }) => {
      if (!name && !id) {
        return {
          content: [{ type: 'text', text: 'Error: Provide either "name" or "id" for the macro' }],
          isError: true,
        };
      }

      const script = id
        ? `
          const macro = game.macros.get("${id}");
          if (!macro) throw new Error("Macro not found: ${id}");
          return await macro.execute(${JSON.stringify(args || {})});
        `
        : `
          const macro = game.macros.find(m => m.name.toLowerCase() === "${name.toLowerCase()}");
          if (!macro) throw new Error("Macro not found: ${name}");
          return await macro.execute(${JSON.stringify(args || {})});
        `;

      try {
        const result = await foundrySocket.execJs(script);
        return {
          content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `exec-macro error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
