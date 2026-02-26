/**
 * Document CRUD tools: foundry_get, foundry_list, foundry_create, foundry_update, foundry_delete
 */

import { z } from 'zod';
import { foundrySocket } from '../foundry-socket.mjs';

const DOCUMENT_TYPES = [
  'Actor', 'Item', 'JournalEntry', 'Scene', 'RollTable',
  'Macro', 'Playlist', 'Folder', 'ChatMessage', 'Combat',
  'Cards', 'Adventure',
];

const DocumentTypeEnum = z.enum(DOCUMENT_TYPES);

export function registerDocumentTools(server) {

  // ── foundry_get ────────────────────────────────────────────
  server.registerTool(
    'foundry_get',
    {
      title: 'Get Foundry Document',
      description:
        'Get a single document from Foundry VTT by type and ID. ' +
        'Returns the full document data including system-specific fields.\n\n' +
        'Args:\n' +
        '  - type: Document type (Actor, Item, JournalEntry, etc.)\n' +
        '  - id: The document _id\n' +
        '  - pack: Optional compendium pack ID (e.g. "sta-compendia.talents-core")\n\n' +
        'Returns: Full document JSON',
      inputSchema: {
        type: DocumentTypeEnum.describe('Document type'),
        id: z.string().describe('Document _id'),
        pack: z.string().optional().describe('Compendium pack ID (for pack documents)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ type, id, pack }) => {
      try {
        const result = await foundrySocket.modifyDocument(
          'get', type,
          { query: { _id: id }, pack: pack || null }
        );
        const doc = Array.isArray(result) ? result[0] : result;
        if (!doc) {
          return {
            content: [{ type: 'text', text: `No ${type} found with _id "${id}"` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error getting ${type}: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── foundry_list ───────────────────────────────────────────
  server.registerTool(
    'foundry_list',
    {
      title: 'List Foundry Documents',
      description:
        'List documents of a given type from the Foundry VTT world. ' +
        'Returns an array of documents. Use fields parameter to limit returned fields.\n\n' +
        'Args:\n' +
        '  - type: Document type (Actor, Item, JournalEntry, etc.)\n' +
        '  - fields: Optional array of dot-notation field paths to include (e.g. ["name", "system.attributes"])\n' +
        '  - pack: Optional compendium pack ID\n\n' +
        'Returns: Array of document objects (or projections if fields specified)',
      inputSchema: {
        type: DocumentTypeEnum.describe('Document type to list'),
        fields: z.array(z.string()).optional().describe(
          'Field paths to include in results (e.g. ["name", "type", "system.attributes"]). Omit for full documents.'
        ),
        pack: z.string().optional().describe('Compendium pack ID'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ type, fields, pack }) => {
      try {
        const result = await foundrySocket.modifyDocument(
          'get', type,
          { query: {}, pack: pack || null }
        );
        let docs = Array.isArray(result) ? result : [];

        // Project fields if requested
        if (fields && fields.length > 0) {
          docs = docs.map(doc => {
            const projected = { _id: doc._id, name: doc.name };
            for (const field of fields) {
              const value = getNestedValue(doc, field);
              if (value !== undefined) {
                setNestedValue(projected, field, value);
              }
            }
            return projected;
          });
        }

        const summary = `Found ${docs.length} ${type} document(s)`;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ summary, count: docs.length, documents: docs }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error listing ${type}: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── foundry_create ─────────────────────────────────────────
  server.registerTool(
    'foundry_create',
    {
      title: 'Create Foundry Document',
      description:
        'Create a new document in the Foundry VTT world.\n\n' +
        'Args:\n' +
        '  - type: Document type (Actor, Item, JournalEntry, etc.)\n' +
        '  - data: Document data object (must include "name" at minimum)\n' +
        '  - pack: Optional compendium pack ID\n\n' +
        'Returns: The created document with its assigned _id',
      inputSchema: {
        type: DocumentTypeEnum.describe('Document type to create'),
        data: z.record(z.any()).describe(
          'Document data. Must include "name". For typed docs, include "type" (e.g. Actor type="character").'
        ),
        pack: z.string().optional().describe('Compendium pack ID'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ type, data, pack }) => {
      try {
        const result = await foundrySocket.modifyDocument(
          'create', type,
          { data: [data], pack: pack || null }
        );
        const created = Array.isArray(result) ? result[0] : result;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ created: true, document: created }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error creating ${type}: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── foundry_update ─────────────────────────────────────────
  server.registerTool(
    'foundry_update',
    {
      title: 'Update Foundry Document',
      description:
        'Update an existing document in the Foundry VTT world. ' +
        'Only include the fields you want to change (partial update).\n\n' +
        'Args:\n' +
        '  - type: Document type\n' +
        '  - id: Document _id to update\n' +
        '  - data: Partial document data with fields to update\n' +
        '  - pack: Optional compendium pack ID\n\n' +
        'Returns: The updated document',
      inputSchema: {
        type: DocumentTypeEnum.describe('Document type'),
        id: z.string().describe('Document _id to update'),
        data: z.record(z.any()).describe('Partial document data — only fields to change'),
        pack: z.string().optional().describe('Compendium pack ID'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ type, id, data, pack }) => {
      try {
        const updateData = { _id: id, ...data };
        const result = await foundrySocket.modifyDocument(
          'update', type,
          { updates: [updateData], diff: true, pack: pack || null }
        );
        const updated = Array.isArray(result) ? result[0] : result;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ updated: true, document: updated }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error updating ${type} ${id}: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── foundry_delete ─────────────────────────────────────────
  server.registerTool(
    'foundry_delete',
    {
      title: 'Delete Foundry Document',
      description:
        'Delete one or more documents from the Foundry VTT world. This is destructive and cannot be undone.\n\n' +
        'Args:\n' +
        '  - type: Document type\n' +
        '  - ids: Array of document _id strings to delete\n' +
        '  - pack: Optional compendium pack ID\n\n' +
        'Returns: Confirmation with deleted IDs',
      inputSchema: {
        type: DocumentTypeEnum.describe('Document type'),
        ids: z.array(z.string()).min(1).describe('Document _id(s) to delete'),
        pack: z.string().optional().describe('Compendium pack ID'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ type, ids, pack }) => {
      try {
        const result = await foundrySocket.modifyDocument(
          'delete', type,
          { ids, pack: pack || null }
        );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ deleted: true, ids: result || ids }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error deleting ${type}: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}

// ── Helpers ────────────────────────────────────────────────────

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, key) => o?.[key], obj);
}

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] === undefined) current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}
