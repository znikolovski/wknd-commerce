const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createMain } = require('../actions/commerce-mcp');
const { createMemoryStore } = require('../lib/store');
const { resetCatalogCache } = require('../lib/catalog');
const { getProduct } = require('../lib/mcp-reads');

const config = { MCP_SHARED_SECRET: 's'.repeat(43), MCP_ORG_ID: 'test-org' };
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
let store;
let openStore;
let main;
let logger;

function invoke(body, extra = {}) {
  return main({
    ...config, __ow_method: 'post',
    __ow_headers: { 'x-wknd-mcp-key': config.MCP_SHARED_SECRET, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    __ow_body: Buffer.from(JSON.stringify(body)).toString('base64'),
    ...extra,
  });
}

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  openStore = jest.fn().mockResolvedValue(store);
  logger = { error: jest.fn(), warn: jest.fn() };
  main = createMain({ openStore, logger, prerender: jest.fn().mockResolvedValue({ activationId: 'render' }) });
  await store.collection('products').insertOne({ sku: 'GEAR-ONE', name: 'One', categories: ['gear'], type: 'simple', status: 'enabled' });
  await store.collection('categories').insertOne({ id: '1', name: 'Gear', urlPath: 'gear' });
  await store.collection('prices').insertOne({ sku: 'GEAR-ONE', regular: 100, currency: 'AUD' });
});

test('unauthenticated requests and spoofed org headers never reach the database', async () => {
  const result = await invoke(rpc('tools/list'), { __ow_headers: { 'x-gw-ims-org-id': config.MCP_ORG_ID } });
  expect(result.statusCode).toBe(401);
  expect(openStore).not.toHaveBeenCalled();
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain(config.MCP_SHARED_SECRET);
});

test('missing configuration fails closed, not open', async () => {
  const result = await invoke(rpc('tools/list'), { MCP_SHARED_SECRET: '' });
  expect(result.statusCode).toBe(503);
  expect(openStore).not.toHaveBeenCalled();
});

test('preflight, methods, Origin and query parameters are explicit', async () => {
  expect((await invoke({}, { __ow_method: 'options', __ow_headers: {} })).statusCode).toBe(204);
  expect((await invoke({}, { __ow_method: 'get' })).statusCode).toBe(405);
  expect((await invoke({}, { __ow_query: 'MCP_SHARED_SECRET=attacker' })).statusCode).toBe(400);
  expect((await invoke({}, { __ow_headers: { origin: 'https://attacker.example' } })).statusCode).toBe(403);
  expect(openStore).not.toHaveBeenCalled();
});

test('single-request protocol, raw body encoding and decoded byte limit enforced', async () => {
  expect((await invoke([rpc('tools/list')])).statusCode).toBe(400);
  expect((await invoke({}, { __ow_body: 'not-base64!' })).statusCode).toBe(400);
  expect((await invoke({}, { __ow_body: Buffer.from('{"q":"').toString('base64') })).statusCode).toBe(400);
  const oversized = JSON.stringify({ q: '\u00e9'.repeat(33000) });
  expect((await invoke({}, { __ow_body: Buffer.from(oversized).toString('base64') })).statusCode).toBe(413);
  expect((await invoke({}, { __ow_body: JSON.stringify({ q: ' '.repeat(65537) }) })).statusCode).toBe(413);
  expect(openStore).not.toHaveBeenCalled();
});

test('body byte boundary is inclusive and malformed UTF-8 is rejected', async () => {
  const json = JSON.stringify(rpc('tools/list'));
  const body = json + ' '.repeat(65536 - Buffer.byteLength(json));
  expect(Buffer.byteLength(body)).toBe(65536);
  expect((await invoke({}, { __ow_body: Buffer.from(body).toString('base64') })).statusCode).toBe(200);
  expect((await invoke({}, { __ow_body: Buffer.from(`${body} `).toString('base64') })).statusCode).toBe(413);
  expect((await invoke({}, { __ow_body: Buffer.from([0xff]).toString('base64') })).statusCode).toBe(400);
});

