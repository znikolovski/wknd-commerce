/**
 * Golden evaluation fixtures from wknd.promotions/v1 §6 (frozen candidate.5).
 */
const { evaluatePromotions, gstMinor } = require('../lib/promotion-evaluation');

const id = (suffix) => `prm_${'0'.repeat(30)}${suffix}`;
const base = {
  enabled: true,
  maxDiscountMinor: null,
  minimumMerchandiseMinor: null,
  startsAt: null,
  endsAt: null,
  audienceRestriction: null,
  revision: 1,
  managementClass: 'standard',
};
const DEFS = {
  P10: {
    ...base, id: id('01'), name: 'P10', mode: 'coupon', code: 'TEN10', discount: { kind: 'percentage', basisPoints: 1000 }, target: { kind: 'all' },
  },
  F20: {
    ...base, id: id('02'), name: 'F20', mode: 'coupon', code: 'FIX20', discount: { kind: 'fixed', amountMinor: 2000, currency: 'AUD' }, target: { kind: 'all' },
  },
  R10: {
    ...base, id: id('03'), name: 'R10', managementClass: 'protected-recovery', mode: 'coupon', code: 'RECOVER10', discount: { kind: 'percentage', basisPoints: 1000 }, maxDiscountMinor: 2500, target: { kind: 'categories', values: ['gear'] },
  },
  A01: {
    ...base, id: id('11'), name: 'A01', mode: 'automatic', code: null, discount: { kind: 'fixed', amountMinor: 1000, currency: 'AUD' }, target: { kind: 'all' },
  },
  A02: {
    ...base, id: id('12'), name: 'A02', mode: 'automatic', code: null, discount: { kind: 'percentage', basisPoints: 1000 }, target: { kind: 'all' },
  },
  A03: {
    ...base, id: id('13'), name: 'A03', mode: 'automatic', code: null, discount: { kind: 'fixed', amountMinor: 1500, currency: 'AUD' }, target: { kind: 'all' },
  },
};
const CATALOG = {
  'GEAR-TEE-M': { parentSku: 'GEAR-TEE', categories: ['gear/tops'] },
  'GEAR-TEE-S': { parentSku: 'GEAR-TEE', categories: ['gear/tops'] },
  'GEAR-PACK': { parentSku: 'GEAR-PACK', categories: ['gear/packs'] },
  'OTHER-MUG': { parentSku: 'OTHER-MUG', categories: ['other'] },
  'GEARBOX-KIT': { parentSku: 'GEARBOX-KIT', categories: ['gearbox'] },
};
const lineOf = (l) => ({
  id: l.id, sku: l.sku, ...CATALOG[l.sku], grossMinor: l.saleGrossMinor,
});
const trustedRecovery = (p) => (p.managementClass === 'protected-recovery' ? { ok: true, capMinor: 2500 } : { ok: true });
const NOW = Date.parse('2026-11-20T04:30:00.000Z');

function run(c, extra = {}) {
  const promotions = c.promotions.map((ref) => ({ ...DEFS[ref], ...(c.overrides?.[ref] || {}) }));
  return evaluatePromotions({
    promotions,
    lines: c.lines.map(lineOf),
    explicitCode: c.explicitCode ?? null,
    nowMs: NOW,
    trust: c.trustedRecoveryFixture ? trustedRecovery : undefined,
    ...extra,
  });
}

