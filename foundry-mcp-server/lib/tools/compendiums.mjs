/**
 * Compendium tools: foundry_packs, foundry_pack_contents
 *
 * Uses exec-js (browser context) for pack access since module compendium packs
 * are only available in the browser, not via the server-side modifyDocument socket.
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
        // Try exec-js first (works for module packs)
        try {
          const packs = await foundrySocket.execJs(`
            return game.packs.map(p => ({
              id: p.metadata.id,
              label: p.metadata.label,
              type: p.metadata.type,
              system: p.metadata.system || null,
              packageType: p.metadata.packageType,
              packageName: p.metadata.packageName,
              path: p.metadata.path
            }));
          `);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                count: packs.length,
                packs,
              }, null, 2),
            }],
          };
        } catch {
          // Fallback to worldData if exec-js unavailable
        }

        const worldData = foundrySocket.worldData;
        if (!worldData) {
          return {
            content: [{ type: 'text', text: 'Not connected to Foundry VTT' }],
            isError: true,
          };
        }

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
        '  - pack: Pack ID (e.g. "sta-compendia.general-talents-core")\n' +
        '  - full: If true, return full document data. If false (default), return index only (name, type, img).\n' +
        '  - type: Document type in this pack (e.g. "Item", "Actor", "JournalEntry")\n\n' +
        'Returns: Array of documents or index entries',
      inputSchema: {
        pack: z.string().describe('Compendium pack ID (e.g. "sta-compendia.general-talents-core")'),
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
        // Try exec-js first (works for module packs)
        try {
          const packId = pack.replace(/"/g, '\\"');
          const script = full
            ? `
              const p = game.packs.get("${packId}");
              if (!p) throw new Error("Pack not found: ${packId}");
              const docs = await p.getDocuments();
              return docs.map(d => d.toObject());
            `
            : `
              const p = game.packs.get("${packId}");
              if (!p) throw new Error("Pack not found: ${packId}");
              const index = await p.getIndex();
              return index.contents.map(d => ({
                _id: d._id,
                name: d.name,
                type: d.type,
                img: d.img
              }));
            `;

          const docs = await foundrySocket.execJs(script);
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
        } catch (execErr) {
          // If exec-js failed with "not found", propagate that error
          if (execErr.message?.includes('Pack not found')) throw execErr;
          // Otherwise fall back to socket modifyDocument
        }

        // Fallback: socket-based access (works for world packs)
        const result = await foundrySocket.modifyDocument(
          'get', type,
          { query: {}, pack }
        );

        let docs = Array.isArray(result) ? result : [];

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
