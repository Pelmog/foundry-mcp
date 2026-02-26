/**
 * Combat tool: foundry_combats
 */

import { z } from 'zod';
import { foundrySocket } from '../foundry-socket.mjs';

export function registerCombatTools(server) {
  server.registerTool(
    'foundry_combats',
    {
      title: 'List Active Combats',
      description:
        'List all active combat encounters in the Foundry VTT world. ' +
        'Returns combat info including combatants, turn order, and current turn.\n\n' +
        'Returns: Array of combat objects with combatant details',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const result = await foundrySocket.modifyDocument(
          'get', 'Combat',
          { query: {} }
        );

        const combats = (Array.isArray(result) ? result : []).map(c => ({
          _id: c._id,
          round: c.round,
          turn: c.turn,
          started: c.started,
          scene: c.scene,
          combatants: (c.combatants || []).map(cb => ({
            _id: cb._id,
            name: cb.name,
            actorId: cb.actorId,
            tokenId: cb.tokenId,
            initiative: cb.initiative,
            defeated: cb.defeated,
            hidden: cb.hidden,
          })),
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: combats.length,
              combats,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error listing combats: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
