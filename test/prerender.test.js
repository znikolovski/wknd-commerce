const fs = require('node:fs');
const path = require('node:path');
const { getStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { resetCatalogCache } = require('../lib/catalog');
const { main } = require('../actions/prerender/index');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
const ADMIN = 'https://admin.hlx.page';
const SITE = 'znikolovski/masterclass-demo/main';
const base = {
  STORE: 'memory', HLX_ORG: 'znikolovski', HLX_SITE: 'masterclass-demo', HLX_ADMIN_API_KEY: 'k', PDP_MARKUP_URL: 'https://overlay',
};
const [p1, p2] = CATALOG.products.filter((p) => p.status !== 'disabled');
const path1 = `/shop/products/${p1.urlKey}`;
const path2 = `/shop/products/${p2.urlKey}`;

let calls;
let previewAttempts;
const json = (body) => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(body) });

beforeAll(async () => {
  resetCatalogCache();
  await importCatalog(await getStore({ STORE: 'memory' }), CATALOG, { replace: true });
});

beforeEach(() => {
  calls = [];
  previewAttempts = 0;
  global.fetch = jest.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url, body, headers: init.headers || {} });
    if (url.startsWith(ADMIN) && !init.body && init.headers?.['Content-Type']) {
      return { ok: false, status: 400, headers: new Map([['x-error', 'error parsing request body']]), text: async () => '' };
    }
    if (url.startsWith('https://overlay')) return json({});
    const job = (name) => json({ links: { self: `${ADMIN}/job/${SITE}/preview/${name}` } });
    if (method === 'POST' && url === `${ADMIN}/preview/${SITE}/*`) {
      previewAttempts += 1;
      return job(`job-${previewAttempts}`);
    }
    if (url.endsWith('/details')) {
      // first attempt: path2 times out in html2md; the retry succeeds
      const resources = url.includes('job-1')
        ? [{ path: path1, status: 200 }, { path: path2, status: 504 }]
        : [{ path: path2, status: 200 }];
      return json({ data: { resources } });
    }
    if (url.includes('/job/')) return json({ state: 'stopped' });
    return json({});
  });
});

afterAll(() => { delete global.fetch; });

test('warms the overlay, retries failed previews and publishes only previewed paths', async () => {
  const res = await main({ ...base, skus: [p1.sku, p2.sku] });
  expect(res.mode).toBe('publish');
  expect(res.previewed.sort()).toEqual([path1, path2].sort());
  expect(res.errors).toEqual([]);
  expect(calls[0].url.startsWith('https://overlay')).toBe(true);
  expect(previewAttempts).toBe(2);
  const live = calls.find((c) => c.url === `${ADMIN}/live/${SITE}/*`);
  expect(live.body.paths.sort()).toEqual([path1, path2].sort());
  const firstLive = calls.indexOf(live);
  const lastDetails = calls.map((c) => c.url).lastIndexOf(`${ADMIN}/job/${SITE}/preview/job-2/details`);
  expect(firstLive).toBeGreaterThan(lastDetails);
});

test('PDP_PUBLISH=false previews without publishing', async () => {
  const res = await main({ ...base, PDP_PUBLISH: 'false', skus: [p1.sku] });
  expect(res).toMatchObject({ mode: 'preview', previewed: [path1], published: [] });
  expect(calls.some((c) => c.url.includes('/live/'))).toBe(false);
  expect(calls.some((c) => c.url === `${ADMIN}/preview/${SITE}${path1}` && c.method === 'POST')).toBe(true);
});

test('no API key is a no-op', async () => {
  expect(await main({ ...base, HLX_ADMIN_API_KEY: '' })).toEqual({ skipped: 'HLX_ADMIN_API_KEY not configured' });
  expect(global.fetch).not.toHaveBeenCalled();
});
