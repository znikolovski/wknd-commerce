/**
 * Database Storage returns 64-bit integers as BSON Long objects; reads must yield plain numbers
 * so millisecond timestamps (entitlement/receipt/run expiry) compare and format correctly.
 */
const { createMemoryStore, normalizeLongs } = require('../lib/store');

const asLong = (ms, unsigned = false) => ({ low: ms % 2 ** 32 | 0, high: Math.floor(ms / 2 ** 32), unsigned });

test('Long-shaped values become numbers, recursively', () => {
  const ms = 1795212855438;
  expect(normalizeLongs({
    expiresAtMs: asLong(ms),
    nested: { list: [asLong(ms, true), { low: -1, high: -1, unsigned: false }] },
    at: new Date(0),
    text: 'x',
  })).toEqual({ expiresAtMs: ms, nested: { list: [ms, -1] }, at: new Date(0), text: 'x' });
});

test('objects that merely contain low/high keys are left alone, key order preserved', () => {
  const doc = { unsigned: false, low: 1, high: 0, extra: true };
  expect(Object.keys(normalizeLongs(doc))).toEqual(['unsigned', 'low', 'high', 'extra']);
  expect(normalizeLongs({ low: 'a', high: 'b', unsigned: false })).toEqual({ low: 'a', high: 'b', unsigned: false });
});

test('BSON Long instances (toNumber) are converted', () => {
  const long = { low: 5, high: 0, toNumber: () => 5 };
  expect(normalizeLongs({ v: long })).toEqual({ v: 5 });
});

test('store reads return numbers usable in Date and arithmetic', async () => {
  const store = createMemoryStore();
  const ms = Date.UTC(2026, 10, 26, 21, 13, 31, 69);
  await store.collection('recovery_entitlements').insertOne({ _id: 'k', key: 'k', expiresAtMs: asLong(ms) });
  const ent = await store.collection('recovery_entitlements').findOne({ key: 'k' });
  expect(new Date(ent.expiresAtMs).toISOString()).toBe('2026-11-26T21:13:31.069Z');
  expect(ent.expiresAtMs + 1).toBe(ms + 1);
});
