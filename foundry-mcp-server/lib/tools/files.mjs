/**
 * File browsing tool: foundry_files
 */

import { z } from 'zod';
import { foundrySocket as defaultSocket } from '../foundry-socket.mjs';
import { browserCall as defaultBrowserCall } from '../gm-client.mjs';

export function registerFileTools(server, { socket = defaultSocket, browserCall = defaultBrowserCall } = {}) {
  server.registerTool(
    'foundry_files',
    {
      title: 'Browse Foundry Files',
      description:
        'Browse the Foundry VTT file system. Lists files and directories in a given path.\n\n' +
        'Args:\n' +
        '  - path: Directory path to browse (default "/")\n' +
        '  - source: Storage source — "data" (user data), "public" (core assets)\n\n' +
        'Returns: Directory listing with files and subdirectories, and "via" (socket|worker|relay)',
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
        // Same request FilePicker.browse sends: manageFiles(data, options, callback)
        let socketError;
        try {
          const r = await socket.emitWithAck(
            'manageFiles', { action: 'browseFiles', storage: source, target: path }, {}
          );
          return filesResult({ target: r.target, dirs: r.dirs, files: r.files }, 'socket');
        } catch (err) {
          socketError = err;
        }

        // Socket refused or unavailable: browse from a GM browser client instead
        const script = `
          const result = await FilePicker.browse(${JSON.stringify(source)}, ${JSON.stringify(path)});
          return { target: result.target, dirs: result.dirs, files: result.files };
        `;
        try {
          const { result, via } = await browserCall('exec', { script });
          return filesResult(result, via);
        } catch (browserErr) {
          throw new Error(`socket: ${socketError.message}; browser: ${browserErr.message}`);
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `File browse error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

function filesResult(listing, via) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ...listing, via }, null, 2),
    }],
  };
}
