#!/usr/bin/env node
// Pass through the app's own tools, resources, prompts, and protocol messages.
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const app = process.env.CREATIVE_MCP_APP || 'Cavalry';
const override = process.env[`${app.toUpperCase()}_MCP_PORT`];
const port = Number(override || process.env.CREATIVE_MCP_PORT || 6768);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[${app}] MCP port must be an integer between 1 and 65535.`);
  process.exit(1);
}

const headers = app === 'Cavalry' ? {
  'X-Cavalry-MCP-Fingerprint': process.env.CREATIVE_MCP_FINGERPRINT || 'codex-cavalry-local-plugin-v1',
  'X-Cavalry-MCP-Client-Name': 'Codex',
  'X-Cavalry-MCP-Client-Version': '0.1.0',
} : {};
const endpoint = new URL(`http://127.0.0.1:${port}/sse`);
const remote = new SSEClientTransport(endpoint, {
  requestInit: { headers },
  eventSourceInit: { fetch: (url, init) => {
    const merged = new Headers(init?.headers);
    for (const [key, value] of Object.entries(headers)) merged.set(key, value);
    return fetch(url, { ...init, headers: merged });
  } },
});
const local = new StdioServerTransport();
let closing = false;
const shutdown = async (code = 0) => {
  if (closing) return;
  closing = true;
  clearTimeout(startupTimer);
  await Promise.allSettled([remote.close(), local.close()]);
  process.exit(code);
};
const failure = (error) => {
  if (closing) return;
  console.error(`[${app}] MCP connection failed. Keep ${app} open, enable its MCP server, and check port ${port}. ${error.message}`);
  void shutdown(1);
};
remote.onmessage = (message) => { void local.send(message).catch(failure); };
local.onmessage = (message) => { void remote.send(message).catch(failure); };
remote.onerror = failure;
local.onerror = failure;
remote.onclose = () => { void shutdown(); };
local.onclose = () => { void shutdown(); };
process.stdin.on('end', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
const startupTimer = setTimeout(() => {
  failure(new Error('Connection timed out. If the app shows a connection prompt, allow the Codex connection you requested.'));
}, 55000);

try {
  await remote.start();
  clearTimeout(startupTimer);
  await local.start();
} catch (error) {
  failure(error);
}
