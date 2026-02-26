/**
 * Compendium tools: foundry_packs, foundry_pack_contents
 */

import { z } from 'zod';
import { foundrySocket } from '../foundry-socket.mjs';

export function registerCompendiumTools(server) {

  // ── foundry_packs ──────────────────────────────────────────
  server.registerTool(
    'foundry_packs',
    {
      title: 'List Compendium Packs',
      description:
        'List all compendium packs available in the Foundry VTT world. ' +
        'Returns pack ID, label, document type, system, and module source.\n\n' +
        'Returns: Array of pack metadata objects',
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
        const worldData = foundrySocket.worldData;
        if (!worldData) {
          return {
            content: [{ type: 'text', text: 'Not connected to Foundry VTT' }],
            isError: true,
          };
        }

        // Packs are listed in worldData.world.packs (Foundry v13 getJoinData structure)
        const packs = (worldData.world?.packs || worldData.packs || []).map(p => ({
          id: p.id,
          label: p.label,
          type: p.type,
          system: p.system || null,
          packageType: p.packageType,
          packageName: p.packageName,
          path: p.path,
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: packs.length,
              packs,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error listing packs: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── foundry_pack_contents ──────────────────────────────────
  server.registerTool(
    'foundry_pack_contents',
    {
      title: 'Get Compendium Pack Contents',
      description:
        'Get the index or full contents of a compendium pack.\n\n' +
        'Args:\n' +
        '  - pack: Pack ID (e.g. "sta-compendia.talents-core")\n' +
        '  - full: If true, return full document data. If false (default), return index only (name, type, img).\n' +
        '  - type: Document type in this pack (e.g. "Item", "Actor")\n\n' +
        'Returns: Array of documents or index entries',
      inputSchema: {
        pack: z.string().describe('Compendium pack ID (e.g. "sta-compendia.talents-core")'),
        type: z.string().describe('Document type in this pack (e.g. "Item", "Actor", "JournalEntry")'),
        full: z.boolean().default(false).describe('Return full documents (true) or just index (false)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pack, type, full }) => {
      try {
        const result = await foundrySocket.modifyDocument(
          'get', type,
          { query: {}, pack }
        );

        let docs = Array.isArray(result) ? result : [];

        // If not full, return just index fields
        if (!full) {
          docs = docs.map(d => ({
            _id: d._id,
            name: d.name,
            type: d.type,
            img: d.img,
          }));
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              pack,
              count: docs.length,
              documents: docs,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error reading pack "${pack}": ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
