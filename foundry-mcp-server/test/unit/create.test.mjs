import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDocumentTools } from '../../lib/tools/documents.mjs';

function setup({ browserCall }) {
  const tools = new Map();
  const calls = [];
  const socket = {
    modifyDocument: async (action, type, op) => { calls.push({ action, type, op }); return [{ _id: 'new1', name: op.data[0].name }]; },
  };
  registerDocumentTools({ registerTool: (name, _meta, handler) => tools.set(name, handler) }, { browserCall, socket });
  return { create: tools.get('foundry_create'), calls };
}

const noGm = async () => { throw new Error('No GM client available: start foundry-headless-gm on the server, or open the world as GM in a browser.'); };
const text = (r) => r.content[0].text;

test('Actor create without a GM client errors and does not touch the raw socket', async () => {
  const { create, calls } = setup({ browserCall: noGm });
  const r = await create({ type: 'Actor', data: { name: 'A', type: 'character' } });
  assert.equal(r.isError, true);
  assert.match(text(r), /No GM client available/);
  assert.equal(calls.length, 0);
});

test('embedded create (parent) without a GM client errors', async () => {
  const { create, calls } = setup({ browserCall: noGm });
  const r = await create({ type: 'JournalEntry', data: { name: 'x' }, parent: 'Actor.abc' });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
});

test('raw: true uses the socket and warns', async () => {
  const { create, calls } = setup({ browserCall: noGm });
  const r = await create({ type: 'Item', data: { name: 'Sword' }, raw: true });
  assert.notEqual(r.isError, true);
  const body = JSON.parse(text(r));
  assert.equal(body.via, 'socket');
  assert.equal(body.warning, 'raw create: system defaults and creation hooks not applied');
  assert.equal(calls.length, 1);
});

test('Actor create with a GM client goes through browserCall and reports via', async () => {
  const seen = [];
  const browserCall = async (op, args) => { seen.push({ op, args }); return { result: { documents: [{ _id: 'd1', name: 'A' }] }, via: 'worker', meta: {} }; };
  const { create, calls } = setup({ browserCall });
  const r = await create({ type: 'Actor', data: { name: 'A' }, parent: undefined });
  const body = JSON.parse(text(r));
  assert.equal(body.via, 'worker');
  assert.equal(body.document._id, 'd1');
  assert.equal(seen[0].op, 'create');
  assert.equal(seen[0].args.type, 'Actor');
  assert.equal(calls.length, 0);
});

test('other types still use the socket, with via and no warning', async () => {
  const { create, calls } = setup({ browserCall: noGm });
  const r = await create({ type: 'JournalEntry', data: { name: 'J' } });
  const body = JSON.parse(text(r));
  assert.equal(body.via, 'socket');
  assert.equal(body.warning, undefined);
  assert.equal(calls.length, 1);
});
