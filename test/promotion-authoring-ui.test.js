const React = require('react');
const { act, create } = require('react-test-renderer');
const { callAdmin } = require('../src/dx-excshell-1/web-src/src/api');
const { default: AudienceDraftPreview } = require('../src/dx-excshell-1/web-src/src/components/AudienceDraftPreview');
const { previewAudienceDraft } = require('../lib/promotion-authoring');

jest.mock('../src/dx-excshell-1/web-src/src/api', () => ({ callAdmin: jest.fn() }));
jest.mock('../src/dx-excshell-1/web-src/src/shell-context', () => ({ useShell: () => ({ ims: { token: 'test-token', org: 'test-org' } }) }));
jest.mock('@adobe/react-spectrum', () => {
  const React = require('react');
  const names = ['Button', 'Content', 'Form', 'Heading', 'InlineAlert', 'NumberField', 'Radio', 'RadioGroup', 'Text', 'TextArea', 'TextField', 'View'];
  return Object.fromEntries(names.map((name) => [name, (props) => React.createElement(name, props, props.children)]));
});

let renderer;
beforeEach(() => {
  callAdmin.mockReset().mockImplementation(async (_ims, _op, args) => previewAudienceDraft(args));
  act(() => { renderer = create(React.createElement(AudienceDraftPreview)); });
});
afterEach(() => { act(() => renderer.unmount()); });
const root = () => renderer.root;
const text = () => JSON.stringify(renderer.toJSON());
const preview = async () => act(async () => root().findByType('Button').props.onPress());

test('picker preserves canonical IDs, previews disabled drafts and clears stale output when changed', async () => {
  expect(root().findAllByType('Radio').map((radio) => radio.props.value)).toEqual(['climbing-interest', 'climbing-planner']);
  expect(text()).toContain('27507403');
  expect(text()).toContain('27507404');
  expect(text()).toContain('Activation blocked');
  await act(async () => root().findByType('RadioGroup').props.onChange('climbing-planner'));
  await preview();
  expect(callAdmin).toHaveBeenCalledWith(expect.any(Object), 'promotions.previewAudienceDraft', expect.objectContaining({
    environment: 'stage', audienceKey: 'climbing-planner',
    promotion: expect.objectContaining({ enabled: false, audienceRestriction: null, discount: { kind: 'percentage', basisPoints: 1000 } }),
  }), { endpoint: 'promotions' });
  expect(root().findByType('TextArea').props.value).toContain('"persisted": false');
  act(() => root().findByType('TextField').props.onChange('New draft'));
  expect(root().findAllByType('TextArea')).toHaveLength(0);
  expect(callAdmin.mock.calls.every((call) => call[1] === 'promotions.previewAudienceDraft')).toBe(true);
});

test('service rejection and transport errors are visible, never success-shaped output', async () => {
  act(() => root().findByType('TextField').props.onChange(' '));
  await preview();
  expect(text()).toContain('Fixture draft arguments are invalid');
  expect(text()).toContain('/promotion/name');
  expect(root().findAllByType('TextArea')).toHaveLength(0);
  callAdmin.mockRejectedValueOnce(new Error('Authoring preview not deployed'));
  await preview();
  expect(text()).toContain('Authoring preview not deployed');
  expect(root().findAllByType('TextArea')).toHaveLength(0);
});
