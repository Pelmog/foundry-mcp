/**
 * Dice tool: foundry_roll
 */

import { z } from 'zod';
import { browserCall as defaultBrowserCall } from '../gm-client.mjs';

export function registerDiceTools(server, { browserCall = defaultBrowserCall } = {}) {
  server.registerTool(
    'foundry_roll',
    {
      title: 'Roll Dice in Foundry',
      description:
        'Roll dice using Foundry VTT\'s dice engine. Supports standard dice notation.\n\n' +
        'Args:\n' +
        '  - formula: Dice formula (e.g. "2d20kl", "4d6+2", "1d100")\n' +
        '  - flavor: Optional label for the roll\n\n' +
        'Returns: Roll result with total, individual dice, formula, and "via" (worker|relay)',
      inputSchema: {
        formula: z.string().describe('Dice formula (e.g. "2d20", "4d6kh3+2", "2d6+1d8")'),
        flavor: z.string().optional().describe('Label/description for the roll'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ formula, flavor }) => {
      try {
        // Rolled in a GM browser client, where Foundry's Roll class is available
        const { result, via } = await browserCall('roll', { formula, flavor, toChat: !!flavor });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ...result, via }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Roll error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