test('SDK handles initialize, notifications, list and protocol failures without opening a store', async () => {
  const init = await invoke(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
  expect(init.statusCode).toBe(200);
  expect(JSON.parse(init.body).result.serverInfo.name).toBe('wknd-commerce');
  expect(init.headers).not.toHaveProperty('mcp-session-id');
  expect((await invoke({ jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202);
  const listed = JSON.parse((await invoke(rpc('tools/list'))).body).result.tools;
  expect(listed.map((t) => t.name)).toContain('set_product_sale');
  expect(listed.some((t) => /delete|import|inventory_update|place_order/.test(t.name))).toBe(false);
  expect(listed.find((t) => t.name === 'set_product_sale').annotations.destructiveHint).toBe(true);
  expect(JSON.parse((await invoke(rpc('admin'))).body).error.code).toBe(-32601);
  expect(openStore).not.toHaveBeenCalled();
});

test.each([
  ['set_product_sale', { sku: 'GEAR-ONE', amountMinor: '50' }],
  ['set_product_sale', { sku: 'GEAR-ONE', amountMinor: 5000, regular: 1 }],
  ['set_product_sale', { sku: 'GEAR-ONE', amountMinor: 5000, actor: { orgId: 'forged' } }],
  ['set_product_sale', { sku: 'GEAR-ONE', amountMinor: 5000, startsAt: '2026-02-30T00:00:00.000Z' }],
  ['set_product_sale', { sku: 'GEAR-ONE', amountMinor: 5000, startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z' }],
  ['bulk_product_sale', { percent: 20 }],
  ['bulk_product_sale', { selection: { skus: [] }, percent: 20 }],
  ['bulk_product_sale', { selection: { skus: ['GEAR-ONE', 'GEAR-ONE'] }, percent: 20 }],
  ['bulk_product_sale', { selection: { skus: ['GEAR-ONE'], category: 'gear' }, percent: 20 }],
  ['bulk_product_sale', { selection: { category: 'gear' }, percent: 90 }],
  ['list_orders', { q: 'private-email' }],
  ['list_products', { pageSize: 51 }],
  ['list_products', { page: 0 }],
])('strict validation before database: %s %j', async (name, args) => {
  const result = JSON.parse((await invoke(rpc('tools/call', { name, arguments: args }))).body).result;
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text).error.code).toBe('INVALID_ARGUMENTS');
  expect(openStore).not.toHaveBeenCalled();
});

test('argument size/depth and unknown tool are rejected before database use', async () => {
  for (const args of [{ q: 'x'.repeat(16400) }, { a: { b: { c: { d: { e: { f: { g: { h: {} } } } } } } } }]) {
    const result = JSON.parse((await invoke(rpc('tools/call', { name: 'list_products', arguments: args }))).body).result;
    expect(result.isError).toBe(true);
  }
  const unknown = JSON.parse((await invoke(rpc('tools/call', { name: 'deleteProduct', arguments: {} }))).body).result;
  expect(JSON.parse(unknown.content[0].text).error.code).toBe('UNKNOWN_TOOL');
  expect(openStore).not.toHaveBeenCalled();
});

test('result payload limit is inclusive and oversized read results are errors, never truncated', async () => {
  const initial = await getProduct(store, { sku: 'GEAR-ONE' });
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...initial, shortDescription: '' }));
  await store.collection('products').updateOne({ sku: 'GEAR-ONE' }, { $set: { shortDescription: 'x'.repeat(1048576 - baseBytes) } });
  resetCatalogCache();
  const exact = JSON.parse((await invoke(rpc('tools/call', { name: 'get_product', arguments: { sku: 'GEAR-ONE' } }))).body).result;
  expect(exact.isError).toBeUndefined();
  expect(Buffer.byteLength(exact.content[0].text)).toBe(1048576);
  await store.collection('products').updateOne({ sku: 'GEAR-ONE' }, { $set: { shortDescription: 'x'.repeat(1048577 - baseBytes) } });
  resetCatalogCache();
  const oversized = JSON.parse((await invoke(rpc('tools/call', { name: 'get_product', arguments: { sku: 'GEAR-ONE' } }))).body).result;
  expect(oversized.isError).toBe(true);
  expect(JSON.parse(oversized.content[0].text).error.code).toBe('OUTPUT_TOO_LARGE');
});

test('client media and protocol headers are validated rather than silently replaced', async () => {
  const headers = { 'x-wknd-mcp-key': config.MCP_SHARED_SECRET, 'content-type': 'application/json' };
  expect((await invoke(rpc('tools/list'), { __ow_headers: headers })).statusCode).toBe(406);
  expect((await invoke(rpc('tools/list'), { __ow_headers: { ...headers, accept: 'application/json, text/event-stream', 'mcp-protocol-version': 'invalid' } })).statusCode).toBe(400);
  expect(openStore).not.toHaveBeenCalled();
});

test('official SDK client can initialize/list/read/write through raw Runtime adapter', async () => {
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const result = await main({
      ...config, __ow_method: request.method,
      __ow_headers: Object.fromEntries(request.headers),
      __ow_body: Buffer.from(await request.text()).toString('base64'),
      __ims_oauth_s2s: { injected: 'service-credentials' },
    });
    return new Response(result.statusCode === 204 ? null : result.body, { status: result.statusCode, headers: result.headers });
  };
  const client = new Client({ name: 'test-coworker', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example/commerce-mcp'), {
    fetch, requestInit: { headers: { 'x-wknd-mcp-key': config.MCP_SHARED_SECRET } },
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBe(16);
    const read = await client.callTool({ name: 'get_product', arguments: { sku: 'GEAR-ONE' } });
    expect(JSON.parse(read.content[0].text).prices[0].regular).toBe(100);
    const write = await client.callTool({ name: 'set_product_sale', arguments: { sku: 'GEAR-ONE', amountMinor: 7500 } });
    expect(JSON.parse(write.content[0].text)).toMatchObject({ ok: true, committed: true, affected: ['GEAR-ONE'] });
    expect(await store.collection('prices').findOne({ sku: 'GEAR-ONE' })).toMatchObject({ regular: 100, special: 75 });
    expect(openStore).toHaveBeenCalledWith({ __ims_oauth_s2s: { injected: 'service-credentials' }, __ims_env: undefined, DB_REGION: undefined });
    expect(JSON.stringify(openStore.mock.calls)).not.toContain(config.MCP_SHARED_SECRET);
  } finally {
    await client.close();
  }
});

test('errors and resource-close failures are explicit and never include raw diagnostics', async () => {
  openStore.mockRejectedValueOnce(new Error('private-database-detail'));
  const error = JSON.parse((await invoke(rpc('tools/call', { name: 'get_product', arguments: { sku: 'GEAR-ONE' } }))).body).result;
  expect(error.isError).toBe(true);
  expect(error.content[0].text).not.toContain('private-database-detail');
  store.close = jest.fn().mockRejectedValue(new Error('private-close-detail'));
  await invoke(rpc('tools/call', { name: 'get_product', arguments: { sku: 'GEAR-ONE' } }));
  expect(logger.error).toHaveBeenCalledWith('mcp.store.close-failed', { correlationId: expect.any(String) });
});
