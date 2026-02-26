/**
 * Macro listing tool: foundry_macros
 */

import { z } from 'zod';
import { foundrySocket } from '../foundry-socket.mjs';

export function registerMacroTools(server) {
  server.registerTool(
    'foundry_macros',
    {
      title: 'List Foundry Macros',
      description:
        'List all macros in the Foundry VTT world.\n\n' +
        'Returns: Array of macro objects with name, type, command preview, and author',
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
          'get', 'Macro',
          { query: {} }
        );

        const macros = (Array.isArray(result) ? result : []).map(m => ({
          _id: m._id,
          name: m.name,
          type: m.type,
          scope: m.scope,
          command: m.command?.substring(0, 200) + (m.command?.length > 200 ? '...' : ''),
          author: m.author,
          img: m.img,
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: macros.length, macros }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error listing macros: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
