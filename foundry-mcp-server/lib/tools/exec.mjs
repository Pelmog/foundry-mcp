/**
 * Execution tools: foundry_exec_js, foundry_exec_macro
 *
 * These tools run JavaScript in a GM browser client (the headless GM worker, or a
 * human GM tab via the foundry-mcp-bridge relay) with access to game.*, canvas.*, ui.*.
 */

import { z } from 'zod';
import { browserCall as defaultBrowserCall } from '../gm-client.mjs';

export function registerExecTools(server, { browserCall = defaultBrowserCall } = {}) {

  // ── foundry_exec_js ────────────────────────────────────────
  server.registerTool(
    'foundry_exec_js',
    {
      title: 'Execute JavaScript in Foundry',
      description:
        'Execute arbitrary JavaScript code in the Foundry VTT browser context. ' +
        'The code runs in a GM browser client (headless worker or a GM tab) with full access to the game.* API.\n\n' +
        'The script is wrapped in a function body — use "return" to send values back.\n\n' +
        'Args:\n' +
        '  - script: JavaScript code to execute. Use "return" for results.\n' +
        '  - timeout: Timeout in ms (default 30000)\n\n' +
        'Examples:\n' +
        '  - "return game.world.title"\n' +
        '  - "return game.actors.contents.map(a => ({id: a.id, name: a.name}))"\n' +
        '  - "return game.users.find(u => u.isGM)?.name"\n\n' +
        'Requires a GM client: foundry-headless-gm, or the world open as GM with foundry-mcp-bridge enabled.\n' +
        'The response includes a second block "via: worker|relay".',
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
        const { result, via } = await browserCall('exec', { script }, { timeoutMs: timeout });
        return execResult(result, via);
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
        'Requires a GM client: foundry-headless-gm, or the world open as GM with foundry-mcp-bridge enabled.\n' +
        'The response includes a second block "via: worker|relay".',
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

      // JSON.stringify keeps quotes in names/ids from breaking out of the string literal.
      const lookup = id
        ? `game.macros.get(${JSON.stringify(id)})`
        : `game.macros.find(m => m.name.toLowerCase() === ${JSON.stringify(name.toLowerCase())})`;
      const script = `
        const macro = ${lookup};
        if (!macro) throw new Error(${JSON.stringify(`Macro not found: ${id || name}`)});
        return await macro.execute(${JSON.stringify(args || {})});
      `;

      try {
        const { result, via } = await browserCall('exec', { script });
        return execResult(result, via);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `exec-macro error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

function execResult(result, via) {
  return {
    content: [
      { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) },
      { type: 'text', text: `via: ${via}` },
    ],
  };
}
