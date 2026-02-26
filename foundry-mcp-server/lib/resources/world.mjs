/**
 * MCP Resource: foundry://world
 *
 * Provides a snapshot of the world info as an MCP resource.
 */

import { foundrySocket } from '../foundry-socket.mjs';

export function registerWorldResource(server) {
  server.registerResource(
    'world-info',
    'foundry://world',
    {
      title: 'Foundry World Info',
      description: 'Current Foundry VTT world information — title, system, version, users, and active modules',
      mimeType: 'application/json',
    },
    async (uri) => {
      const worldData = foundrySocket.worldData;
      if (!worldData) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Not connected to Foundry VTT' }),
          }],
        };
      }

      const world = worldData.world || {};
      const release = worldData.release || {};

      const info = {
        world: {
          id: world.id,
          title: world.title,
          description: world.description,
          system: world.system,
          systemVersion: world.systemVersion,
        },
        coreVersion: `${release.generation}.${release.build}`,
        users: (worldData.users || []).map(u => ({
          id: u._id,
          name: u.name,
          role: u.role,
        })),
        packs: (world.packs || []).length,
        modules: (worldData.modules || [])
          .map(m => ({ id: m.id, title: m.title, version: m.version })),
      };

      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(info, null, 2),
        }],
      };
    }
  );
}
