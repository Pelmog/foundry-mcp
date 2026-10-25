/**
 * Compendium tools: foundry_packs, foundry_pack_contents
 *
 * Socket first (pack list from the getJoinData snapshot, modifyDocument "get" with a
 * pack), then a GM browser client if the socket can't answer.
 */

import { z } from 'zod';
import { foundrySocket as defaultSocket } from '../foundry-socket.mjs';
import { browserCall as defaultBrowserCall } from '../gm-client.mjs';

const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

export function registerCompendiumTools(server, { socket = defaultSocket, browserCall = defaultBrowserCall } = {}) {

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
        // getJoinData carries every pack (world, system and modules) at the top level as
        // `packs`; `world.packs` is a different, usually empty, list.
        const worldData = socket.worldData;
        const raw = worldData?.packs?.length ? worldData.packs : (worldData?.world?.packs || []);
        if (raw.length) {
          const packs = raw.map(p => ({
            id: p.id,
            label: p.label,
            type: p.type,
            system: p.system || null,
            packageType: p.packageType,
            packageName: p.packageName,
            path: p.path,
          }));
          return json({ count: packs.length, packs, via: 'socket' });
        }

        const { result: packs, via } = await browserCall('exec', { script: `
          return game.packs.map(p => ({
            id: p.metadata.id,
            label: p.metadata.label,
            type: p.metadata.type,
            system: p.metadata.system || null,
            packageType: p.metadata.packageType,
            packageName: p.metadata.packageName,
            path: p.metadata.path
          }));
        ` });
        return json({ count: packs.length, packs, via });
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
        let socketError;
        try {
          const result = await socket.modifyDocument(
            'get', type,
            { query: {}, pack, ...(full ? {} : { index: true }) }
          );
          let docs = Array.isArray(result) ? result : [];
          if (!full) docs = docs.map(({ _id, name, type: t, img }) => ({ _id, name, type: t, img }));
          return json({ pack, count: docs.length, documents: docs, via: 'socket' });
        } catch (err) {
          socketError = err;
        }

        // Socket couldn't read the pack: ask a GM browser client
        const packId = JSON.stringify(pack);
        const script = full
          ? `
            const p = game.packs.get(${packId});
            if (!p) throw new Error("Pack not found: " + ${packId});
            const docs = await p.getDocuments();
            return docs.map(d => d.toObject());
          `
          : `
            const p = game.packs.get(${packId});
            if (!p) throw new Error("Pack not found: " + ${packId});
            const index = await p.getIndex();
            return index.contents.map(d => ({
              _id: d._id,
              name: d.name,
              type: d.type,
              img: d.img
            }));
          `;
        try {
          const { result: docs, via } = await browserCall('exec', { script });
          return json({ pack, count: docs.length, documents: docs, via });
        } catch (browserErr) {
          throw new Error(`socket: ${socketError.message}; browser: ${browserErr.message}`);
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error reading pack "${pack}": ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
