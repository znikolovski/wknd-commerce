#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
const { createMain } = require('../actions/commerce-mcp');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { migrateLegacyPromotions } = require('../lib/promotions');
const remote = process.argv[2];
if (remote && !remote.startsWith('https://')) throw new Error('Remote smoke URL must use HTTPS.');
if (remote && !process.env.WKND_COMMERCE_MCP_SECRET) throw new Error('Set WKND_COMMERCE_MCP_SECRET in the environment.');

let server;
let client;
try {
  const secret = remote ? process.env.WKND_COMMERCE_MCP_SECRET : crypto.randomBytes(32).toString('base64url');
  let url = remote;
  if (!remote) {
    const store = createMemoryStore();
    const catalog = JSON.parse(await fs.readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
    await importCatalog(store, catalog, { replace: true });
    await migrateLegacyPromotions(store);
    const main = createMain({ openStore: async () => store });
    const config = {
      MCP_SHARED_SECRET: secret, MCP_ORG_ID: 'local-smoke',
      PROMOTION_CURSOR_KEY: crypto.randomBytes(32).toString('base64'),
    };
    server = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 65536) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const result = await main({
          ...config, __ow_method: req.method, __ow_headers: req.headers,
          __ow_body: Buffer.concat(chunks).toString('base64'),
          __ow_query: new URL(req.url, 'http://localhost').search.slice(1),
        });
        res.writeHead(result.statusCode, result.headers).end(result.body);
      } catch {
        console.error('Local MCP HTTP adapter failed.');
        res.writeHead(500).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/mcp`;
  }
  client = new Client({ name: 'wknd-commerce-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'X-WKND-MCP-Key': secret } },
  }));
  const { tools } = await client.listTools();
  for (const name of ['commerce_stats', 'list_products']) {
    const result = await client.callTool({ name, arguments: {} });
    if (result.isError) throw new Error('Read tool failed.');
  }
  console.log(`MCP smoke passed: initialize, list (${tools.length} tools), commerce_stats, list_products. No remote writes.`);
} catch {
  console.error('MCP smoke failed. Check URL, server configuration, credential and server logs; no credentials printed.');
  process.exitCode = 1;
} finally {
  if (client) await client.close();
  if (server) {
    server.closeIdleConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
