const { createMemoryStore } = require('../lib/store');
const { createCart, saveCart, removeItem } = require('../lib/cart');
const { createServerCartFacts } = require('../lib/server-cart-facts');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-23T07:00:00.000Z');
const SUB = 'auth0|private-shopper';
const CART_ID = 'private-cart-reference';
const iso = (ms) => new Date(ms).toISOString();
let store;
let cart;
let publisher;
let adapter;

beforeEach(async () => {
  jest.useFakeTimers().setSystemTime(NOW - 30 * HOUR);
  store = createMemoryStore();
  cart = await createCart(store, { id: CART_ID, customerSub: SUB });
  cart = await saveCart(store, {
    ...cart,
    email: 'private@example.com',
    token: 'private-token',
    items: [{ uid: 'one', sku: 'private-sku', quantity: 2 }, { uid: 'two', quantity: 0.5 }],
  });
  jest.setSystemTime(NOW);
  publisher = jest.fn(async () => true);
  adapter = createServerCartFacts({
    store, claims: { sub: SUB }, environment: 'stage', publisher, clock: () => NOW,
  });
});

afterEach(() => jest.useRealTimers());

test('handoff exports only frozen server facts, not identifiers or qualification', async () => {
  const packet = await adapter.handoff(CART_ID);
  expect(packet).toEqual({
    schema: 'wknd.server-cart-facts/v1',
    source: 'server-records',
    environment: 'stage',
    observedAt: iso(NOW),
    cart: {
      state: 'active', version: 'v1', lastActivityAt: iso(NOW - 30 * HOUR),
      activitySource: 'activityAt', itemCount: 2, totalQuantity: 2.5,
    },
    purchase: { sinceLastActivity: 'not-recorded', reason: null, lastOrderAt: null, orderState: 'none' },
    episode: { key: expect.stringMatching(/^cep_[a-f0-9]{64}$/), startedAt: iso(NOW - 30 * HOUR) },
  });
  expect(publisher).toHaveBeenCalledWith(packet);
  expect(JSON.stringify(packet)).not.toMatch(/private-|private@|auth0\||eligible|qualified|member|token|sku|email/);
  expect(Object.values(packet).filter((value) => typeof value === 'object').every(Object.isFrozen)).toBe(true);
});

