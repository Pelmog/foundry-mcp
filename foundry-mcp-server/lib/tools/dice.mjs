/**
 * Dice tool: foundry_roll
 */

import { z } from 'zod';
import { foundrySocket } from '../foundry-socket.mjs';

export function registerDiceTools(server) {
  server.registerTool(
    'foundry_roll',
    {
      title: 'Roll Dice in Foundry',
      description:
        'Roll dice using Foundry VTT\'s dice engine. Supports standard dice notation.\n\n' +
        'Args:\n' +
        '  - formula: Dice formula (e.g. "2d20kl", "4d6+2", "1d100")\n' +
        '  - flavor: Optional label for the roll\n\n' +
        'Returns: Roll result with total, individual dice, and formula',
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
        // Use exec-js to roll dice in the browser context where the Roll class is available
        const script = `
          const roll = await new Roll("${formula.replace(/"/g, '\\"')}").evaluate();
          ${flavor ? `roll.toMessage({ flavor: "${flavor.replace(/"/g, '\\"')}" });` : ''}
          return {
            formula: roll.formula,
            total: roll.total,
            dice: roll.dice.map(d => ({
              faces: d.faces,
              results: d.results.map(r => ({ result: r.result, active: r.active }))
            }))
          };
        `;
        const result = await foundrySocket.execJs(script);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
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
