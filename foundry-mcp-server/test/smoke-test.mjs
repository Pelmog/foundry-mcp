#!/usr/bin/env node
/**
 * Smoke test for Foundry MCP Server
 *
 * Tests socket connection and basic document operations.
 * Requires a running Foundry VTT instance with proper .env config.
 *
 * Usage: node test/smoke-test.mjs
 */

import { validateConfig } from '../lib/config.mjs';
import { foundrySocket } from '../lib/foundry-socket.mjs';

const log = (...args) => console.log(...args);
const pass = (name) => log(`  ✓ ${name}`);
const fail = (name, err) => { log(`  ✗ ${name}: ${err}`); failures++; };

let failures = 0;

async function run() {
  log('Foundry MCP Server — Smoke Test\n');

  // ── Config ──────────────────────────────────────
  log('Config:');
  try {
    validateConfig();
    pass('Config valid');
  } catch (err) {
    fail('Config valid', err.message);
    process.exit(1);
  }

  // ── Connection ──────────────────────────────────
  log('\nConnection:');
  let worldData;
  try {
    worldData = await foundrySocket.connect();
    pass(`Connected to "${worldData?.world?.title}"`);
  } catch (err) {
    fail('Connect', err.message);
    process.exit(1);
  }

  try {
    if (worldData?.world?.title) pass('worldData has world.title');
    else fail('worldData.world.title', 'missing');
  } catch (err) {
    fail('worldData check', err.message);
  }

  // ── Document CRUD ───────────────────────────────
  log('\nDocument CRUD:');

  // List actors
  try {
    const actors = await foundrySocket.modifyDocument('get', 'Actor', { query: {} });
    pass(`List actors: ${Array.isArray(actors) ? actors.length : 0} found`);
  } catch (err) {
    fail('List actors', err.message);
  }

  // Create + delete journal entry
  let journalId;
  try {
    const created = await foundrySocket.modifyDocument(
      'create', 'JournalEntry',
      { data: [{ name: '__MCP_SMOKE_TEST__' }] }
    );
    journalId = Array.isArray(created) ? created[0]?._id : created?._id;
    if (journalId) {
      pass(`Create journal: ${journalId}`);
    } else {
      fail('Create journal', 'No _id in response');
    }
  } catch (err) {
    fail('Create journal', err.message);
  }

  if (journalId) {
    try {
      await foundrySocket.modifyDocument('delete', 'JournalEntry', { ids: [journalId] });
      pass('Delete journal');
    } catch (err) {
      fail('Delete journal', err.message);
    }
  }

  // ── Compendium ──────────────────────────────────
  log('\nCompendium:');
  try {
    const packs = worldData?.world?.packs || [];
    pass(`worldData.packs: ${packs.length} packs`);
    if (packs.length > 0) {
      log(`    First pack: ${packs[0].id} (${packs[0].label})`);
    }
  } catch (err) {
    fail('Compendium list', err.message);
  }

  // ── exec-js (requires module) ───────────────────
  log('\nexec-js (requires foundry-mcp-bridge module):');
  try {
    const title = await foundrySocket.execJs('return game.world.title', 10000);
    pass(`exec-js result: "${title}"`);
  } catch (err) {
    log(`  ⚠ exec-js skipped: ${err.message}`);
  }

  // ── Summary ─────────────────────────────────────
  log(`\n${failures === 0 ? '✓ All tests passed' : `✗ ${failures} test(s) failed`}`);

  foundrySocket.disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
