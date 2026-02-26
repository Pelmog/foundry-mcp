/**
 * File browsing tool: foundry_files
 */

import { z } from 'zod';
import { foundrySocket } from '../foundry-socket.mjs';

export function registerFileTools(server) {
  server.registerTool(
    'foundry_files',
    {
      title: 'Browse Foundry Files',
      description:
        'Browse the Foundry VTT file system. Lists files and directories in a given path.\n\n' +
        'Args:\n' +
        '  - path: Directory path to browse (default "/")\n' +
        '  - source: Storage source — "data" (user data), "public" (core assets)\n\n' +
        'Returns: Directory listing with files and subdirectories',
      inputSchema: {
        path: z.string().default('/').describe('Directory path to browse'),
        source: z.enum(['data', 'public']).default('data').describe('Storage source'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, source }) => {
      try {
        // Use exec-js to access FilePicker.browse which is browser-only
        const script = `
          const result = await FilePicker.browse("${source}", "${path.replace(/"/g, '\\"')}");
          return {
            target: result.target,
            dirs: result.dirs,
            files: result.files,
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
          content: [{ type: 'text', text: `File browse error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
