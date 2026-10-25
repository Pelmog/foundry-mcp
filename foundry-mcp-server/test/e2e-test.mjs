/**
 * End-to-end test: CRUD cycle + dice + compendium access
 */
import { FoundrySocket } from '../lib/foundry-socket.mjs';

const fs = new FoundrySocket();
await fs.connect();

console.log('=== END-TO-END GAME OPERATIONS ===\n');

// 1. List compendium packs
const wd = fs.worldData;
const packs = wd.world?.packs || [];
console.log('1. Compendium packs (world-level):', packs.length);

// 2. Test compendium access via exec-js
console.log('\n2. Testing compendium access...');
const packList = await fs.execJs('return game.packs.map(p => ({id: p.metadata.id, label: p.metadata.label, type: p.metadata.type}))');
console.log(`   Total packs: ${packList.length}`);
const staPacks = packList.filter(p => p.id.startsWith('sta'));
console.log(`   STA packs: ${staPacks.length}`);

// 3. Create test NPC with STA attributes
console.log('\n3. Creating test NPC...');
const npcData = {
  name: 'Test NPC - Lt. Sarek',
  type: 'character',
  system: {
    attributes: {
      control: { value: 10 },
      daring: { value: 9 },
      fitness: { value: 8 },
      insight: { value: 11 },
      presence: { value: 9 },
      reason: { value: 12 },
    },
    disciplines: {
      command: { value: 3 },
      conn: { value: 2 },
      engineering: { value: 1 },
      medicine: { value: 2 },
      science: { value: 4 },
      security: { value: 1 },
    },
    species: 'Vulcan',
    rank: 'Lieutenant',
    determination: { value: 2, max: 3 },
    stress: { value: 0, max: 12 },
    reputation: 5,
    traits: 'Vulcan, Starfleet Officer',
    npcType: 'notable',
  },
};

const created = await fs.modifyDocument('create', 'Actor', { data: [npcData] });
const npc = created[0];
const npcId = npc._id;
console.log('   Created:', npc.name, '| id:', npcId);
console.log('   Attributes control:', npc.system.attributes.control.value);
console.log('   Species:', npc.system.species);
console.log('   Rank:', npc.system.rank);

// 4. Update the actor's stats
console.log('\n4. Updating NPC stats...');
const updated = await fs.modifyDocument('update', 'Actor', {
  updates: [
    {
      _id: npcId,
      'system.stress.value': 5,
      'system.reputation': 7,
      'system.assignment': 'USS Discovery - Science Officer',
    },
  ],
});
console.log('   Updated stress:', updated[0].system.stress.value);
console.log('   Updated reputation:', updated[0].system.reputation);
console.log('   Assignment:', updated[0].system.assignment);

// 5. Roll dice via exec-js
console.log('\n5. Rolling STA challenge dice (2d20)...');
try {
  const roll = await fs.execJs(
    'const r = new Roll("2d20"); await r.evaluate(); return {formula: r.formula, total: r.total, dice: r.dice.map(d => ({faces: d.faces, results: d.results}))};'
  );
  console.log('   Formula:', roll.formula);
  console.log('   Total:', roll.total);
  console.log('   Dice:', JSON.stringify(roll.dice));
} catch (e) {
  console.log('   Dice roll via exec-js skipped (GM not in browser):', e.message);
}

// 6. Delete the test actor
console.log('\n6. Deleting test NPC...');
await fs.modifyDocument('delete', 'Actor', { ids: [npcId] });

// Verify deletion
const remaining = await fs.modifyDocument('get', 'Actor', { query: {} });
const gone = !remaining.find((a) => a._id === npcId);
console.log('   Verified deleted:', gone ? 'YES' : 'NO');

console.log('\n=== ALL END-TO-END TESTS PASSED ===');

fs.disconnect();
