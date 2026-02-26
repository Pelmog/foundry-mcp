/**
 * Configuration loader for Foundry MCP Server.
 * Reads .env file and validates required settings.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';

function findEnvFile(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadEnvFile() {
  const envPath = findEnvFile(process.cwd());
  if (!envPath) return {};
  const content = readFileSync(envPath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return env;
}

const fileEnv = loadEnvFile();

export const config = {
  host: process.env.FOUNDRY_HOST || fileEnv.FOUNDRY_HOST || 'localhost',
  port: parseInt(process.env.FOUNDRY_PORT || fileEnv.FOUNDRY_PORT || '30000', 10),
  userId: process.env.FOUNDRY_USER_ID || fileEnv.FOUNDRY_USER_ID || '',
  password: process.env.FOUNDRY_PASSWORD || fileEnv.FOUNDRY_PASSWORD || '',
};

export function getFoundryUrl() {
  return `http://${config.host}:${config.port}`;
}

export function validateConfig() {
  if (!config.userId) {
    throw new Error(
      'FOUNDRY_USER_ID is required. Set it in .env or environment.\n' +
      'Find it with: exec-js "return game.users.find(u => u.isGM)?.id"'
    );
  }
}
