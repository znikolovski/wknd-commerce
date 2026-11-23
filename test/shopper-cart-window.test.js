const { createMemoryStore } = require('../lib/store');
const { createCart } = require('../lib/cart');
const {
  createShopperCartWindow, mapShopperCartWindow, HOUR_MS, MAX_IDLE_MS,
} = require('../lib/shopper-cart-window');
const { POLICY_V1 } = require('../lib/recovery-policy');
const { refreshStageCartWindows } = require('../lib/stage-cart-window-tick');

const NOW = Date.parse('2026-11-23T09:00:00.000Z');
const SUB = 'auth0|synthetic-window';
let store;
let cart;
let clock;
let reader;
beforeEach(async () => {
  jest.useFakeTimers().setSystemTime(NOW - HOUR_MS);
  store = createMemoryStore();
  cart = await createCart(store, { customerSub: SUB });
  await store.collection('carts').updateOne({ id: cart.id }, { $set: { items: [{ quantity: 1 }] } });
  clock = NOW;
  jest.setSystemTime(NOW);
  reader = createShopperCartWindow({ store, claims: { sub: SUB }, clock: () => clock });
});
afterEach(() => jest.useRealTimers());

test('one-hour inclusive threshold and seven-day inclusive maximum are clock-driven, not AAM day recency', async () => {
  clock = NOW - 1;
  expect((await reader.read()).window).toBe('outside-window');
  clock = NOW;
  expect((await reader.read()).window).toBe('within-window');
  clock = NOW - HOUR_MS + MAX_IDLE_MS;
  expect((await reader.read()).window).toBe('within-window');
  clock += 1;
  expect((await reader.read()).window).toBe('outside-window');
  expect(POLICY_V1.minInactivityMs).toBe(24 * HOUR_MS);
});

test('activity reset changes episode aggregate and a later one-hour crossing can requalify', async () => {
  const first = await reader.read();
  await store.collection('carts').updateOne({ id: cart.id }, { $set: {
    activityAt: new Date(NOW).toISOString(), revision: 1,
  } });
  expect((await reader.read()).window).toBe('outside-window');
  clock = NOW + HOUR_MS;
  const later = await reader.read();
  expect(later.window).toBe('within-window');
  expect(later.episodeSet).not.toBe(first.episodeSet);
});

test('purchase invalidates all older episodes but not a subsequent activity episode; malformed purchase stays unknown', async () => {
  await store.collection('orders').insertOne({
    customerSub: SUB, createdAt: new Date(NOW).toISOString(), status: 'Processing (demo)',
  });
  expect((await reader.read()).window).toBe('outside-window');
  await store.collection('carts').updateOne({ id: cart.id }, { $set: {
    activityAt: new Date(NOW + 1).toISOString(), revision: 1,
  } });
  clock = NOW + 1 + HOUR_MS;
  expect((await reader.read()).window).toBe('within-window');
  await store.collection('orders').insertOne({ customerSub: SUB, createdAt: 'bad-date', status: 'Processing (demo)' });
  const unknown = await reader.read();
  expect(unknown.window).toBe('unknown');
  expect(unknown.candidateCartCount).toBeNull();
  expect(mapShopperCartWindow(unknown)).not.toHaveProperty('c_wknd_stage_shopper_cart_count');
});

test('shopper aggregate is not last-event-cart: empty/new carts do not overwrite another valid cart; merge retires source', async () => {
  const other = await createCart(store, { customerSub: SUB });
  expect((await reader.read()).candidateCartCount).toBe(1);
  await store.collection('carts').updateOne({ id: cart.id }, { $set: { status: 'merged', mergedInto: other.id } });
  expect((await reader.read()).window).toBe('outside-window');
  await store.collection('carts').updateOne({ id: other.id }, { $set: {
    activityAt: new Date(NOW).toISOString(), items: [{ quantity: 1 }], mergedSources: [cart.id],
  } });
  expect((await reader.read()).window).toBe('outside-window');
  clock = NOW + HOUR_MS;
  expect((await reader.read()).candidateCartCount).toBe(1);
  expect(JSON.stringify(mapShopperCartWindow(await reader.read()))).not.toContain(SUB);
});

test('order inserted during observation aborts rather than emitting a stale absence; timers default OFF', async () => {
  const orders = store.collection('orders');
  const find = orders.find.bind(orders);
  let first = true;
  jest.spyOn(orders, 'find').mockImplementation(async (...args) => {
    const snapshot = await find(...args);
    if (first) {
      first = false;
      await orders.insertOne({ customerSub: SUB, createdAt: new Date(NOW).toISOString(), status: 'Processing (demo)' });
    }
    return snapshot;
  });
  await expect(reader.read()).rejects.toMatchObject({ code: 'FACT_CHANGED' });
  const transport = jest.fn();
  expect(await refreshStageCartWindows({ store, params: {}, namespace: '28538-wkndcommerce', fetchImpl: transport })).toEqual({ state: 'disabled' });
  expect(transport).not.toHaveBeenCalled();
});
