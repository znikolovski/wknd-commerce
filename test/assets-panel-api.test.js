const { callAssets } = require('../src/aem-assets-assetsview-1/web-src/src/api');

jest.mock('../src/dx-excshell-1/web-src/src/config.json', () => ({
  'commerce-assets/manage': 'https://test.adobeio-static.net/api/v1/web/commerce-assets/manage',
}), { virtual: true });

const originalFetch = global.fetch;
const path = '/content/dam/wknd-adventures/products/product.jpg';
const result = { revision: 'r1', skus: [], roles: [], positions: [], links: [] };
let guest;
beforeEach(() => {
  guest = {
    host: {
      auth: {
        getIMSInfo: jest.fn(async () => ({ accessToken: 'test-token', imsOrg: 'test-org' })),
        getApiKey: jest.fn(async () => 'test-key'),
      },
      discovery: { getAemHost: jest.fn(async () => 'https://author-p1-e2.adobeaemcloud.com') },
      details: { getCurrentResourceInfo: jest.fn(async () => ({ path })) },
    },
  };
  global.fetch = jest.fn().mockImplementation(async () => new Response(JSON.stringify(result)));
});
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });

test('reads fresh host identity, uses Runtime directly, and sends the selected asset context', async () => {
  await expect(callAssets(guest, 'asset.get', { assetPath: path })).resolves.toEqual(result);
  expect(global.fetch).toHaveBeenCalledWith(
    'https://test.adobeioruntime.net/api/v1/web/commerce-assets/manage',
    expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token', 'x-gw-ims-org-id': 'test-org' },
      body: JSON.stringify({ assetPath: path, op: 'asset.get', authorUrl: 'https://author-p1-e2.adobeaemcloud.com', apiKey: 'test-key' }),
    }),
  );
});

test('blocks a stale selected asset before mutation and discards results after navigation', async () => {
  await expect(callAssets(guest, 'asset.save', { assetPath: `${path}.other` })).rejects.toThrow('selected asset changed');
  expect(global.fetch).not.toHaveBeenCalled();
  guest.host.details.getCurrentResourceInfo.mockResolvedValueOnce({ path }).mockResolvedValueOnce({ path: `${path}.other` });
  await expect(callAssets(guest, 'asset.get', { assetPath: path })).rejects.toThrow('selected asset changed');
});

test.each([
  [new Response(JSON.stringify({ error: 'AEM denied access' }), { status: 403 }), 'AEM denied access'],
  [new Response('gateway failure', { status: 502 }), 'unreadable response'],
  [new Response('{}'), 'invalid result'],
])('surfaces errors without accepting success-shaped defaults', async (response, message) => {
  global.fetch.mockResolvedValueOnce(response);
  await expect(callAssets(guest, 'asset.get', { assetPath: path })).rejects.toThrow(message);
});

test('supports bounded product search results and requires a signed-in identity', async () => {
  global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], total: 0 })));
  await expect(callAssets(guest, 'products.search', { q: 'none' })).resolves.toEqual({ items: [], total: 0 });
  guest.host.auth.getIMSInfo.mockResolvedValueOnce({});
  await expect(callAssets(guest, 'products.search')).rejects.toThrow('identity is unavailable');
});

test('cancels in-flight calls and reports timeouts without retrying saves', async () => {
  jest.useFakeTimers();
  global.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const controller = new AbortController();
  const cancelled = callAssets(guest, 'asset.get', {}, { signal: controller.signal }).catch((error) => error);
  await jest.advanceTimersByTimeAsync(0);
  controller.abort();
  expect(await cancelled).toMatchObject({ name: 'AbortError' });
  const pending = callAssets(guest, 'asset.save', {}).catch((error) => error);
  await jest.advanceTimersByTimeAsync(50000);
  expect(await pending).toMatchObject({ message: expect.stringContaining('timed out') });
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
