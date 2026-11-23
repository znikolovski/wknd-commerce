const fs = require('node:fs');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { loadCatalog, resetCatalogCache } = require('../lib/catalog');
const { placeOrder } = require('../lib/orders');
const { sendOrderConfirmations } = require('../lib/order-email');
const { BrevoError } = require('../lib/brevo');
const { emailParams } = require('../lib/email-config');

const CATALOG = JSON.parse(fs.readFileSync(`${__dirname}/../data/catalog.json`, 'utf8'));
const PARAMS = {
  BREVO_API_KEY: 'offline-only',
  ORDER_CONFIRMATION_ENABLED: 'true',
  ORDER_CONFIRMATION_SENDER_EMAIL: 'hello@example.com',
  ORDER_CONFIRMATION_SENDER_NAME: 'WKND Adventures',
};
let store;
let now;
let sendEmail;
const run = (params = PARAMS) => sendOrderConfirmations({
  store, params, clock: () => now, createClient: () => ({ sendEmail }),
});

async function orderFixture() {
  resetCatalogCache();
  await importCatalog(store, CATALOG, { replace: true });
  const cat = await loadCatalog(store);
  const product = CATALOG.products.find((p) => p.type === 'simple'
    && cat.stockBySku.get(p.sku)?.qty > 2);
  const cart = {
    id: 'offline-cart', status: 'active', email: 'guest@example.com',
    items: [{ uid: 'line', sku: product.sku, parentSku: product.sku, quantity: 1 }],
    shippingAddress: { country_code: 'AU' }, billingAddress: { firstname: 'Guest' },
    shippingMethod: { carrier_code: 'wknd', method_code: 'standard' },
    paymentMethod: 'wknd_demo_pay', coupons: [],
  };
  await store.collection('carts').insertOne(cart);
  return { cat, cart };
}

beforeEach(() => {
  store = createMemoryStore();
  now = Date.parse('2026-11-23T00:00:00Z');
  sendEmail = jest.fn().mockResolvedValue({ messageId: 'offline-message' });
});

test('durable completed guest order queues exactly one receipt with persisted totals, without marketing consent', async () => {
  const { cat, cart } = await orderFixture();
  const order = await placeOrder(store, cat, cart, null);
  expect(order.emailConfirmation.state).toBe('pending');
  expect(sendEmail).not.toHaveBeenCalled();
  await Promise.all([run(), run()]);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(sendEmail.mock.calls[0][0].textContent).toContain(`Total: AUD ${order.totals.grandTotal.toFixed(2)}`);
  expect(sendEmail.mock.calls[0][0].textContent).toContain('no payment was taken');
  await run();
  expect(sendEmail).toHaveBeenCalledTimes(1);
});

test('failed order insert cannot enqueue mail; post-insert failure does not lose the durable outbox', async () => {
  const { cat, cart } = await orderFixture();
  const orders = store.collection('orders');
  const insert = jest.spyOn(orders, 'insertOne').mockRejectedValueOnce(new Error('offline insert failure'));
  await expect(placeOrder(store, cat, cart, null)).rejects.toThrow('offline insert failure');
  await run();
  expect(sendEmail).not.toHaveBeenCalled();
  insert.mockRestore();
  await store.collection('carts').updateOne({ id: cart.id }, { $set: { status: 'active' } });
  jest.spyOn(store.collection('carts'), 'replaceOne').mockRejectedValueOnce(new Error('offline post-insert failure'));
  await expect(placeOrder(store, cat, cart, null)).rejects.toThrow('offline post-insert failure');
  await run();
  expect(sendEmail).toHaveBeenCalledTimes(1);
});

test('missing configuration does not claim pending mail; definite rate limit retries, ambiguous acceptance never does', async () => {
  const { cat, cart } = await orderFixture();
  const order = await placeOrder(store, cat, cart, null);
  expect(await run({ ...PARAMS, BREVO_API_KEY: '' })).toEqual({ state: 'not-configured' });
  sendEmail.mockRejectedValueOnce(new BrevoError('rate limit', { status: 429, ambiguous: false }));
  expect(await run()).toMatchObject({ deferred: 1 });
  await run();
  expect(sendEmail).toHaveBeenCalledTimes(1);
  now += 5 * 60 * 1000;
  sendEmail.mockRejectedValueOnce(new BrevoError('timeout', { ambiguous: true }));
  expect(await run()).toMatchObject({ unknown: 1 });
  await run();
  expect(sendEmail).toHaveBeenCalledTimes(2);
  expect((await store.collection('orders').findOne({ id: order.id })).emailConfirmation.state).toBe('unknown');
});

test('accepted mail with failed persistence remains sending then becomes unknown, never resent', async () => {
  const { cat, cart } = await orderFixture();
  await placeOrder(store, cat, cart, null);
  const orders = store.collection('orders');
  const update = orders.updateOne.bind(orders);
  jest.spyOn(orders, 'updateOne').mockImplementation((filter, change, ...rest) => {
    if (change.$set?.emailConfirmation?.state === 'sent') throw new Error('offline persistence failure');
    return update(filter, change, ...rest);
  });
  await expect(run()).rejects.toThrow('offline persistence failure');
  now += 11 * 60 * 1000;
  expect(await run()).toMatchObject({ unknown: 1 });
  expect(sendEmail).toHaveBeenCalledTimes(1);
});

test('automatic defaults apply only to the real Production namespace', () => {
  const old = process.env.__OW_NAMESPACE;
  try {
    process.env.__OW_NAMESPACE = '28538-wkndcommerce-stage';
    expect(emailParams({})).toEqual({});
    process.env.__OW_NAMESPACE = '28538-wkndcommerce';
    expect(emailParams({})).toMatchObject({ RECOVERY_EMAIL_AUTOMATION_ENABLED: 'true', SHOP_CART_URL: 'https://wknd-adventures.run.place/shop/cart' });
    expect(emailParams({ RECOVERY_EMAIL_AUTOMATION_ENABLED: 'false' }).RECOVERY_EMAIL_AUTOMATION_ENABLED).toBe('false');
  } finally {
    if (old === undefined) delete process.env.__OW_NAMESPACE;
    else process.env.__OW_NAMESPACE = old;
  }
});
