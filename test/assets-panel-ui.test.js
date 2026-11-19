const React = require('react');
const { act, create } = require('react-test-renderer');
const { attach, register } = require('@adobe/uix-guest');
const { callAssets } = require('../src/aem-assets-assetsview-1/web-src/src/api');
const { default: ProductLinks } = require('../src/aem-assets-assetsview-1/web-src/src/components/ProductLinks');
const { default: Registration, extensionId } = require('../src/aem-assets-assetsview-1/web-src/src/components/Registration');

jest.mock('@adobe/uix-guest', () => ({ attach: jest.fn(), register: jest.fn() }));
jest.mock('../src/aem-assets-assetsview-1/web-src/src/api', () => ({ callAssets: jest.fn() }));
jest.mock('@spectrum-icons/workflow/Add', () => () => null);
jest.mock('@spectrum-icons/workflow/ChevronDown', () => () => null);
jest.mock('@spectrum-icons/workflow/ChevronUp', () => () => null);
jest.mock('@spectrum-icons/workflow/Edit', () => () => null);
jest.mock('@spectrum-icons/workflow/Link', () => () => null);
jest.mock('@spectrum-icons/workflow/Refresh', () => () => null);
jest.mock('@adobe/react-spectrum', () => {
  const React = require('react');
  const names = ['ActionButton', 'Button', 'Checkbox', 'CheckboxGroup', 'Content', 'Divider', 'Flex', 'Form', 'Heading',
    'IllustratedMessage', 'InlineAlert', 'NumberField', 'ProgressCircle', 'Provider', 'SearchField', 'Text', 'View'];
  return { defaultTheme: {}, ...Object.fromEntries(names.map((name) => [name, (props) => React.createElement(name, props, props.children)])) };
});

const initial = {
  assetId: 'urn:aaid:aem:12345678-1234-1234-1234-123456789012',
  path: '/content/dam/wknd-adventures/products/product.jpg',
  name: 'product.jpg', revision: 'revision-1', isCommerce: true,
  skus: ['WKND-JKT-001'], roles: ['image'], positions: ['2'], approval: 'approved', links: [],
};
let guest;
let renderer;
beforeEach(() => {
  guest = {
    host: {
      theme: { getThemeInfo: jest.fn(async () => ({ colorScheme: 'dark' })) },
      details: { getCurrentResourceInfo: jest.fn(async () => ({ path: initial.path })) },
    },
  };
  attach.mockReset().mockResolvedValue(guest);
  register.mockReset().mockResolvedValue({});
  callAssets.mockReset().mockImplementation(async (_guest, op, args) => {
    if (op === 'products.search') return { items: [{ sku: 'WKND-JKT-001-GLACIER-S', name: 'Jacket glacier small', type: 'variant' }], total: 1 };
    if (op === 'asset.save') return { ...initial, ...args, revision: 'revision-2', links: args.isCommerce ? [{ sku: args.skus[0] }] : [] };
    return initial;
  });
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = null; });

async function render() {
  await act(async () => { renderer = create(React.createElement(ProductLinks)); });
  return renderer.root;
}
function button(root, label) {
  return root.findAllByType('Button').find((item) => React.Children.toArray(item.props.children).join('') === label);
}
function action(root, label) {
  return root.findAllByType('ActionButton').find((item) => item.props['aria-label'] === label
    || item.findAllByType('Text').some((text) => text.props.children === label));
}
async function submit(root) {
  await act(async () => root.findByType('Form').props.onSubmit({ preventDefault() {} }));
}

test('registers WKND Commerce in Assets Details, not the Workfront suitability UI', async () => {
  await act(async () => { renderer = create(React.createElement(Registration)); });
  const descriptor = register.mock.calls[0][0];
  expect(descriptor.id).toBe(extensionId);
  expect(descriptor.methods.detailSidePanel.getPanels()).toEqual([expect.objectContaining({
    title: 'WKND Commerce', contentUrl: '/assets.html#/product-links',
  })]);
});

