const React = require('react');
const { act, create } = require('react-test-renderer');
const { callAdmin } = require('../src/dx-excshell-1/web-src/src/api');
const { default: AudienceDraftPreview } = require('../src/dx-excshell-1/web-src/src/components/AudienceDraftPreview');
const { createMemoryStore } = require('../lib/store');
const { createPromotionsAdmin } = require('../lib/promotions-admin');
const { randomUUID } = require('node:crypto');

jest.mock('../src/dx-excshell-1/web-src/src/api', () => ({ callAdmin: jest.fn() }));
jest.mock('../src/dx-excshell-1/web-src/src/shell-context', () => ({ useShell: () => ({ ims: { token: 'test-token', org: 'test-org' } }) }));
jest.mock('@adobe/react-spectrum', () => {
  const React = require('react');
  const names = ['Button', 'Content', 'Form', 'Heading', 'InlineAlert', 'NumberField', 'Radio', 'RadioGroup', 'Text', 'TextArea', 'TextField', 'View'];
  return Object.fromEntries(names.map((name) => [name, (props) => React.createElement(name, props, props.children)]));
});

let renderer;
const originalWindow = global.window;
beforeAll(() => { global.window = { crypto: { randomUUID } }; });
afterAll(() => { global.window = originalWindow; });
beforeEach(() => {
  const api = createPromotionsAdmin({ store: createMemoryStore() });
  callAdmin.mockReset().mockImplementation(async (_ims, op, args) => api.handle({ kind: 'ims-operator', subject: 'author', orgId: 'test-org' }, op, args));
  act(() => { renderer = create(React.createElement(AudienceDraftPreview)); });
});
afterEach(() => { act(() => renderer.unmount()); });
const root = () => renderer.root;
const text = () => JSON.stringify(renderer.toJSON());
const button = (label) => root().findAllByType('Button').find((b) => React.Children.toArray(b.props.children).join('') === label);
const preview = async () => act(async () => button('Validate draft').props.onPress());

test('picker validates, persists, reopens, updates and deletes through the same draft service', async () => {
  expect(root().findAllByType('Radio').map((radio) => radio.props.value)).toEqual(['climbing-interest', 'climbing-planner']);
  expect(text()).toContain('27507403');
  expect(text()).toContain('27507404');
  expect(text()).toContain('Activation blocked');
  await act(async () => root().findByType('RadioGroup').props.onChange('climbing-planner'));
  await preview();
  expect(callAdmin).toHaveBeenCalledWith(expect.any(Object), 'promotions.drafts.validate', expect.objectContaining({
    promotion: expect.objectContaining({ enabled: false, audienceRestriction: { environment: 'stage', key: 'climbing-planner', version: 1 }, discount: { kind: 'percentage', basisPoints: 1000 } }),
  }), { endpoint: 'promotions' });
  expect(root().findByType('TextArea').props.value).toContain('"persisted": false');
  await act(async () => button('Save disabled draft').props.onPress());
  const saved = JSON.parse(root().findByType('TextArea').props.value);
  expect(saved).toMatchObject({ persisted: true, draft: { revision: 1 } });
  await act(async () => button('Load saved drafts').props.onPress());
  await act(async () => button('Open Climbing audience demo').props.onPress());
  act(() => root().findByType('TextField').props.onChange('New draft'));
  expect(root().findAllByType('TextArea')).toHaveLength(0);
  await act(async () => button('Save draft changes').props.onPress());
  expect(JSON.parse(root().findByType('TextArea').props.value).draft).toMatchObject({ id: saved.draft.id, revision: 2, promotion: { name: 'New draft' } });
  await act(async () => button('Delete draft').props.onPress());
  expect(JSON.parse(root().findByType('TextArea').props.value)).toMatchObject({ deleted: true });
  expect(callAdmin.mock.calls.every((call) => call[1].startsWith('promotions.drafts.'))).toBe(true);
});

test('service rejection and transport errors are visible, never success-shaped output', async () => {
  act(() => root().findByType('TextField').props.onChange(' '));
  await preview();
  expect(text()).toContain('Draft definition is invalid');
  expect(text()).toContain('/promotion/name');
  expect(root().findAllByType('TextArea')).toHaveLength(0);
  callAdmin.mockRejectedValueOnce(new Error('Authoring preview not deployed'));
  await preview();
  expect(text()).toContain('Authoring preview not deployed');
  expect(root().findAllByType('TextArea')).toHaveLength(0);
});

test('opening a fixed coupon draft preserves non-edited terms and nullable cap on full replacement', async () => {
  const created = await callAdmin({}, 'promotions.drafts.create', {
    idempotencyKey: randomUUID(),
    promotion: {
      name: 'Fixed coupon draft', mode: 'coupon', code: 'FIXED_AUD', enabled: false,
      discount: { kind: 'fixed', amountMinor: 500, currency: 'AUD' }, maxDiscountMinor: null,
      minimumMerchandiseMinor: 1000, target: { kind: 'skus', values: ['GEAR-ONE'] },
      startsAt: '2026-11-23T00:00:00.000Z', endsAt: '2026-12-23T00:00:00.000Z',
      audienceRestriction: { environment: 'stage', key: 'climbing-interest', version: 1 },
    },
  });
  await act(async () => button('Load saved drafts').props.onPress());
  await act(async () => button('Open Fixed coupon draft').props.onPress());
  expect(root().findAllByType('NumberField')[0].props.label).toBe('Fixed discount (AUD)');
  act(() => root().findByType('TextField').props.onChange('Renamed fixed draft'));
  await act(async () => button('Save draft changes').props.onPress());
  expect(JSON.parse(root().findByType('TextArea').props.value).draft.promotion).toEqual({ ...created.draft.promotion, name: 'Renamed fixed draft' });
});
