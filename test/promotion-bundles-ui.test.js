const React = require('react');
const { act, create } = require('react-test-renderer');
const { randomUUID } = require('node:crypto');
const { callAdmin } = require('../src/dx-excshell-1/web-src/src/api');
const { default: BundleOpportunities, bundleDraft } = require('../src/dx-excshell-1/web-src/src/components/BundleOpportunities');
const { default: Promotions, PromotionEditor } = require('../src/dx-excshell-1/web-src/src/components/Promotions');
const { ToastQueue } = require('@adobe/react-spectrum');

jest.mock('../src/dx-excshell-1/web-src/src/api', () => ({
  callAdmin: jest.fn(),
  formatDate: (value) => value,
  formatMoney: (value) => `AUD ${value.toFixed(2)}`,
}));
jest.mock('../src/dx-excshell-1/web-src/src/shell-context', () => ({
  useShell: () => ({ ims: { token: 'local-fixture', org: 'local-fixture' } }),
}));
jest.mock('@adobe/react-spectrum', () => {
  const React = require('react');
  const names = [
    'AlertDialog', 'Badge', 'Button', 'ButtonGroup', 'Cell', 'Checkbox', 'CheckboxGroup', 'Column',
    'Content', 'DatePicker', 'Dialog', 'DialogContainer', 'Divider', 'Flex', 'Form', 'Heading',
    'InlineAlert', 'NumberField', 'Radio', 'RadioGroup', 'Row', 'StatusLight', 'Switch',
    'TableHeader', 'TableView', 'Text', 'TextArea', 'TextField', 'View',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, (props) => React.createElement(name, props, props.children)])),
    TableBody: ({ items, children, ...props }) => React.createElement('TableBody', props, items.map(children)),
    ToastQueue: { positive: jest.fn(), negative: jest.fn() },
  };
});

const quote = {
  bundleId: `bnd_${'a'.repeat(32)}`,
  experimentId: null,
  name: 'Hiking kit',
  classification: 'thematic',
  scoreExplanation: 'Shared category; no observed co-purchase support.',
  components: [
    { sku: 'PACK-MOSS', quantity: 1, unitPriceMinor: 12900, availableQuantity: 27, unitsSold: 0 },
    { sku: 'BOTTLE-GLAC', quantity: 2, unitPriceMinor: 4900, availableQuantity: 26, unitsSold: 0 },
  ],
  merchandiseMinor: 22700,
  safetyBuffer: 2,
  quoteExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
};
const evidence = {
  apiVersion: 'wknd.bundling/v1',
  asOf: new Date().toISOString(),
  currency: 'AUD',
  window: { startsAt: '2026-10-25T00:00:00.000Z', endsAt: '2026-11-24T00:00:00.000Z' },
  evidence: {
    provenance: 'Persisted demo records, not commercial trading.',
    ordersMatched: 3, ordersScanned: 10, orderLimit: 10, truncated: true,
    missingMetrics: ['margin', 'surplus'],
  },
  opportunities: [quote],
};

let renderer;
let onSelect;
const originalWindow = global.window;
beforeAll(() => { global.window = { crypto: { randomUUID } }; });
afterAll(() => { global.window = originalWindow; });
beforeEach(() => {
  jest.clearAllMocks();
  callAdmin.mockReset().mockResolvedValue(evidence);
  onSelect = jest.fn();
  act(() => { renderer = create(React.createElement(BundleOpportunities, { onSelect })); });
});
afterEach(() => {
  act(() => renderer.unmount());
  jest.restoreAllMocks();
});
const root = () => renderer.root;
const text = () => JSON.stringify(renderer.toJSON());
const button = (label) => root().findAllByType('Button').find((b) => React.Children.toArray(b.props.children).join('') === label);
const analyze = () => act(async () => button('Investigate bundles').props.onPress());
const mount = async (component) => {
  act(() => renderer.unmount());
  await act(async () => { renderer = create(component); });
};
const field = (type, label) => root().findAllByType(type).find((node) => node.props.label === label);
const confirmSave = async (label) => {
  act(() => button(label).props.onPress());
  await act(async () => root().findAllByType('AlertDialog').find((dialog) => dialog.props.primaryActionLabel === label).props.onPrimaryAction());
};

const savedBundle = {
  ...bundleDraft(quote),
  id: 'promo_saved_bundle',
  revision: 7,
  code: null,
  discount: { kind: 'fixed', amountMinor: 1250, currency: 'AUD' },
  maxDiscountMinor: 2000,
  minimumMerchandiseMinor: 10000,
  startsAt: '2026-11-24T00:00:00.000Z',
  endsAt: '2026-12-24T23:59:59.000Z',
  audienceRestriction: null,
};