test('only verified owners can read persisted carts; caller packets cannot be handed off', async () => {
  await expect(adapter.handoff({ cartId: CART_ID, itemCount: 100, purchased: false })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await store.collection('carts').updateOne({ id: CART_ID }, { $set: { customerSub: 'other-owner' } });
  await expect(adapter.handoff(CART_ID)).rejects.toMatchObject({ code: 'CART_UNAVAILABLE', message: 'An owned server cart is required.' });
  await store.collection('carts').updateOne({ id: CART_ID }, { $set: { customerSub: null } });
  await expect(adapter.handoff(CART_ID)).rejects.toMatchObject({ code: 'CART_UNAVAILABLE' });
  await expect(adapter.read('missing-cart')).rejects.toMatchObject({ code: 'CART_UNAVAILABLE' });
  expect(publisher).not.toHaveBeenCalled();
  expect(() => createServerCartFacts({ store, environment: 'stage' })).toThrow('Verified shopper claims are required.');
});

test('purchase facts include actual owner orders across carts, inclusive of episode start', async () => {
  await store.collection('orders').insertMany([
    { customerSub: 'other-owner', createdAt: iso(NOW), status: 'Processing (demo)' },
    { customerSub: SUB, cartId: 'another-cart', createdAt: cart.activityAt, status: 'Processing (demo)', email: 'private@example.com', token: 'private-token' },
    { customerSub: SUB, createdAt: iso(NOW - 40 * HOUR), status: 'Processing (demo)' },
  ]);
  expect((await adapter.read(CART_ID)).purchase).toEqual({
    sinceLastActivity: 'recorded', reason: null, lastOrderAt: cart.activityAt, orderState: 'processing-demo',
  });
  await store.collection('orders').deleteMany({ createdAt: cart.activityAt });
  expect((await adapter.read(CART_ID)).purchase).toEqual({
    sinceLastActivity: 'not-recorded', reason: null, lastOrderAt: iso(NOW - 40 * HOUR), orderState: 'processing-demo',
  });
});

test.each([0, 200])('empty carts and %i hour activity are facts, not eligibility decisions', async (hours) => {
  await saveCart(store, { ...cart, items: [], activityAt: iso(NOW - hours * HOUR) });
  const packet = await adapter.read(CART_ID);
  expect(packet.cart).toMatchObject({ itemCount: 0, totalQuantity: 0, lastActivityAt: iso(NOW - hours * HOUR) });
  expect(packet.purchase.sinceLastActivity).toBe('not-recorded');
});

test('generic writes retain the episode; meaningful item activity starts another', async () => {
  const before = await adapter.read(CART_ID);
  cart = await saveCart(store, { ...cart, email: 'changed@example.com' });
  const generic = await adapter.read(CART_ID);
  expect(generic.episode).toEqual(before.episode);
  expect(generic.cart.version).not.toBe(before.cart.version);
  removeItem(cart, 'two');
  await saveCart(store, cart);
  const active = await adapter.read(CART_ID);
  expect(active.episode.key).not.toBe(before.episode.key);
  expect(active.episode.startedAt).toBe(iso(NOW));
  const production = createServerCartFacts({ store, claims: { sub: SUB }, environment: 'production', clock: () => NOW });
  expect((await production.read(CART_ID)).episode.key).not.toBe(active.episode.key);
});

test('backfilling activity provenance without new activity retains the episode', async () => {
  await store.collection('carts').updateOne({ id: CART_ID }, { $unset: { activityAt: '' } });
  const legacy = await adapter.read(CART_ID);
  await store.collection('carts').updateOne({ id: CART_ID }, { $set: { activityAt: legacy.cart.lastActivityAt } });
  const backfilled = await adapter.read(CART_ID);
  expect(backfilled.cart.activitySource).not.toBe(legacy.cart.activitySource);
  expect(backfilled.episode).toEqual(legacy.episode);
});

test.each([
  [{ activityAt: null }, 'updatedAt', iso(NOW - 30 * HOUR)],
  [{ activityAt: null, updatedAt: null }, 'createdAt', iso(NOW - 30 * HOUR)],
  [{ activityAt: 'malformed' }, 'activityAt', null],
  [{ activityAt: null, updatedAt: null, createdAt: null }, null, null],
  [{ activityAt: iso(NOW + HOUR) }, 'activityAt', null],
])('activity provenance preserves legacy fallback and marks unknown timestamps', async (changes, source, at) => {
  await store.collection('carts').updateOne({ id: CART_ID }, { $set: changes });
  const packet = await adapter.read(CART_ID);
  expect(packet.cart).toMatchObject({ activitySource: source, lastActivityAt: at });
  expect(packet.episode.startedAt).toBe(at);
  expect(packet.episode.key === null).toBe(at === null);
  expect(packet.purchase).toMatchObject({
    sinceLastActivity: at ? 'not-recorded' : 'unknown', reason: at ? null : 'ACTIVITY_UNKNOWN',
  });
});

test.each([
  { createdAt: undefined, status: 'Processing (demo)' },
  { createdAt: 'malformed', status: 'Processing (demo)' },
  { createdAt: iso(NOW + HOUR), status: 'Processing (demo)' },
  { createdAt: iso(NOW - 40 * HOUR), status: 'private@example.com' },
])('unknown order records never become a negative purchase fact', async (order) => {
  await store.collection('orders').insertOne({ customerSub: SUB, ...order });
  expect((await adapter.read(CART_ID)).purchase).toEqual({
    sinceLastActivity: 'unknown', reason: 'ORDER_RECORD_UNKNOWN', lastOrderAt: null, orderState: 'unknown',
  });
  await store.collection('orders').insertOne({ customerSub: SUB, createdAt: iso(NOW), status: 'Processing (demo)' });
  expect((await adapter.read(CART_ID)).purchase.sinceLastActivity).toBe('recorded');
});

test.each(['ordering', 'ordered', 'merging', 'merged'])('a %s cart with no order is not proof of no purchase', async (status) => {
  await store.collection('carts').updateOne({ id: CART_ID }, { $set: { status } });
  expect((await adapter.read(CART_ID)).purchase).toMatchObject({
    sinceLastActivity: 'unknown', reason: 'CART_NOT_ACTIVE', orderState: 'unknown',
  });
});

test('a persisted order proves purchase during ordering and after the ordered-cart save', async () => {
  await store.collection('carts').updateOne({ id: CART_ID }, { $set: { status: 'ordering' } });
  await store.collection('orders').insertOne({
    customerSub: SUB, cartId: CART_ID, createdAt: iso(NOW), status: 'Processing (demo)',
  });
  expect((await adapter.read(CART_ID)).purchase).toEqual({
    sinceLastActivity: 'recorded', reason: null, lastOrderAt: iso(NOW), orderState: 'processing-demo',
  });
  await saveCart(store, { ...cart, status: 'ordered' }, { from: 'ordering' });
  const packet = await adapter.read(CART_ID);
  expect(packet.cart.state).toBe('ordered');
  expect(packet.purchase.sinceLastActivity).toBe('recorded');
});

test('changed snapshots and database errors cannot reach the publisher', async () => {
  const orders = store.collection('orders');
  const find = orders.find.bind(orders);
  jest.spyOn(orders, 'find').mockImplementationOnce(async (filter) => {
    await store.collection('carts').updateOne({ id: CART_ID }, { $inc: { revision: 1 } });
    return find(filter);
  });
  await expect(adapter.handoff(CART_ID)).rejects.toMatchObject({ code: 'CART_CHANGED' });
  orders.find.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(adapter.handoff(CART_ID)).rejects.toThrow('database unavailable');
  expect(publisher).not.toHaveBeenCalled();
});

test('invalid cart quantities cannot leak through as a valid packet', async () => {
  await store.collection('carts').updateOne({ id: CART_ID }, { $set: { items: [{ quantity: '2' }] } });
  await expect(adapter.handoff(CART_ID)).rejects.toMatchObject({ code: 'INVALID_CART_RECORD' });
  expect(publisher).not.toHaveBeenCalled();
});

test('handoff requires an explicit positive acknowledgement and never retries', async () => {
  const readOnly = createServerCartFacts({ store, claims: { sub: SUB }, environment: 'stage' });
  await expect(readOnly.handoff(CART_ID)).rejects.toMatchObject({ code: 'PUBLISHER_NOT_CONFIGURED' });
  publisher.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('transport unavailable'));
  await expect(adapter.handoff(CART_ID)).rejects.toMatchObject({ code: 'HANDOFF_NOT_ACKNOWLEDGED' });
  await expect(adapter.handoff(CART_ID)).rejects.toThrow('transport unavailable');
  expect(publisher).toHaveBeenCalledTimes(2);
});
