/**
 * Search tool: foundry_search
 */

import { z } from 'zod';
import { foundrySocket } from '../foundry-socket.mjs';

const SEARCHABLE_TYPES = [
  'Actor', 'Item', 'JournalEntry', 'Scene', 'RollTable',
  'Macro', 'Playlist', 'Cards',
];

export function registerSearchTools(server) {
  server.registerTool(
    'foundry_search',
    {
      title: 'Search Foundry Documents',
      description:
        'Search for documents by name or field values across one or all document types. ' +
        'Uses case-insensitive substring matching on the name field, or exact matching on specified fields.\n\n' +
        'Args:\n' +
        '  - query: Search string to match against document names\n' +
        '  - type: Optional document type to search within (omit to search all types)\n' +
        '  - filters: Optional key-value pairs for exact field matching (e.g. {"type": "character"})\n' +
        '  - limit: Maximum results to return (default 20)\n\n' +
        'Returns: Array of matching documents with type labels',
      inputSchema: {
        query: z.string().optional().describe('Search string for name matching (case-insensitive substring)'),
        type: z.enum(SEARCHABLE_TYPES).optional().describe('Limit search to this document type'),
        filters: z.record(z.any()).optional().describe('Exact match filters (e.g. {"type": "character"})'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, type, filters, limit }) => {
      try {
        const types = type ? [type] : SEARCHABLE_TYPES;
        const results = [];

        for (const docType of types) {
          if (results.length >= limit) break;

          const docs = await foundrySocket.modifyDocument(
            'get', docType,
            { query: {} }
          );

          const allDocs = Array.isArray(docs) ? docs : [];

          for (const doc of allDocs) {
            if (results.length >= limit) break;

            // Name filter
            if (query && !doc.name?.toLowerCase().includes(query.toLowerCase())) {
              continue;
            }

            // Field filters
            if (filters) {
              let match = true;
              for (const [key, value] of Object.entries(filters)) {
                const docValue = getNestedValue(doc, key);
                if (docValue !== value) {
                  match = false;
                  break;
                }
              }
              if (!match) continue;
            }

            results.push({
              _id: doc._id,
              name: doc.name,
              type: doc.type,
              documentType: docType,
              img: doc.img,
              folder: doc.folder,
            });
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query: query || null,
              filters: filters || null,
              count: results.length,
              results,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Search error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, key) => o?.[key], obj);
}