test('editing a saved bundle preserves the full quote, fixed AUD terms, dates and revision binding', async () => {
  const onSave = jest.fn();
  await mount(React.createElement(PromotionEditor, {
    promotion: savedBundle, categories: [], onSave,
  }));
  expect(field('RadioGroup', 'Applies to').props.isDisabled).toBe(true);
  expect(root().findByType('Switch').props.isDisabled).toBe(true);
  expect(root().findByType('Switch').props.isSelected).toBe(false);
  act(() => field('TextField', 'Name').props.onChange('Renamed quoted kit'));
  await confirmSave('Save');
  expect(onSave).toHaveBeenCalledTimes(1);
  const request = onSave.mock.calls[0][0];
  const { id, revision, ...definition } = savedBundle;
  expect(request).toEqual({
    id, expectedRevision: revision, idempotencyKey: expect.any(String),
    promotion: { ...definition, name: 'Renamed quoted kit' },
  });
  expect(request.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
  expect(callAdmin).not.toHaveBeenCalled();
});

test('bundle editor converts edited fixed AUD amounts, limits and UTC dates without changing components', async () => {
  const onSave = jest.fn();
  await mount(React.createElement(PromotionEditor, {
    promotion: savedBundle, categories: [], onSave,
  }));
  act(() => {
    field('NumberField', 'Amount off').props.onChange(15.75);
    field('NumberField', 'Maximum discount (optional)').props.onChange(NaN);
    field('NumberField', 'Minimum spend (optional)').props.onChange(123.45);
    root().findAllByType('DatePicker')[0].props.onChange({ toString: () => '2026-12-01' });
    root().findAllByType('DatePicker')[1].props.onChange({ toString: () => '2026-12-31' });
  });
  await confirmSave('Save');
  expect(onSave.mock.calls[0][0].promotion).toMatchObject({
    enabled: false,
    discount: { kind: 'fixed', amountMinor: 1575, currency: 'AUD' },
    maxDiscountMinor: null,
    minimumMerchandiseMinor: 12345,
    startsAt: '2026-12-01T00:00:00.000Z',
    endsAt: '2026-12-31T23:59:59.000Z',
    target: savedBundle.target,
  });
});

test('new bundle presets cannot enable an offer through the editor even if preset enabled is true', async () => {
  const preset = { ...bundleDraft(quote), enabled: true };
  const onSave = jest.fn();
  await mount(React.createElement(PromotionEditor, { preset, categories: [], onSave }));
  const status = root().findByType('Switch');
  expect(status.props.isDisabled).toBe(true);
  expect(status.props.isSelected).toBe(false);
  act(() => status.props.onChange(true));
  await confirmSave('Create');
  expect(onSave.mock.calls[0][0]).toEqual({
    idempotencyKey: expect.any(String),
    promotion: {
      ...preset, enabled: false, code: null, maxDiscountMinor: null, minimumMerchandiseMinor: null,
      startsAt: null, endsAt: null, audienceRestriction: null,
    },
  });
  expect(callAdmin).not.toHaveBeenCalled();
});

test.each(['create', 'update'])('unknown %s outcome retains its key through failed receipt checks and committed success', async (operation) => {
  const receiptResponses = [
    new Error('Receipt adapter unavailable'),
    { ok: false, committed: null, error: { code: 'REQUEST_NOT_FOUND', message: 'Receipt not found' } },
    { ok: false, committed: false, error: { code: 'IDEMPOTENCY_RECORD_EXPIRED', message: 'Receipt expired' } },
    undefined,
  ];
  callAdmin.mockImplementation(async (_ims, operation) => {
    switch (operation) {
      case 'promotions.list': return { ok: true, items: [savedBundle], nextCursor: null };
      case 'categories.list': return { items: [] };
      case 'promotions.authoringAudiences':
        return { environment: 'stage', audiences: [{ key: 'climbing-interest', label: 'Climbing interest', version: 1 }] };
      case 'email.status': return null;
      case 'email.runs': return [];
      case 'promotions.bundleOpportunities': return evidence;
      case 'promotions.create':
      case 'promotions.update': throw new Error('Connection lost after dispatch');
      case 'promotions.get': {
        if (receiptResponses.length) {
          const response = receiptResponses.shift();
          if (response instanceof Error) throw response;
          return response;
        }
        return { ok: true, committed: true, promotion: { id: 'promo_committed' } };
      }
      default: throw new Error(`Unexpected operation ${operation}`);
    }
  });
  await mount(React.createElement(Promotions));
  expect(root().findAllByType('Row')).toHaveLength(1);
  if (operation === 'create') {
    await analyze();
    act(() => button('Use as disabled draft').props.onPress());
  } else {
    act(() => button('Edit').props.onPress());
  }
  await confirmSave(operation === 'create' ? 'Create' : 'Save');
  const writes = () => callAdmin.mock.calls.filter((call) => ['promotions.create', 'promotions.update', 'promotions.get'].includes(call[1]));
  expect(writes()).toHaveLength(1);
  const originalKey = writes()[0][2].idempotencyKey;
  expect(writes()[0][1]).toBe(`promotions.${operation}`);
  expect(text()).toContain('save outcome is unknown');
  expect(root().findAllByType(PromotionEditor)).toHaveLength(1);
  expect(ToastQueue.positive).not.toHaveBeenCalled();
  for (let check = 0; check < 4; check += 1) {
    await act(async () => button('Check saved request').props.onPress());
    expect(root().findAllByType(PromotionEditor)).toHaveLength(1);
    expect(ToastQueue.positive).not.toHaveBeenCalled();
    expect(text()).toContain('Promotion save failed');
    expect(writes().filter((call) => call[1] !== 'promotions.get')).toHaveLength(1);
  }
  await act(async () => button('Check saved request').props.onPress());
  expect(writes().map((call) => call[1])).toEqual([`promotions.${operation}`, ...Array(5).fill('promotions.get')]);
  for (const lookup of writes().slice(1)) expect(lookup).toEqual([
    expect.any(Object), 'promotions.get',
    { request: { operation, idempotencyKey: originalKey } },
    { endpoint: 'promotions' },
  ]);
  expect(root().findAllByType(PromotionEditor)).toHaveLength(0);
  expect(ToastQueue.positive).toHaveBeenCalledWith(
    operation === 'create' ? 'Promotion created (disabled until you enable it)' : 'Promotion saved', { timeout: 4000 },
  );
});

test('investigation is an IMS-protected bounded read and selecting a kit only opens a disabled complete-bundle proposal', async () => {
  expect(callAdmin).not.toHaveBeenCalled();
  await analyze();
  expect(callAdmin).toHaveBeenCalledWith(
    { token: 'local-fixture', org: 'local-fixture' },
    'promotions.bundleOpportunities', { limit: 5, safetyBuffer: 2 }, { endpoint: 'promotions' },
  );
  expect(text()).toContain('scan is truncated');
  expect(text()).toContain('not commercial trading');
  expect(text()).toContain('Unavailable metrics: margin, surplus');
  expect(text()).toContain('Aero is a separate demo flight booking');
  act(() => button('Use as disabled draft').props.onPress());
  expect(onSelect).toHaveBeenCalledWith({
    name: 'Hiking kit', enabled: false, mode: 'automatic',
    discount: { kind: 'percentage', basisPoints: 500 },
    target: {
      kind: 'bundle', bundleId: quote.bundleId, experimentId: null, currency: 'AUD',
      quoteExpiresAt: quote.quoteExpiresAt, safetyBuffer: 2,
      components: [
        { sku: 'PACK-MOSS', quantity: 1, unitPriceMinor: 12900 },
        { sku: 'BOTTLE-GLAC', quantity: 2, unitPriceMinor: 4900 },
      ],
    },
  });
  expect(callAdmin).toHaveBeenCalledTimes(1);
});

test('an empty investigation and an expired quote cannot fabricate an actionable offer', async () => {
  callAdmin.mockResolvedValueOnce({ ...evidence, opportunities: [] });
  await analyze();
  expect(text()).toContain('No compatible kits meet the stock safety buffer');
  expect(button('Use as disabled draft')).toBeUndefined();
  callAdmin.mockResolvedValueOnce({
    ...evidence, opportunities: [{ ...quote, quoteExpiresAt: '2000-01-01T00:00:00.000Z' }],
  });
  await analyze();
  expect(button('Use as disabled draft')).toBeUndefined();
  expect(text()).toContain('quote has expired');
  expect(onSelect).not.toHaveBeenCalled();
});

test('selection rechecks quote expiry even when time advances without a render', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(quote.quoteExpiresAt) - 1);
  await analyze();
  const select = button('Use as disabled draft');
  expect(select.props.isDisabled).toBe(false);
  now.mockReturnValue(Date.parse(quote.quoteExpiresAt));
  act(() => select.props.onPress());
  expect(onSelect).not.toHaveBeenCalled();
  expect(text()).toContain('quote has expired');
  expect(button('Use as disabled draft')).toBeUndefined();
});