const CASES = [
  {
    case: 'percentage-sale-first', promotions: ['P10'], explicitCode: ' ten10 ', lines: [{ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 8000 }], shippingMinor: 995, expected: { selected: 'P10', merchandiseMinor: 8000, discountMinor: 800, allocations: { L1: 800 }, grandMinor: 8195, gstMinor: 745 },
  },
  {
    case: 'fixed-largest-remainder', promotions: ['F20'], explicitCode: 'FIX20', lines: [{ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 3333 }, { id: 'L2', sku: 'GEAR-PACK', saleGrossMinor: 6667 }], expected: { selected: 'F20', discountMinor: 2000, allocations: { L1: 667, L2: 1333 }, grandMinor: 8000, gstMinor: 727 },
  },
  {
    case: 'fixed-cannot-exceed-lines', promotions: ['F20'], explicitCode: 'FIX20', lines: [{ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 1500 }], expected: { selected: 'F20', discountMinor: 1500, allocations: { L1: 1500 }, grandMinor: 0, gstMinor: 0 },
  },
  {
    case: 'recovery-cap-and-proportional-allocation', promotions: ['R10'], explicitCode: 'RECOVER10', trustedRecoveryFixture: true, lines: [{ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 10000 }, { id: 'L2', sku: 'GEAR-PACK', saleGrossMinor: 20000 }], expected: { selected: 'R10', discountMinor: 2500, allocations: { L1: 833, L2: 1667 }, grandMinor: 27500, gstMinor: 2500 },
  },
  {
    case: 'target-minimum-uses-all-merchandise', promotions: ['F20'], overrides: { F20: { minimumMerchandiseMinor: 10000, target: { kind: 'categories', values: ['gear'] } } }, explicitCode: 'FIX20', lines: [{ id: 'L1', sku: 'GEAR-TEE-S', saleGrossMinor: 6000 }, { id: 'L2', sku: 'OTHER-MUG', saleGrossMinor: 4000 }], expected: { selected: 'F20', discountMinor: 2000, allocations: { L1: 2000 }, grandMinor: 8000, gstMinor: 727 },
  },
  {
    case: 'category-prefix-is-not-subtree', promotions: ['F20'], overrides: { F20: { target: { kind: 'categories', values: ['gear'] } } }, explicitCode: 'FIX20', lines: [{ id: 'L1', sku: 'GEARBOX-KIT', saleGrossMinor: 10000 }], expectedError: 'COUPON_NO_ELIGIBLE_LINES',
  },
  {
    case: 'minimum-one-cent-below', promotions: ['F20'], overrides: { F20: { minimumMerchandiseMinor: 10000 } }, explicitCode: 'FIX20', lines: [{ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 9999 }], expectedError: 'COUPON_MINIMUM_NOT_MET',
  },
  {
    case: 'best-automatic', promotions: ['A01', 'A02', 'A03'], lines: [{ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 10000 }], expected: { selected: 'A03', discountMinor: 1500, allocations: { L1: 1500 }, grandMinor: 8500, gstMinor: 773 },
  },
  {
    case: 'automatic-equal-saving-stable-id', promotions: ['A02', 'A01'], lines: [{ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 10000 }], expected: { selected: 'A01', discountMinor: 1000, allocations: { L1: 1000 }, grandMinor: 9000, gstMinor: 818 },
  },
  {
    case: 'eligible-explicit-coupon-wins-over-better-automatic', promotions: ['P10', 'A03'], explicitCode: 'TEN10', lines: [{ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 10000 }], expected: { selected: 'P10', discountMinor: 1000, allocations: { L1: 1000 }, grandMinor: 9000, gstMinor: 818 },
  },
  {
    case: 'invalid-explicit-coupon-not-silently-automatic', promotions: ['A03'], explicitCode: 'BOGUS', lines: [{ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 10000 }], expectedError: 'COUPON_NOT_FOUND',
  },
  {
    case: 'round-half-up-and-equal-remainder-line-id', promotions: ['P10'], explicitCode: 'TEN10', lines: [{ id: 'L2', sku: 'GEAR-TEE-S', saleGrossMinor: 5 }, { id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 5 }], expected: { selected: 'P10', discountMinor: 1, allocations: { L1: 1, L2: 0 }, grandMinor: 9, gstMinor: 1 },
  },
];