test('loads existing mappings and saves selected product/variant SKUs with roles and per-SKU positions', async () => {
  const root = await render();
  expect(attach).toHaveBeenCalledWith({ id: extensionId });
  expect(root.findAllByType('NumberField')).toHaveLength(0);
  expect(root.findAllByType('CheckboxGroup')).toHaveLength(0);
  expect(button(root, 'Save').props.isDisabled).toBe(true);
  await act(async () => action(root, 'Edit WKND-JKT-001').props.onPress());
  expect(root.findByType('NumberField').props.value).toBe(2);
  await act(async () => root.findByType('SearchField').props.onChange('glacier'));
  await act(async () => root.findByType('SearchField').props.onSubmit());
  await act(async () => action(root, 'Add WKND-JKT-001-GLACIER-S').props.onPress());
  expect(root.findByType('SearchField').props.value).toBe('');
  await act(async () => action(root, 'Image settings').props.onPress());
  await act(async () => root.findByType('CheckboxGroup').props.onChange(['image', 'swatch_image']));
  await act(async () => action(root, 'Edit WKND-JKT-001-GLACIER-S').props.onPress());
  await act(async () => root.findByType('NumberField').props.onChange(3));
  await submit(root);
  expect(callAssets).toHaveBeenCalledWith(guest, 'asset.save', expect.objectContaining({
    assetPath: initial.path, revision: 'revision-1', isCommerce: true,
    skus: ['WKND-JKT-001', 'WKND-JKT-001-GLACIER-S'], roles: ['image', 'swatch_image'], positions: [2, 3],
  }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(JSON.stringify(renderer.toJSON())).toContain('Product links saved.');
  expect(button(root, 'Save').props.isDisabled).toBe(true);
});

test('supports explicit disable/unlink and requires a SKU when enabling commerce', async () => {
  const root = await render();
  await act(async () => action(root, 'Edit WKND-JKT-001').props.onPress());
  await act(async () => button(root, 'Unlink product').props.onPress());
  expect(button(root, 'Save').props.isDisabled).toBe(false);
  await act(async () => action(root, 'Image settings').props.onPress());
  const eligibility = root.findAllByType('Checkbox').find((item) => item.props.children === 'Use in commerce');
  expect(eligibility.props.isSelected).toBe(false);
  await act(async () => eligibility.props.onChange(true));
  expect(button(root, 'Save').props.isDisabled).toBe(true);
  await act(async () => eligibility.props.onChange(false));
  expect(button(root, 'Save').props.isDisabled).toBe(false);
  await submit(root);
  expect(callAssets).toHaveBeenCalledWith(guest, 'asset.save', expect.objectContaining({ skus: [], positions: [], isCommerce: false }), expect.anything());
});

test('rejects invalid gallery positions and surfaces backend conflicts without reporting success', async () => {
  const root = await render();
  await act(async () => action(root, 'Edit WKND-JKT-001').props.onPress());
  await act(async () => root.findByType('NumberField').props.onChange(0));
  expect(button(root, 'Save').props.isDisabled).toBe(true);
  expect(root.findByType('NumberField').props.validationState).toBe('invalid');
  await act(async () => root.findByType('NumberField').props.onChange(1));
  callAssets.mockRejectedValueOnce(new Error('Commerce metadata changed. Reload the asset before saving.'));
  await submit(root);
  expect(JSON.stringify(renderer.toJSON())).toContain('metadata changed');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Product links saved.');
});

test('shows loading and errors, allows reload, and preserves custom roles', async () => {
  callAssets.mockRejectedValueOnce(new Error('AEM access denied'));
  const root = await render();
  expect(JSON.stringify(renderer.toJSON())).toContain('AEM access denied');
  expect(root.findAllByType('Form')).toHaveLength(0);
  callAssets.mockResolvedValueOnce({ ...initial, roles: ['image', 'custom_editorial'] });
  await act(async () => action(root, 'Reload asset').props.onPress());
  await act(async () => action(root, 'Image settings').props.onPress());
  expect(root.findByType('CheckboxGroup').props.value).toContain('custom_editorial');
  callAssets.mockResolvedValueOnce({ ...initial, warning: 'Asset is not approved.' });
  await submit(root);
  expect(JSON.stringify(renderer.toJSON())).toContain('Asset is not approved.');
});

test('cancels pending loads and search requests when the panel closes', async () => {
  const root = await render();
  await act(async () => root.findByType('SearchField').props.onSubmit());
  const signals = callAssets.mock.calls.map((call) => call[3].signal);
  act(() => renderer.unmount());
  renderer = null;
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test('shows a quiet empty state and enables commerce when the first product is added', async () => {
  callAssets.mockResolvedValueOnce({ ...initial, isCommerce: false, skus: [], roles: [], positions: [] });
  const root = await render();
  expect(root.findAllByType('IllustratedMessage')).toHaveLength(1);
  expect(root.findAllByType('Checkbox')).toHaveLength(0);
  expect(root.findAllByType('NumberField')).toHaveLength(0);
  expect(button(root, 'Save').props.isDisabled).toBe(true);
  await act(async () => root.findByType('SearchField').props.onChange('glacier'));
  await act(async () => root.findByType('SearchField').props.onSubmit());
  await act(async () => action(root, 'Add WKND-JKT-001-GLACIER-S').props.onPress());
  expect(root.findAllByType('IllustratedMessage')).toHaveLength(0);
  await submit(root);
  expect(callAssets).toHaveBeenLastCalledWith(guest, 'asset.save', expect.objectContaining({
    isCommerce: true, skus: ['WKND-JKT-001-GLACIER-S'], roles: [], positions: [1],
  }), expect.anything());
});

test('cancel restores all saved values without making a backend write', async () => {
  const root = await render();
  await act(async () => action(root, 'Edit WKND-JKT-001').props.onPress());
  await act(async () => root.findByType('NumberField').props.onChange(9));
  await act(async () => action(root, 'Image settings').props.onPress());
  await act(async () => root.findByType('CheckboxGroup').props.onChange(['hero']));
  const eligibility = root.findAllByType('Checkbox').find((item) => item.props.children === 'Use in commerce');
  await act(async () => eligibility.props.onChange(false));
  expect(action(root, 'Reload asset').props.isDisabled).toBe(true);
  await act(async () => action(root, 'Cancel').props.onPress());
  expect(button(root, 'Save').props.isDisabled).toBe(true);
  expect(root.findAllByType('NumberField')).toHaveLength(0);
  expect(root.findAllByType('CheckboxGroup')).toHaveLength(0);
  await act(async () => action(root, 'Edit WKND-JKT-001').props.onPress());
  expect(root.findByType('NumberField').props.value).toBe(2);
  await act(async () => action(root, 'Image settings').props.onPress());
  expect(root.findByType('CheckboxGroup').props.value).toEqual(['image']);
  expect(callAssets.mock.calls.some((call) => call[1] === 'asset.save')).toBe(false);
});

test('changing the search clears stale results and cancels its request', async () => {
  const root = await render();
  expect(JSON.stringify(renderer.toJSON())).not.toContain('results');
  await act(async () => root.findByType('SearchField').props.onSubmit());
  expect(action(root, 'Add WKND-JKT-001-GLACIER-S')).toBeDefined();
  const signal = callAssets.mock.calls[1][3].signal;
  await act(async () => root.findByType('SearchField').props.onChange('another product'));
  expect(signal.aborted).toBe(true);
  expect(action(root, 'Add WKND-JKT-001-GLACIER-S')).toBeUndefined();
});
