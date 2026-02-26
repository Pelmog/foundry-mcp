/**
 * Connection tools: foundry_status
 */

import { z } from 'zod';
import { foundrySocket } from '../foundry-socket.mjs';

export function registerConnectionTools(server) {
  server.registerTool(
    'foundry_status',
    {
      title: 'Foundry Status',
      description:
        'Get the current connection status and world information from Foundry VTT. ' +
        'Returns world title, system info, Foundry version, connected users, and module list. ' +
        'Use this to verify the connection is working.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const connected = foundrySocket.connected;
      const worldData = foundrySocket.worldData;

      if (!connected || !worldData) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ connected: false, error: 'Not connected to Foundry VTT' }),
          }],
          isError: true,
        };
      }

      const world = worldData.world || {};
      const release = worldData.release || {};
      const users = (worldData.users || []).map(u => ({
        id: u._id,
        name: u.name,
        role: u.role,
      }));

      const result = {
        connected: true,
        world: {
          id: world.id,
          title: world.title,
          description: world.description,
          system: world.system,
          systemVersion: world.systemVersion,
          coreVersion: `${release.generation}.${release.build}`,
        },
        users,
        packs: (world.packs || []).length,
        modules: (worldData.modules || [])
          .map(m => ({ id: m.id, title: m.title, version: m.version })),
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