describe('wknd.promotions/v1 golden evaluation', () => {
  const errorCases = CASES.filter((c) => c.expectedError);
  const successCases = CASES.filter((c) => !c.expectedError);

  test.each(errorCases.map((c) => [c.case, c]))('%s', (_, c) => {
    const r = run(c);
    expect({ code: r.error?.code, discountMinor: r.discountMinor, selected: r.selected })
      .toEqual({ code: c.expectedError, discountMinor: 0, selected: null });
  });

  test.each(successCases.map((c) => [c.case, c]))('%s', (_, c) => {
    const r = run(c);
    const merchandise = c.lines.reduce((n, l) => n + l.saleGrossMinor, 0);
    const grand = merchandise - r.discountMinor + (c.shippingMinor || 0);
    const positive = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v > 0));
    expect({
      error: r.error,
      selected: r.selected.id,
      discountMinor: r.discountMinor,
      allocations: positive(r.allocations),
      merchandiseMinor: r.merchandiseMinor,
      grandMinor: grand,
      gstMinor: gstMinor(grand),
    }).toEqual({
      error: null,
      selected: DEFS[c.expected.selected].id,
      discountMinor: c.expected.discountMinor,
      allocations: positive(c.expected.allocations),
      merchandiseMinor: c.expected.merchandiseMinor ?? merchandise,
      grandMinor: c.expected.grandMinor,
      gstMinor: c.expected.gstMinor,
    });
  });

  test.each([
    ['2026-11-20T03:59:59.999Z', 'COUPON_OUTSIDE_WINDOW', 0],
    ['2026-11-20T04:00:00.000Z', null, 1000],
    ['2026-11-20T05:00:00.000Z', null, 1000],
    ['2026-11-20T05:00:00.001Z', 'COUPON_OUTSIDE_WINDOW', 0],
  ])('inclusive window at %s', (now, code, discount) => {
    const r = evaluatePromotions({
      promotions: [{ ...DEFS.P10, startsAt: '2026-11-20T04:00:00.000Z', endsAt: '2026-11-20T05:00:00.000Z' }],
      lines: [lineOf({ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 10000 })],
      explicitCode: 'TEN10',
      nowMs: Date.parse(now),
    });
    expect({ code: r.error?.code ?? null, discount: r.discountMinor }).toEqual({ code, discount });
  });

  test('protected recovery is denied without a server trust decision', () => {
    const r = run({ promotions: ['R10'], explicitCode: 'RECOVER10', lines: [{ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 10000 }] });
    expect(r.error.code).toBe('COUPON_ELIGIBILITY_UNAVAILABLE');
  });

  test('protected recovery cap is enforced even if the stored definition is corrupted', () => {
    const r = evaluatePromotions({
      promotions: [{ ...DEFS.R10, maxDiscountMinor: null, discount: { kind: 'percentage', basisPoints: 5000 } }],
      lines: [lineOf({ id: 'L1', sku: 'GEAR-TEE-M', saleGrossMinor: 100000 })],
      explicitCode: 'RECOVER10',
      nowMs: NOW,
      trust: trustedRecovery,
    });
    expect(r.discountMinor).toBe(2500);
  });

  test('evaluation limits fail explicitly instead of truncating', () => {
    const lines = Array.from({ length: 1001 }, (_, i) => lineOf({ id: `L${i}`, sku: 'GEAR-PACK', saleGrossMinor: 1 }));
    expect(evaluatePromotions({ promotions: [DEFS.A01], lines, nowMs: NOW }).error.code).toBe('EVALUATION_LIMIT_EXCEEDED');
  });

  describe('preserved legacy TRAILREADY acceptance (single-authority decision)', () => {
    const TRAILREADY = {
      ...base, id: 'prm_00000000000000000000000000000020', name: 'TRAILREADY', mode: 'coupon', code: 'TRAILREADY', discount: { kind: 'fixed', amountMinor: 2000, currency: 'AUD' }, minimumMerchandiseMinor: 20000, target: { kind: 'all' }, private: { legacyMinimumOnlyAcceptance: true },
    };
    const lines = (gross) => [lineOf({ id: 'L1', sku: 'GEAR-PACK', saleGrossMinor: gross })];
    const evalAt = (gross, explicitCode, extra = []) => evaluatePromotions({
      promotions: [TRAILREADY, DEFS.A03, ...extra], lines: lines(gross), explicitCode, nowMs: NOW,
    });

    test('below minimum is accepted with zero saving and suppresses automatics', () => {
      const r = evalAt(19999, 'TRAILREADY');
      expect(r.error).toBeNull();
      expect(r.coupon).toEqual({ code: 'TRAILREADY', status: 'accepted-below-minimum' });
      expect(r.discountMinor).toBe(0);
      expect(r.selected.id).toBe(TRAILREADY.id);
    });
    test('exactly AUD 200 saves AUD 20', () => {
      expect(evalAt(20000, 'TRAILREADY').discountMinor).toBe(2000);
    });
    test('removing the coupon restores automatic selection', () => {
      const r = evalAt(19999, null);
      expect(r.selected.id).toBe(DEFS.A03.id);
      expect(r.discountMinor).toBe(1500);
    });
    test('replacement must pass normal validation', () => {
      const r = evalAt(19999, 'WKND10', [{
        ...base, id: 'prm_00000000000000000000000000000010', name: 'WKND10', mode: 'coupon', code: 'WKND10', discount: { kind: 'percentage', basisPoints: 1000 }, target: { kind: 'all' }, private: { legacyMinimumOnlyAcceptance: true },
      }]);
      expect(r.discountMinor).toBe(2000);
    });
    test('the exception never applies to new non-legacy coupons', () => {
      const r = evaluatePromotions({
        promotions: [{ ...TRAILREADY, id: id('99'), code: 'NEWMIN', private: {} }], lines: lines(19999), explicitCode: 'NEWMIN', nowMs: NOW,
      });
      expect(r.error.code).toBe('COUPON_MINIMUM_NOT_MET');
    });
    test('disabled legacy coupons still reject', () => {
      const r = evaluatePromotions({
        promotions: [{ ...TRAILREADY, enabled: false }], lines: lines(19999), explicitCode: 'TRAILREADY', nowMs: NOW,
      });
      expect(r.error.code).toBe('COUPON_DISABLED');
    });
  });
});
