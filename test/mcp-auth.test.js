const {
  requestHeaders, authenticateIntegration, checkOrigin,
} = require('../lib/mcp-auth');

const config = { MCP_SHARED_SECRET: 's'.repeat(43), MCP_ORG_ID: 'test-org@AdobeOrg' };

test('key authenticates a shared integration, never an IMS user', () => {
  const headers = requestHeaders({ 'X-WKND-MCP-Key': config.MCP_SHARED_SECRET, 'X-GW-IMS-Org-Id': 'forged' });
  expect(authenticateIntegration(config, headers)).toEqual({
    kind: 'integration', subject: 'cx-coworker', orgId: config.MCP_ORG_ID,
  });
  expect(Object.isFrozen(authenticateIntegration(config, headers))).toBe(true);
});

test.each([undefined, '', 'wrong', 's'.repeat(42), 's'.repeat(10000)])('invalid key rejected (%s)', (key) => {
  expect(() => authenticateIntegration(config, { 'x-wknd-mcp-key': key })).toThrow('A valid commerce MCP key is required.');
});

test.each([{}, { ...config, MCP_SHARED_SECRET: 'short' }, { ...config, MCP_ORG_ID: '' }])('missing configuration fails closed', (params) => {
  expect(() => authenticateIntegration(params, { 'x-wknd-mcp-key': config.MCP_SHARED_SECRET })).toThrow('not configured');
});

test('rejects duplicate or nonstring headers', () => {
  expect(() => requestHeaders({ key: 'one', KEY: 'two' })).toThrow('Invalid request headers');
  expect(() => requestHeaders({ key: ['one', 'two'] })).toThrow('Invalid request headers');
});

test('Origin is optional but browser origins require an exact configured match', () => {
  expect(checkOrigin({}, {})).toEqual({});
  expect(() => checkOrigin({}, { origin: 'https://attacker.example' })).toThrow('not allowed');
  expect(() => checkOrigin({ MCP_ALLOWED_ORIGINS: '*' }, { origin: '*' })).toThrow('not allowed');
  expect(checkOrigin({ MCP_ALLOWED_ORIGINS: 'https://coworker.example' }, { origin: 'https://coworker.example' }))
    .toMatchObject({ 'Access-Control-Allow-Origin': 'https://coworker.example' });
});
