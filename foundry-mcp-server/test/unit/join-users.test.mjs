import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJoinUsers, pickUserId } from '../../lib/join-users.mjs';

const html = `<form><select name="userid" id="user">
  <option value="">&lt;Select a user&gt;</option>
  <option value="aaaa1111aaaa1111">Gamemaster</option>
  <option value="bbbb2222bbbb2222" disabled>Friend Computer</option>
  <option value="cccc3333cccc3333">Tom &amp; Jerry</option>
</select><select name="other"><option value="zzz">Nope</option></select></form>`;

test('parses the userid select only, decoding entities and skipping the placeholder', () => {
  assert.deepEqual(parseJoinUsers(html), [
    { id: 'aaaa1111aaaa1111', name: 'Gamemaster' },
    { id: 'bbbb2222bbbb2222', name: 'Friend Computer' },
    { id: 'cccc3333cccc3333', name: 'Tom & Jerry' },
  ]);
  assert.deepEqual(parseJoinUsers('<html>no select</html>'), []);
});

test('keeps a valid configured id', () => {
  assert.equal(pickUserId(parseJoinUsers(html), { userId: 'aaaa1111aaaa1111', userName: 'Friend Computer' }), 'aaaa1111aaaa1111');
});

test('resolves by name when the id is not in the active world', () => {
  assert.equal(pickUserId(parseJoinUsers(html), { userId: 'stale', userName: 'friend computer' }), 'bbbb2222bbbb2222');
  assert.equal(pickUserId(parseJoinUsers(html), { userId: '', userName: 'Gamemaster' }), 'aaaa1111aaaa1111');
});

test('backwards compatible: id only, or no parsable user list, keeps the id', () => {
  assert.equal(pickUserId(parseJoinUsers(html), { userId: 'stale', userName: '' }), 'stale');
  assert.equal(pickUserId([], { userId: 'abc', userName: 'x' }), 'abc');
});

test('unknown name throws and lists the users', () => {
  assert.throws(() => pickUserId(parseJoinUsers(html), { userId: 'stale', userName: 'Nobody' }), /Nobody.*Gamemaster/);
});
