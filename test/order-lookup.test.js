const { createMemoryStore } = require('../lib/store');
const { findOrderByToken } = require('../lib/orders');

describe('order lookup for the order details page', () => {
  const store = createMemoryStore();
  beforeAll(async () => {
    await store.collection('orders').insertOne({ number: 'WKND-DEMO-261118-AAAAAA', token: 'guest-token-1234567890abcdef', customerSub: 'auth0|me' });
  });

  test('guest token', async () => {
    expect((await findOrderByToken(store, 'guest-token-1234567890abcdef')).number).toBe('WKND-DEMO-261118-AAAAAA');
  });

  test('signed-in customer opens their own order by number (drop-in sends >20-char refs as tokens)', async () => {
    const order = await findOrderByToken(store, 'WKND-DEMO-261118-AAAAAA', { sub: 'auth0|me' });
    expect(order.customerSub).toBe('auth0|me');
  });

  test('order numbers never resolve for guests or other customers', async () => {
    await expect(findOrderByToken(store, 'WKND-DEMO-261118-AAAAAA')).rejects.toThrow(/couldn't locate/);
    await expect(findOrderByToken(store, 'WKND-DEMO-261118-AAAAAA', { sub: 'auth0|other' })).rejects.toThrow(/couldn't locate/);
  });
});
