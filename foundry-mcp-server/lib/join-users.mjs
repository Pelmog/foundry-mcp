/**
 * Resolve the Foundry login user from the /join page.
 *
 * User ids differ per world, so a pinned FOUNDRY_USER_ID breaks when the active
 * world changes. The /join page lists the active world's users as
 * <select name="userid"><option value="ID">Name</option>...</select>.
 */

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');

/** @returns {{id: string, name: string}[]} */
export function parseJoinUsers(html) {
  const select = html.match(/<select[^>]*name=["']userid["'][^>]*>([\s\S]*?)<\/select>/i);
  if (!select) return [];
  const users = [];
  for (const m of select[1].matchAll(/<option\s+[^>]*?value=["']([^"']*)["'][^>]*>([^<]*)<\/option>/gi)) {
    if (m[1]) users.push({ id: m[1], name: decodeEntities(m[2].trim()) });
  }
  return users;
}

/**
 * Pick the user id to log in with.
 * - configured id is listed (or the page lists no users): keep it (backwards compatible)
 * - otherwise resolve FOUNDRY_USER_NAME against the listed users
 * Throws only when the configured id is stale and the name can't replace it.
 */
export function pickUserId(users, { userId, userName }) {
  if (userId && (users.length === 0 || users.some((u) => u.id === userId))) return userId;
  if (userName && users.length) {
    const match = users.find((u) => u.name === userName)
      || users.find((u) => u.name.toLowerCase() === userName.toLowerCase());
    if (match) return match.id;
    throw new Error(
      `FOUNDRY_USER_NAME "${userName}" is not a user in the active world (users: ${users.map((u) => u.name).join(', ')})`
    );
  }
  if (userId) return userId;
  throw new Error('Could not resolve a login user: set FOUNDRY_USER_ID, or FOUNDRY_USER_NAME for a world listed on /join');
}