test.each([
  ['null opportunity', (data) => { data.opportunities.push(null); }],
  ['null component', (data) => { data.opportunities[0].components.push(null); }],
  ['non-array components', (data) => { data.opportunities[0].components = {}; }],
  ['malformed evidence metrics', (data) => { data.evidence.missingMetrics = {}; }],
  ['object provenance', (data) => { data.evidence.provenance = {}; }],
  ['duplicate SKU', (data) => { data.opportunities[0].components.push(data.opportunities[0].components[0]); }],
  ['duplicate bundle ID', (data) => { data.opportunities.push(data.opportunities[0]); }],
  ['invalid bundle ID', (data) => { data.opportunities[0].bundleId = 'bnd_invalid'; }],
  ['invalid experiment ID', (data) => { data.opportunities[0].experimentId = {}; }],
  ['oversized experiment ID', (data) => { data.opportunities[0].experimentId = 'x'.repeat(65); }],
  ['unsafe price', (data) => { data.opportunities[0].components[0].unitPriceMinor = Number.MAX_SAFE_INTEGER + 1; }],
  ['fractional quantity', (data) => { data.opportunities[0].components[0].quantity = 1.5; }],
  ['zero quantity', (data) => { data.opportunities[0].components[0].quantity = 0; }],
  ['oversized quantity', (data) => { data.opportunities[0].components[0].quantity = 21; }],
  ['zero price', (data) => { data.opportunities[0].components[0].unitPriceMinor = 0; }],
  ['negative inventory', (data) => { data.opportunities[0].components[0].availableQuantity = -1; }],
  ['nonfinite units sold', (data) => { data.opportunities[0].components[0].unitsSold = Infinity; }],
  ['negative evidence count', (data) => { data.evidence.ordersMatched = -1; }],
  ['NaN evidence count', (data) => { data.evidence.ordersScanned = NaN; }],
  ['inconsistent merchandise sum', (data) => { data.opportunities[0].merchandiseMinor += 1; }],
  ['invalid quote date', (data) => { data.opportunities[0].quoteExpiresAt = 'not-a-date'; }],
  ['non-UTC quote date', (data) => { data.opportunities[0].quoteExpiresAt = '2099-01-01T11:15:00.000+11:00'; }],
  ['impossible calendar date', (data) => { data.window.startsAt = '2026-02-30T00:00:00.000Z'; }],
  ['non-string snapshot date', (data) => { data.asOf = 0; }],
  ['invalid window date', (data) => { data.window.startsAt = 'not-a-date'; }],
  ['invalid currency', (data) => { data.currency = 'USD'; }],
  ['invalid safety buffer', (data) => { data.opportunities[0].safetyBuffer = 21; }],
  ['quote beyond 15 minutes', (data) => { data.opportunities[0].quoteExpiresAt = new Date(Date.parse(data.asOf) + 900001).toISOString(); }],
  ['nonfinite score', (data) => { data.opportunities[0].score = Infinity; }],
  ['claimed financial approval', (data) => { data.opportunities[0].financiallyApproved = true; }],
  ['claimed combined reservation', (data) => { data.opportunities[0].aero = { separatePurchase: true, atomicReservation: true }; }],
])('rejects the entire response with %s before rendering any draft', async (_label, mutate) => {
  const data = JSON.parse(JSON.stringify(evidence));
  mutate(data);
  callAdmin.mockResolvedValueOnce(data);
  await analyze();
  expect(text()).toContain('returned an invalid response');
  expect(button('Use as disabled draft')).toBeUndefined();
  expect(text()).not.toContain('Observed demo evidence');
  expect(onSelect).not.toHaveBeenCalled();
});

test('service, transport and invalid response failures replace old evidence with explicit errors', async () => {
  await analyze();
  for (const response of [
    { ok: false, error: { message: 'The window is invalid.' } },
    { opportunities: [] },
  ]) {
    callAdmin.mockResolvedValueOnce(response);
    await analyze();
    expect(button('Use as disabled draft')).toBeUndefined();
    expect(text()).toContain('Bundle investigation failed');
  }
  callAdmin.mockRejectedValueOnce(new Error('Bundle read unavailable'));
  await analyze();
  expect(text()).toContain('Bundle read unavailable');
  expect(button('Use as disabled draft')).toBeUndefined();
});
