/**
 * Deterministic cart promotion evaluation (wknd.promotions/v1 §6). Pure function: callers supply
 * authoritative catalog line facts, current definitions and server-side trust decisions.
 * Integer AUD cents only; BigInt for products/remainders.
 */
/* global BigInt */
const { normalizeCode, parseTimestamp } = require('./promotion-schema');

const LIMITS = {
  lines: 1000, candidates: 1000, lineGross: 1000000000, aggregate: 1000000000,
};

const COUPON_ERRORS = {
  COUPON_NOT_FOUND: 'Coupon code is not valid.',
  COUPON_DISABLED: 'Coupon is disabled.',
  COUPON_OUTSIDE_WINDOW: 'Coupon is outside its valid dates.',
  COUPON_MINIMUM_NOT_MET: 'Coupon merchandise minimum is not met.',
  COUPON_NO_ELIGIBLE_LINES: 'Coupon does not match these items.',
  COUPON_SHOPPER_INELIGIBLE: 'Coupon is not available for this shopper.',
  COUPON_ELIGIBILITY_UNAVAILABLE: 'Coupon eligibility cannot currently be verified.',
  EVALUATION_LIMIT_EXCEEDED: 'Cart promotion evaluation exceeds supported limits.',
  RECOVERY_ALREADY_REDEEMED: 'This offer has already been used.',
};

class EvaluationError extends Error {
  constructor(code) {
    super(COUPON_ERRORS[code]);
    this.code = code;
  }
}

const roundHalfUpDiv = (num, den) => (2n * num + den) / (2n * den);

/** GST-inclusive tax portion: roundHalfUp(grand / 11) in cents. */
const gstMinor = (grandMinor) => Number(roundHalfUpDiv(BigInt(grandMinor), 11n));

function inWindow(p, nowMs) {
  const s = p.startsAt ? parseTimestamp(p.startsAt) : null;
  const e = p.endsAt ? parseTimestamp(p.endsAt) : null;
  return (s === null || nowMs >= s) && (e === null || nowMs <= e);
}

function lineMatches(target, line) {
  if (target.kind === 'all') return true;
  if (target.kind === 'skus') return target.values.includes(line.sku) || target.values.includes(line.parentSku);
  return (line.categories || []).some((c) => target.values.some((v) => c === v || c.startsWith(`${v}/`)));
}

function candidateSaving(p, lines, policyCapMinor) {
  const eligible = lines.filter((l) => lineMatches(p.target, l) && l.grossMinor > 0);
  const eligibleGross = eligible.reduce((n, l) => n + l.grossMinor, 0);
  if (!eligible.length || eligibleGross === 0) return { eligible, eligibleGross, saving: 0 };
  let saving = p.discount.kind === 'percentage'
    ? Number(roundHalfUpDiv(BigInt(eligibleGross) * BigInt(p.discount.basisPoints), 10000n))
    : p.discount.amountMinor;
  saving = Math.min(saving, eligibleGross);
  if (p.maxDiscountMinor != null) saving = Math.min(saving, p.maxDiscountMinor);
  if (policyCapMinor != null) saving = Math.min(saving, policyCapMinor);
  return { eligible, eligibleGross, saving };
}

/** Largest-remainder proportional allocation; ties by ascending line id. */
function allocate(saving, eligible, eligibleGross) {
  const out = {};
  if (!saving) return out;
  const total = BigInt(eligibleGross);
  const parts = eligible.map((l) => {
    const n = BigInt(saving) * BigInt(l.grossMinor);
    return { id: l.id, floor: n / total, rem: n % total };
  });
  let left = BigInt(saving) - parts.reduce((s, p) => s + p.floor, 0n);
  [...parts].sort((a, b) => {
    if (a.rem !== b.rem) return a.rem > b.rem ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }).forEach((p) => {
    if (left > 0n) {
      p.floor += 1n;
      left -= 1n;
    }
  });
  parts.forEach((p) => { out[p.id] = Number(p.floor); });
  return out;
}

/**
 * @param {object} input
 * @param {Array} input.promotions stored definitions (with private metadata); all states
 * @param {Array<{id:string,sku:string,parentSku:string,categories:string[],grossMinor:number}>} input.lines
 * @param {string|null} input.explicitCode stored/requested coupon code
 * @param {number} input.nowMs evaluation clock
 * @param {Function} [input.trust] (promotion) => { ok:true, capMinor? } | { ok:false, code }
 *   server-side protected-recovery decision; default denies protected promotions
 * @param {string} [input.selection] 'explicit-first' (wknd.promotions/v1, default): an eligible
 *   explicit coupon always wins. 'best-saving' (v2 gate): the higher actual saving of the eligible
 *   coupon and the best automatic wins, ties to the coupon; a beaten coupon stays stored with
 *   status 'superseded'. Invalid coupons report their error in both modes.
 * @returns {{ selected: object|null, discountMinor: number, allocations: object,
 *   merchandiseMinor: number, coupon: null|{code:string,status:string,error?:string},
 *   error: EvaluationError|null }}
 */
