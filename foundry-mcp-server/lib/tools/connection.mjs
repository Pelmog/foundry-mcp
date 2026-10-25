/**
 * Connection tools: foundry_status
 */

import { z } from 'zod';
import { foundrySocket } from '../foundry-socket.mjs';
import { gmStatus as defaultGmStatus } from '../gm-client.mjs';

export function registerConnectionTools(server, { gmStatus = defaultGmStatus } = {}) {
  server.registerTool(
    'foundry_status',
    {
      title: 'Foundry Status',
      description:
        'Get the current connection status and world information from Foundry VTT. ' +
        'Returns world title, system info, Foundry version, connected users, and module list. ' +
        'Also reports gmClient: the headless GM worker status and the number of GM browser tabs reachable over the relay. ' +
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

      let gmClient;
      try {
        gmClient = await gmStatus();
      } catch (err) {
        gmClient = { worker: null, relayTabs: null, error: err.message };
      }

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
        gmClient,
        packs: (worldData.packs?.length ? worldData.packs : (world.packs || [])).length,
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
