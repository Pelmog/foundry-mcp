import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function unusedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test('server exits by itself within 3s when stdin closes (no signal)', async () => {
  const port = await unusedPort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, FOUNDRY_HOST: '127.0.0.1', FOUNDRY_PORT: String(port), FOUNDRY_USER_ID: 'x', FOUNDRY_GM_SOCKET: '/nonexistent/gm.sock' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  }) + '\n');
  // wait until the MCP transport is up so we know we're testing a running server
  const deadline = Date.now() + 5000;
  while (!stderr.includes('MCP server running') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.match(stderr, /MCP server running/);

  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  const { code, signal } = await exited;
  clearTimeout(timer);
  assert.equal(signal, null, `process had to be killed (stderr: ${stderr})`);
  assert.equal(code, 0);
});