const SELECTIONS = ['explicit-first', 'best-saving'];

function evaluatePromotions({
  promotions = [], lines = [], explicitCode = null, nowMs, trust, selection = 'explicit-first',
}) {
  const mode = SELECTIONS.includes(selection) ? selection : 'explicit-first';
  const decide = trust || ((p) => (p.managementClass === 'protected-recovery'
    ? { ok: false, code: 'COUPON_ELIGIBILITY_UNAVAILABLE' } : { ok: true }));
  const base = {
    selected: null, discountMinor: 0, allocations: {}, merchandiseMinor: 0, coupon: null, error: null,
  };
  if (lines.length > LIMITS.lines || promotions.length > LIMITS.candidates
    || lines.some((l) => !Number.isSafeInteger(l.grossMinor) || l.grossMinor < 0 || l.grossMinor > LIMITS.lineGross)) {
    return { ...base, error: new EvaluationError('EVALUATION_LIMIT_EXCEEDED') };
  }
  const merchandiseMinor = lines.reduce((n, l) => n + l.grossMinor, 0);
  if (merchandiseMinor > LIMITS.aggregate) return { ...base, error: new EvaluationError('EVALUATION_LIMIT_EXCEEDED') };
  base.merchandiseMinor = merchandiseMinor;

  const minimumMet = (p) => p.minimumMerchandiseMinor == null || merchandiseMinor >= p.minimumMerchandiseMinor;

  const explicitResult = () => {
    const code = normalizeCode(String(explicitCode));
    const fail = (err) => ({
      ...base, coupon: { code: code || String(explicitCode), status: 'rejected', error: err }, error: new EvaluationError(err),
    });
    const p = code && promotions.find((x) => x.mode === 'coupon' && x.code === code);
    if (!p) return fail('COUPON_NOT_FOUND');
    if (!p.enabled) return fail('COUPON_DISABLED');
    if (!inWindow(p, nowMs)) return fail('COUPON_OUTSIDE_WINDOW');
    const t = decide(p);
    if (!t.ok) return fail(t.code || 'COUPON_SHOPPER_INELIGIBLE');
    const { eligible, eligibleGross, saving } = candidateSaving(p, lines, t.capMinor);
    if (!eligible.length) return fail('COUPON_NO_ELIGIBLE_LINES');
    if (!minimumMet(p)) {
      // Preserved legacy compatibility (single-authority decision): migrated identities accept a
      // minimum-only failure with zero saving and still suppress automatics while retained
      // (explicit-first only; under best-saving any automatic with a saving wins).
      if (p.private?.legacyMinimumOnlyAcceptance === true) {
        return {
          ...base, selected: p, coupon: { code, status: 'accepted-below-minimum' },
        };
      }
      return fail('COUPON_MINIMUM_NOT_MET');
    }
    return {
      ...base,
      selected: p,
      discountMinor: saving,
      allocations: allocate(saving, eligible, eligibleGross),
      coupon: { code, status: 'applied' },
    };
  };

  const bestAutomatic = () => {
    const ranked = promotions
      .filter((p) => p.mode === 'automatic' && p.enabled && inWindow(p, nowMs) && minimumMet(p))
      .map((p) => {
        const t = decide(p);
        if (!t.ok) return null;
        return { p, ...candidateSaving(p, lines, t.capMinor) };
      })
      .filter((c) => c && c.saving > 0)
      .sort((a, b) => (b.saving - a.saving) || (a.p.id < b.p.id ? -1 : 1));
    const best = ranked[0];
    if (!best) return base;
    return {
      ...base,
      selected: best.p,
      discountMinor: best.saving,
      allocations: allocate(best.saving, best.eligible, best.eligibleGross),
    };
  };

  if (explicitCode != null) {
    const explicit = explicitResult();
    if (mode === 'best-saving' && !explicit.error) {
      const automatic = bestAutomatic();
      if (automatic.discountMinor > explicit.discountMinor) {
        return { ...automatic, coupon: { code: explicit.coupon.code, status: 'superseded' } };
      }
    }
    return explicit;
  }
  return bestAutomatic();
}

module.exports = {
  evaluatePromotions,
  allocate,
  gstMinor,
  lineMatches,
  inWindow,
  EvaluationError,
  COUPON_ERRORS,
  EVALUATION_LIMITS: LIMITS,
};
