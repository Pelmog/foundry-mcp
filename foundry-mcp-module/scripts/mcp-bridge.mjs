/**
 * Foundry MCP Bridge Module
 *
 * Listens for exec-js requests from the MCP server via Foundry's socket relay,
 * executes JavaScript in the browser context, and sends back results.
 *
 * The MCP server (running on the same machine) connects as a socket.io client.
 * It emits 'module.foundry-mcp-bridge' events, which Foundry relays to all
 * other clients. This module (running in the GM's browser) picks them up,
 * executes the JS, and emits the result back.
 */

const MODULE_ID = 'foundry-mcp-bridge';

Hooks.once('ready', () => {
  // Only the GM should process exec-js requests
  if (!game.user.isGM) return;

  console.log(`${MODULE_ID} | Ready — listening for MCP requests`);

  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    // Only handle exec-js requests (ignore result messages from ourselves)
    if (data?.type !== 'exec-js' || !data?.requestId) return;

    console.log(`${MODULE_ID} | exec-js request: ${data.requestId}`);

    try {
      const fn = new Function(data.script);
      const result = await fn();

      game.socket.emit(`module.${MODULE_ID}`, {
        requestId: data.requestId,
        type: 'result',
        success: true,
        result,
      });
    } catch (err) {
      console.error(`${MODULE_ID} | exec-js error:`, err);

      game.socket.emit(`module.${MODULE_ID}`, {
        requestId: data.requestId,
        type: 'result',
        success: false,
        error: err.message,
      });
    }
  });
});
