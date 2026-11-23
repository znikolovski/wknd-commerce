/**
 * The single shared WKND promotion service — wknd.promotions/v1 (frozen candidate.5,
 * sha256 90260e5f65ccc929ac89f95fb7f9e98296b5330e310a8ca7fa5eb7579a01419d).
 *
 * Management (list/get/create/update/disable) is called by thin adapters (Commerce MCP) after
 * verified IMS operator authentication; the storefront cart/checkout uses the same stored
 * definitions through `loadPromotionRuntime`. There is no second engine.
 *
 * Storage without multi-document transactions:
 * - `promotion_requests` receipts are claimed with a unique `_id` (org, operation, key).
 * - The `promotions` projection is the commit point. Writes are conditional on the record's
 *   private `slot` counter (compare-and-swap); create is a unique insert. Each write appends its
 *   request reference to `recentSlots`, so an interrupted request can be resolved later.
 * - The recovery worker resolves stale requests: a committed write is rolled forward; otherwise
 *   the worker fences the intended slot (bumping it without changing public data), proving that
 *   the interrupted write can never commit, and marks the request retryable.
 * - Coupon codes are reserved with a unique `_id` in `promotion_codes`.
 * These guarantees depend on Database Storage honouring unique `_id` and conditional updates;
 * that must be verified against the real service before enabling management writes.
 */
const crypto = require('node:crypto');
const S = require('./promotion-schema');
const { createEffects, effectsView, MAX_EFFECTS_VIEW } = require('./promotion-effects');
const { plannerCandidate } = require('./planner-offer');
const { isDuplicateKeyError } = require('./store');
const { COUPONS } = require('./config');
const recovery = require('./recovery-policy');

const {
  API_VERSION, LIMITS, PromotionError, errorEnvelope,
} = S;

const DAY_MS = 86400000;
const PUBLIC_RECEIPT_MS = LIMITS.receiptPublicDays * DAY_MS;
const RETRY_DELAY_MS = LIMITS.retryDelaySeconds * 1000;
const RECENT_SLOTS = 100;
const DEFAULT_STALE_MS = 60000;
const CURSOR_AAD = Buffer.from('wknd.promotions/v1:list:pc1', 'utf8');

/* ---------- legacy migration seeds ---------- */

const LEGACY_SEEDS = [
  {
    id: 'prm_00000000000000000000000000000010',
    code: 'WKND10',
    definition: {
      name: COUPONS.WKND10.label,
      enabled: true,
      mode: 'coupon',
      code: 'WKND10',
      discount: { kind: 'percentage', basisPoints: COUPONS.WKND10.percent * 100 },
      maxDiscountMinor: null,
      minimumMerchandiseMinor: null,
      target: { kind: 'all' },
      startsAt: null,
      endsAt: null,
      audienceRestriction: null,
    },
  },
  {
    id: 'prm_00000000000000000000000000000020',
    code: 'TRAILREADY',
    definition: {
      name: COUPONS.TRAILREADY.label,
      enabled: true,
      mode: 'coupon',
      code: 'TRAILREADY',
      discount: { kind: 'fixed', amountMinor: COUPONS.TRAILREADY.amount * 100, currency: 'AUD' },
      maxDiscountMinor: null,
      minimumMerchandiseMinor: COUPONS.TRAILREADY.minSubtotal * 100,
      target: { kind: 'all' },
      startsAt: null,
      endsAt: null,
      audienceRestriction: null,
    },
  },
];

function legacyDoc(seed, at) {
  return {
    _id: seed.id,
    id: seed.id,
    slot: 1,
    revision: 1,
    managementClass: 'standard',
    ...seed.definition,
    createdAt: at,
    updatedAt: at,
    recentSlots: [{ slot: 1, ref: 'legacy-migration' }],
    // Private immutable migrated identity metadata (preserved legacy minimum-only acceptance).
    private: { legacyCode: seed.code, legacyMinimumOnlyAcceptance: true },
  };
}

class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'MIGRATION_CONFLICT';
  }
}

async function migrationComplete(store) {
  const meta = await store.collection('promotion_meta').findOne({ key: 'migration' });
  return meta?.state === 'complete';
}

/**
 * Explicit, idempotent legacy coupon migration (scripts/migrate-promotions.mjs). Never
 * overwrites operator edits or re-enables; foreign records using a legacy code fail.
 */
async function migrateLegacyPromotions(store, { clock = Date.now } = {}) {
  const at = new Date(clock()).toISOString();
  const report = { inserted: 0, unchanged: 0 };
  for (let i = 0; i < LEGACY_SEEDS.length; i += 1) {
    const seed = LEGACY_SEEDS[i];
    /* eslint-disable no-await-in-loop */
    const foreign = await store.collection('promotions').findOne({ code: seed.code, id: { $ne: seed.id }, fenced: { $ne: true } });
    if (foreign) throw new MigrationError(`Legacy code ${seed.code} is used by another promotion.`);
    const reservation = await store.collection('promotion_codes').findOne({ code: seed.code });
    if (reservation && reservation.promotionId !== seed.id) throw new MigrationError(`Legacy code ${seed.code} is reserved by another promotion.`);
    if (!reservation) {
      await store.collection('promotion_codes').insertOne({
        _id: seed.code, code: seed.code, promotionId: seed.id, reservedBy: 'legacy-migration', legacy: true,
      });
    }
    const existing = await store.collection('promotions').findOne({ id: seed.id });
    if (existing) {
      report.unchanged += 1;
    } else {
      const doc = legacyDoc(seed, at);
      await store.collection('promotions').insertOne(doc);
      await store.collection('promotion_audit').insertOne({
        _id: `${seed.id}:1`, auditId: `${seed.id}:1`, promotionId: seed.id, revision: 1, operation: 'migrate', at, after: S.definitionOf(doc),
      }).catch((e) => { if (!isDuplicateKeyError(e)) throw e; });
      report.inserted += 1;
    }
    /* eslint-enable no-await-in-loop */
  }
  await store.collection('promotion_meta').updateOne(
    { key: 'migration' },
    { $set: { state: 'complete', version: 1, completedAt: at }, $setOnInsert: { _id: 'migration', key: 'migration' } },
    { upsert: true },
  );
  return report;
}

/* ---------- target resolution ---------- */

const sellablesOf = (product) => (product.type === 'configurable' ? (product.variants || []).map((v) => v.sku) : [product.sku]);

/**
 * @returns {{ parentSkus: string[], sellableSkus: string[], unknown: number[] }}
 */
function resolveTarget(cat, target) {
  const parents = new Set();
  const sellables = new Set();
  const unknown = [];
  if (target.kind === 'all') {
    cat.products.forEach((p) => {
      parents.add(p.sku);
      sellablesOf(p).forEach((s) => sellables.add(s));
    });
  } else if (target.kind === 'skus') {
    target.values.forEach((sku, i) => {
      const parent = cat.bySku.get(sku);
      if (parent) {
        parents.add(parent.sku);
        sellablesOf(parent).forEach((s) => sellables.add(s));
        return;
      }
      const hit = cat.byVariantSku.get(sku);
      if (hit) {
        parents.add(hit.parent.sku);
        sellables.add(sku);
        return;
      }
      unknown.push(i);
    });
  } else {
    const known = new Set(cat.categories.map((c) => c.urlPath));
    target.values.forEach((v, i) => {
      if (!known.has(v)) unknown.push(i);
    });
    cat.products.forEach((p) => {
      if ((p.categories || []).some((c) => target.values.some((v) => c === v || c.startsWith(`${v}/`)))) {
        parents.add(p.sku);
        sellablesOf(p).forEach((s) => sellables.add(s));
      }
    });
  }
  return { parentSkus: [...parents].sort(), sellableSkus: [...sellables].sort(), unknown };
}

const skuScope = (parentSkus = [], sellableSkus = []) => ({ scope: 'skus', parentSkus: [...parentSkus], sellableSkus: [...sellableSkus] });
const SAFETY_DISABLE = Object.freeze({ scope: 'global-promotions', reason: 'safety-disable' });
const union = (a, b) => [...new Set([...(a || []), ...(b || [])])].sort();

/* ---------- cursors ---------- */

function encodeCursor(key, payload) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(CURSOR_AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `pc1.${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url')}`;
}

function decodeCursor(key, cursor) {
  if (typeof cursor !== 'string' || !cursor.startsWith('pc1.') || !/^[A-Za-z0-9_-]+$/.test(cursor.slice(4))) return null;
  const raw = Buffer.from(cursor.slice(4), 'base64url');
  if (raw.length < 29) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(CURSOR_AAD);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const json = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function cursorKeyFrom(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.length === 32 ? value : null;
  const buf = Buffer.from(String(value), 'base64');
  return buf.length === 32 ? buf : null;
}

/* ---------- service ---------- */

/**
 * @param {object} deps
 * @param {object} deps.store lib/store.js store
 * @param {Function} [deps.clock] () => epoch ms
 * @param {Function} deps.loadCatalog async () => catalog snapshot (lib/catalog loadCatalog)
 * @param {object} [deps.effects] override for tests
 * @param {string|Buffer} [deps.cursorKey] 32-byte AES key (base64) — PROMOTION_CURSOR_KEY
 * @param {object} [deps.params] action params (recovery readiness flags)
 * @param {number} [deps.resultLimitBytes] test hook for output preflight (default 1 MiB)
 */
function createPromotionService({
  store, clock = Date.now, loadCatalog, effects, cursorKey, params = {}, resultLimitBytes = LIMITS.resultBytes,
}) {
  const fx = effects || createEffects({ store, clock });
  const key = cursorKeyFrom(cursorKey);
  const promotions = () => store.collection('promotions');
  const requests = () => store.collection('promotion_requests');
  const codes = () => store.collection('promotion_codes');
  const iso = (ms) => new Date(ms).toISOString();

  const fail = (ctx, code, extra = {}) => errorEnvelope({ code, correlationId: ctx.correlationId, ...extra });

  async function readProjection(id) {
    const doc = await promotions().findOne({ id });
    return doc && !doc.fenced ? doc : null;
  }

  /* ----- receipts ----- */

  const receiptId = (orgId, operation, idemKey) => S.sha256(S.canonicalJson([orgId, operation, idemKey]));

  function successEnvelope(ctx, { promotion, affected, effects: eff, request, mutationCorrelationId, replayed }) {
    return {
      apiVersion: API_VERSION,
      ok: true,
      committed: true,
      promotion,
      replayed,
      affected,
      effects: eff,
      request,
      correlationId: ctx.correlationId,
      mutationCorrelationId,
    };
  }

  const requestOf = (receipt) => ({ operation: receipt.operation, idempotencyKey: receipt.idempotencyKey });

  /** Read-only commit determination for an in-flight receipt. */
  async function resolveInFlight(receipt) {
    if (receipt.state !== 'writing') return null;
    const doc = await promotions().findOne({ id: receipt.intent.promotionId });
    if (doc && (doc.recentSlots || []).some((s) => s.ref === receipt.requestKey)) return true;
    return null;
  }

  async function replayCommitted(ctx, receipt) {
    const preview = receipt.result || receipt.intent.preview;
    const effectId = receipt.result?.effectId ?? receipt.intent.preview?.effectId ?? null;
    let effect = null;
    if (effectId) effect = (await fx.get(effectId)) || { status: 'pending', effectId };
    return successEnvelope(ctx, {
      promotion: preview.promotion,
      affected: preview.affected,
      effects: effectsView(effect),
      request: requestOf(receipt),
      mutationCorrelationId: receipt.mutationCorrelationId,
      replayed: true,
    });
  }

  function storedError(ctx, receipt, committed = false) {
    return errorEnvelope({
      code: receipt.error.code,
      fields: receipt.error.fields || [],
      details: receipt.error.details ?? null,
      committed,
      request: requestOf(receipt),
      correlationId: ctx.correlationId,
      mutationCorrelationId: receipt.mutationCorrelationId,
    });
  }

  /** Outcome of an existing receipt for a lookup or an identical replay (no writes). */
  async function receiptOutcome(ctx, receipt) {
    const nowMs = clock();
    let committed = receipt.committed;
    if (receipt.state === 'claimed' || receipt.state === 'writing') {
      committed = (await resolveInFlight(receipt)) ? true : null;
    } else if (receipt.state === 'committed') committed = true;
    else committed = false;
    if (nowMs >= receipt.claimedAtMs + PUBLIC_RECEIPT_MS) {
      return fail(ctx, 'IDEMPOTENCY_RECORD_EXPIRED', {
        committed, request: requestOf(receipt), mutationCorrelationId: receipt.mutationCorrelationId,
      });
    }
    if (committed === true) return replayCommitted(ctx, receipt);
    if (receipt.state === 'failed' || receipt.state === 'retryable') return storedError(ctx, receipt, false);
    return fail(ctx, 'RECONCILIATION_REQUIRED', {
      committed: null, request: requestOf(receipt), mutationCorrelationId: receipt.mutationCorrelationId,
    });
  }

  /**
   * Claims (or reclaims) a receipt. Returns { owner: receipt } or { response }.
   */
  async function claim(ctx, { operation, idemKey, hash, intent }) {
    const id = receiptId(ctx.actor.orgId, operation, idemKey);
    const nowMs = clock();
    const ownerToken = crypto.randomUUID();
    const doc = {
      _id: id,
      requestKey: id,
      orgId: ctx.actor.orgId,
      operation,
      idempotencyKey: idemKey,
      hash,
      state: 'claimed',
      ownerToken,
      claimedAtMs: nowMs,
      claimedAt: iso(nowMs),
      touchedAtMs: nowMs,
      mutationCorrelationId: ctx.correlationId,
      actor: { kind: ctx.actor.kind, subject: ctx.actor.subject },
      intent,
      committed: null,
    };
    try {
      await requests().insertOne(doc);
      return { owner: doc };
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
    }
    const existing = await requests().findOne({ requestKey: id });
    if (!existing) return { response: fail(ctx, 'RECONCILIATION_REQUIRED', { committed: null, request: { operation, idempotencyKey: idemKey } }) };
    if (existing.hash !== hash) {
      return {
        response: fail(ctx, 'IDEMPOTENCY_CONFLICT', {
          request: { operation, idempotencyKey: idemKey }, mutationCorrelationId: existing.mutationCorrelationId,
        }),
      };
    }
    if (existing.state === 'retryable' && nowMs < existing.claimedAtMs + PUBLIC_RECEIPT_MS
      && nowMs >= (existing.retryableAtMs || 0) + RETRY_DELAY_MS) {
      // A fenced create can never commit under its old id, so a reclaimed create gets a new one.
      const reclaimedIntent = operation === 'create'
        ? { ...existing.intent, promotionId: S.newPromotionId(), preview: null } : existing.intent;
      const res = await requests().updateOne(
        { requestKey: id, state: 'retryable', ownerToken: existing.ownerToken },
        {
          $set: {
            state: 'claimed', ownerToken, touchedAtMs: nowMs, intent: reclaimedIntent,
          },
          $unset: { error: '' },
        },
      );
      if ((res?.matchedCount ?? 0) === 1) {
        return {
          owner: {
            ...existing, state: 'claimed', ownerToken, error: undefined, intent: reclaimedIntent,
          },
        };
      }
      return { response: fail(ctx, 'RECONCILIATION_REQUIRED', { committed: null, request: requestOf(existing), mutationCorrelationId: existing.mutationCorrelationId }) };
    }
    return { response: await receiptOutcome(ctx, existing) };
  }

  /** Terminal (or retryable) proven no-commit outcome recorded on the owned receipt. */
  async function finishNoCommit(ctx, receipt, code, { fields = [], details = null, retryable = false } = {}) {
    const nowMs = clock();
    await requests().updateOne(
      { requestKey: receipt.requestKey, ownerToken: receipt.ownerToken, state: { $in: ['claimed', 'writing'] } },
      {
        $set: {
          state: retryable ? 'retryable' : 'failed',
          committed: false,
          error: { code, fields, details },
          touchedAtMs: nowMs,
          ...(retryable ? { retryableAtMs: nowMs } : {}),
        },
      },
    ).catch(() => {});
    await releaseOwnedCodes(receipt.requestKey);
    return errorEnvelope({
      code,
      fields,
      details,
      committed: false,
      request: requestOf(receipt),
      correlationId: ctx.correlationId,
      mutationCorrelationId: receipt.mutationCorrelationId,
    });
  }

  const reconciliation = (ctx, receipt) => errorEnvelope({
    code: 'RECONCILIATION_REQUIRED',
    committed: null,
    request: requestOf(receipt),
    correlationId: ctx.correlationId,
    mutationCorrelationId: receipt.mutationCorrelationId,
  });

  /* ----- code reservations ----- */

  /**
   * Reserves a normalized code for a promotion. The reservation records the latest request that
   * relied on it (`reservedBy`), so releases never remove a code another request still needs.
   */
  async function reserveCode(code, promotionId, requestKey) {
    try {
      await codes().insertOne({
        _id: code, code, promotionId, reservedBy: requestKey,
      });
      return true;
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
    }
    const existing = await codes().findOne({ code });
    if (!existing) return false;
    if (existing.promotionId === promotionId) {
      if (existing.reservedBy !== requestKey && !existing.legacy && !existing.protected) {
        await codes().updateOne({ code, reservedBy: existing.reservedBy }, { $set: { reservedBy: requestKey } });
      }
      return true;
    }
    // A retried create gets a new promotion id; it may adopt its own earlier reservation.
    if (existing.reservedBy === requestKey) {
      const res = await codes().updateOne({ code, reservedBy: requestKey }, { $set: { promotionId } });
      return (res?.matchedCount ?? 0) === 1;
    }
    return false;
  }

  /**
   * Deletes a non-permanent reservation only when no committed promotion uses the code and the
   * request that last reserved it is no longer in flight. Compare-and-delete on `reservedBy`.
   */
  async function releaseIfUnused(code) {
    if (!code) return;
    try {
      const r = await codes().findOne({ code });
      if (!r || r.legacy || r.protected) return;
      if (await promotions().findOne({ code, fenced: { $ne: true } })) return;
      const holder = r.reservedBy ? await requests().findOne({ requestKey: r.reservedBy }) : null;
      if (holder && (holder.state === 'claimed' || holder.state === 'writing')) return;
      await codes().deleteOne({ code, reservedBy: r.reservedBy, promotionId: r.promotionId });
    } catch (e) {
      // best effort: a leftover reservation is adopted by its own retry or released later
    }
  }

  async function releaseOwnedCodes(requestKey) {
    try {
      const own = await codes().find({ reservedBy: requestKey });
      await Promise.all(own.map((c) => releaseIfUnused(c.code)));
    } catch (e) {
      // best effort
    }
  }

  /* ----- output preflight ----- */

  function preflight(ctx, promotion, affected, request) {
    const envelope = successEnvelope(ctx, {
      promotion,
      affected,
      effects: MAX_EFFECTS_VIEW,
      request,
      mutationCorrelationId: ctx.correlationId,
      replayed: false,
    });
    return S.utf8Bytes(JSON.stringify(envelope)) <= resultLimitBytes;
  }

  /* ----- commit ----- */

  async function markWriting(receipt, preview, intendedSlot) {
    const res = await requests().updateOne(
      { requestKey: receipt.requestKey, ownerToken: receipt.ownerToken, state: 'claimed' },
      {
        $set: {
          state: 'writing', 'intent.preview': preview, 'intent.intendedSlot': intendedSlot, touchedAtMs: clock(),
        },
      },
    );
    return (res?.matchedCount ?? 0) === 1;
  }

  async function finalizeCommitted(receipt, preview, { oldCode, newCode, promotionId, audit }) {
    if (oldCode && oldCode !== newCode) await releaseIfUnused(oldCode);
    await store.collection('promotion_audit').insertOne({
      _id: `${promotionId}:${preview.promotion.revision}`,
      auditId: `${promotionId}:${preview.promotion.revision}`,
      promotionId,
      revision: preview.promotion.revision,
      operation: receipt.operation,
      requestKey: receipt.requestKey,
      orgId: receipt.orgId,
      actorKind: receipt.actor?.kind,
      actorSubject: receipt.actor?.subject,
      mutationCorrelationId: receipt.mutationCorrelationId,
      at: preview.promotion.updatedAt,
      ...audit,
    }).catch((e) => { if (!isDuplicateKeyError(e)) throw e; });
    let effect = null;
    if (preview.effectId) {
      effect = await fx.record({
        promotionId, revision: preview.promotion.revision, affected: preview.affected, effectId: preview.effectId,
      });
    }
    await requests().updateOne(
      { requestKey: receipt.requestKey, state: { $in: ['writing', 'claimed'] } },
      {
        $set: {
          state: 'committed', committed: true, touchedAtMs: clock(), result: { promotion: preview.promotion, affected: preview.affected, effectId: effect?.effectId || null },
        },
      },
    );
    return effect;
  }

  /**
   * Shared commit sequence after all precommit checks have passed.
   * @param {object} p { receipt, current (projection or null), next (projection), preview, codeChange }
   */
  async function commit(ctx, {
    receipt, current, next, preview, oldCode, newCode, audit,
  }) {
    const intendedSlot = current ? current.slot : 0;
    if (!(await markWriting(receipt, { ...preview, oldCode: oldCode || null }, intendedSlot))) return reconciliation(ctx, receipt);
    const ref = receipt.requestKey;
    const slot = intendedSlot + 1;
    const doc = {
      ...next,
      slot,
      recentSlots: [...(current?.recentSlots || []), { slot, ref }].slice(-RECENT_SLOTS),
    };
    let committed;
    try {
      if (!current) {
        await promotions().insertOne(doc);
        committed = true;
      } else {
        const res = await promotions().replaceOne({ id: current.id, slot: current.slot }, doc);
        committed = (res?.matchedCount ?? 0) === 1;
      }
    } catch (e) {
      if (!current && isDuplicateKeyError(e)) committed = false;
      else return reconciliation(ctx, receipt);
    }
    if (!committed) {
      let latest;
      try {
        latest = await promotions().findOne({ id: next.id });
      } catch (e) {
        return reconciliation(ctx, receipt);
      }
      if (latest && (latest.recentSlots || []).some((s) => s.ref === ref)) committed = true;
      else if (latest && (latest.recentSlots || []).some((s) => s.ref === `fence:${ref}`)) return reconciliation(ctx, receipt);
      else {
        return finishNoCommit(ctx, receipt, 'REVISION_CONFLICT', {
          details: current ? { expectedRevision: current.revision, currentRevision: latest?.revision ?? current.revision } : null,
        });
      }
    }
    let effect = null;
    try {
      effect = await finalizeCommitted(receipt, preview, {
        oldCode, newCode, promotionId: next.id, audit,
      });
      if (effect) effect = await fx.execute(effect);
    } catch (e) {
      effect = preview.effectId ? { status: 'pending', effectId: preview.effectId } : null;
    }
    return successEnvelope(ctx, {
      promotion: preview.promotion,
      affected: preview.affected,
      effects: effectsView(effect),
      request: requestOf(receipt),
      mutationCorrelationId: receipt.mutationCorrelationId,
      replayed: false,
    });
  }

  /* ----- shared guards ----- */

  async function guard(ctx, args) {
    if (!S.validateContext(ctx)) {
      const correlationId = typeof ctx?.correlationId === 'string' && S.UUID_V4.test(ctx.correlationId) ? ctx.correlationId : crypto.randomUUID();
      return fail({ correlationId }, 'PROMOTION_CONFIGURATION_ERROR');
    }
    const size = S.checkArgumentSize(args);
    if (size) return fail(ctx, size);
    return null;
  }

  async function ensureMigrated(ctx) {
    if (!(await migrationComplete(store))) return fail(ctx, 'PROMOTION_STORAGE_UNINITIALIZED');
    return null;
  }

  const validationError = (ctx, fields) => fail(ctx, 'VALIDATION_ERROR', { fields });

  function topLevel(args, allowed, required) {
    const fields = [];
    Object.keys(args).forEach((k) => {
      if (!allowed.includes(k)) fields.push(S.fieldError(`/${k}`, 'UNKNOWN_FIELD'));
    });
    required.forEach((k) => {
      if (args[k] === undefined) fields.push(S.fieldError(`/${k}`, 'REQUIRED'));
    });
    return fields;
  }

  function checkIdemKey(args, fields) {
    const k = S.normalizeIdempotencyKey(args.idempotencyKey);
    if (args.idempotencyKey !== undefined && !k) {
      fields.push(S.fieldError('/idempotencyKey', typeof args.idempotencyKey === 'string' ? 'INVALID_FORMAT' : 'INVALID_TYPE'));
    }
    return k;
  }

  function checkId(args, fields) {
    if (args.id !== undefined && (typeof args.id !== 'string' || !S.PROMOTION_ID.test(args.id))) {
      fields.push(S.fieldError('/id', typeof args.id === 'string' ? 'INVALID_FORMAT' : 'INVALID_TYPE'));
    }
  }

  function checkRevision(args, fields) {
    if (args.expectedRevision === undefined) return;
    if (!S.isInt(args.expectedRevision)) fields.push(S.fieldError('/expectedRevision', 'INVALID_TYPE'));
    else if (!S.validRevision(args.expectedRevision)) {
      fields.push(S.fieldError('/expectedRevision', 'OUT_OF_RANGE', `Expected an integer from 1 to ${LIMITS.revisionMax}.`));
    }
  }

  function precommitUnavailable(ctx, receipt) {
    return finishNoCommit(ctx, receipt, 'PROMOTION_SERVICE_UNAVAILABLE', { retryable: true });
  }

  /* ----- operations ----- */

  async function listPromotions(ctx, args = {}) {
    const g = await guard(ctx, args);
    if (g) return g;
    const fields = topLevel(args, ['limit', 'cursor', 'enabled'], []);
    if (args.limit !== undefined) {
      if (!S.isInt(args.limit)) fields.push(S.fieldError('/limit', 'INVALID_TYPE'));
      else if (args.limit < 1 || args.limit > LIMITS.listMax) fields.push(S.fieldError('/limit', 'OUT_OF_RANGE', `Expected an integer from 1 to ${LIMITS.listMax}.`));
    }
    if (args.enabled !== undefined && typeof args.enabled !== 'boolean') fields.push(S.fieldError('/enabled', 'INVALID_TYPE'));
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !args.cursor.length
      || args.cursor.length > LIMITS.cursorMax || !/^[\x21-\x7e]+$/.test(args.cursor))) {
      fields.push(S.fieldError('/cursor', typeof args.cursor === 'string' ? 'INVALID_FORMAT' : 'INVALID_TYPE'));
    }
    if (fields.length) return validationError(ctx, fields);
    try {
      const m = await ensureMigrated(ctx);
      if (m) return m;
      const limit = args.limit ?? LIMITS.listDefault;
      const enabled = args.enabled ?? null;
      const nowS = Math.floor(clock() / 1000);
      let lastId = null;
      let firstIssue = nowS;
      if (args.cursor !== undefined) {
        if (!key) return fail(ctx, 'PROMOTION_CONFIGURATION_ERROR');
        const c = decodeCursor(key, args.cursor);
        if (!c || c.v !== 1 || c.org !== ctx.actor.orgId || c.enabled !== enabled || c.limit !== limit
          || !S.PROMOTION_ID.test(c.lastId) || !Number.isInteger(c.exp) || nowS >= c.exp) {
          return fail(ctx, 'INVALID_CURSOR');
        }
        lastId = c.lastId;
        firstIssue = c.first;
      }
      const filter = { fenced: { $ne: true } };
      if (enabled !== null) filter.enabled = enabled;
      if (lastId) filter.id = { $gt: lastId };
      const docs = await promotions().find(filter, { sort: { id: 1 }, limit: limit + 1 });
      const page = docs.slice(0, limit);
      let nextCursor = null;
      if (docs.length > limit) {
        if (!key) return fail(ctx, 'PROMOTION_CONFIGURATION_ERROR');
        nextCursor = encodeCursor(key, {
          v: 1, org: ctx.actor.orgId, enabled, limit, lastId: page[page.length - 1].id, first: firstIssue, exp: firstIssue + LIMITS.cursorTtlSeconds,
        });
      }
      const body = {
        apiVersion: API_VERSION, ok: true, items: page.map(S.readDto), nextCursor, correlationId: ctx.correlationId,
      };
      if (S.utf8Bytes(JSON.stringify(body)) > resultLimitBytes) return fail(ctx, 'OUTPUT_TOO_LARGE');
      return body;
    } catch (e) {
      return fail(ctx, 'PROMOTION_SERVICE_UNAVAILABLE');
    }
  }

  async function getPromotion(ctx, args = {}) {
    const g = await guard(ctx, args);
    if (g) return g;
    const hasId = args.id !== undefined;
    const hasRequest = args.request !== undefined;
    const fields = topLevel(args, ['id', 'request'], []);
    if (hasId === hasRequest) fields.push(S.fieldError(hasId ? '/request' : '/id', hasId ? 'INCOMPATIBLE_FIELD' : 'REQUIRED'));
    checkId(args, fields);
    let request = null;
    if (hasRequest) {
      if (!S.isPlainObject(args.request)) fields.push(S.fieldError('/request', 'INVALID_TYPE'));
      else {
        Object.keys(args.request).forEach((k) => {
          if (!['operation', 'idempotencyKey'].includes(k)) fields.push(S.fieldError(`/request/${k}`, 'UNKNOWN_FIELD'));
        });
        if (!S.OPERATIONS.includes(args.request.operation)) fields.push(S.fieldError('/request/operation', args.request.operation === undefined ? 'REQUIRED' : 'INVALID_FORMAT'));
        const k = S.normalizeIdempotencyKey(args.request.idempotencyKey);
        if (!k) fields.push(S.fieldError('/request/idempotencyKey', args.request.idempotencyKey === undefined ? 'REQUIRED' : 'INVALID_FORMAT'));
        request = { operation: args.request.operation, idempotencyKey: k };
      }
    }
    if (fields.length) return validationError(ctx, fields);
    try {
      const m = await ensureMigrated(ctx);
      if (m) return m;
      if (hasId) {
        const doc = await readProjection(args.id);
        if (!doc) return fail(ctx, 'PROMOTION_NOT_FOUND');
        const body = {
          apiVersion: API_VERSION, ok: true, promotion: S.readDto(doc), correlationId: ctx.correlationId,
        };
        if (S.utf8Bytes(JSON.stringify(body)) > resultLimitBytes) return fail(ctx, 'OUTPUT_TOO_LARGE');
        return body;
      }
      const receipt = await requests().findOne({ requestKey: receiptId(ctx.actor.orgId, request.operation, request.idempotencyKey) });
      if (!receipt) return fail(ctx, 'REQUEST_NOT_FOUND', { committed: null, request });
      return await receiptOutcome(ctx, receipt);
    } catch (e) {
      return fail(ctx, 'PROMOTION_SERVICE_UNAVAILABLE', { committed: hasRequest ? null : false, request });
    }
  }

  async function createPromotion(ctx, args = {}) {
    const g = await guard(ctx, args);
    if (g) return g;
    const fields = topLevel(args, ['idempotencyKey', 'promotion'], ['idempotencyKey', 'promotion']);
    const idemKey = checkIdemKey(args, fields);
    const v = S.validateDefinition(args.promotion, 'create');
    if (v.audienceUnsupported && !fields.length) {
      return fail(ctx, 'UNSUPPORTED_AUDIENCE_RESTRICTION', { fields: [S.fieldError('/promotion/audienceRestriction', 'INCOMPATIBLE_FIELD')] });
    }
    fields.push(...v.fields);
    if (fields.length) return validationError(ctx, fields);
    const definition = v.definition;
    const hash = S.requestHash({ operation: 'create', definition });
    let receipt;
    try {
      const m = await ensureMigrated(ctx);
      if (m) return m;
      const claimed = await claim(ctx, {
        operation: 'create', idemKey, hash, intent: { promotionId: S.newPromotionId(), effectId: S.newEffectId() },
      });
      if (claimed.response) return claimed.response;
      receipt = claimed.owner;
    } catch (e) {
      return fail(ctx, 'PROMOTION_SERVICE_UNAVAILABLE');
    }
    try {
      const cat = await loadCatalog();
      const resolved = resolveTarget(cat, definition.target);
      if (resolved.unknown.length) {
        return finishNoCommit(ctx, receipt, 'VALIDATION_ERROR', {
          fields: resolved.unknown.map((i) => S.fieldError(`/promotion/target/values/${i}`, 'UNKNOWN_REFERENCE')),
        });
      }
      if (resolved.parentSkus.length > LIMITS.affectedParents || resolved.sellableSkus.length > LIMITS.affectedSellables) {
        return finishNoCommit(ctx, receipt, 'TARGET_SCOPE_TOO_LARGE');
      }
      const { promotionId, effectId } = receipt.intent;
      const at = iso(clock());
      const next = {
        _id: promotionId,
        id: promotionId,
        revision: 1,
        managementClass: 'standard',
        ...definition,
        audienceRestriction: null,
        createdAt: at,
        updatedAt: at,
        private: { lastResolved: { parentSkus: resolved.parentSkus, sellableSkus: resolved.sellableSkus } },
      };
      const preview = {
        promotion: S.readDto(next), affected: skuScope(resolved.parentSkus, resolved.sellableSkus), effectId,
      };
      if (!preflight(ctx, preview.promotion, preview.affected, requestOf(receipt))) return finishNoCommit(ctx, receipt, 'OUTPUT_TOO_LARGE');
      if (definition.code && !(await reserveCode(definition.code, promotionId, receipt.requestKey))) {
        return finishNoCommit(ctx, receipt, 'COUPON_CODE_CONFLICT');
      }
      return await commit(ctx, {
        receipt, current: null, next, preview, oldCode: null, newCode: definition.code, audit: { before: null, after: S.definitionOf(next) },
      });
    } catch (e) {
      return precommitUnavailable(ctx, receipt);
    }
  }

  async function updatePromotion(ctx, args = {}) {
    const g = await guard(ctx, args);
    if (g) return g;
    const fields = topLevel(args, ['id', 'expectedRevision', 'idempotencyKey', 'promotion'], ['id', 'expectedRevision', 'idempotencyKey', 'promotion']);
    checkId(args, fields);
    checkRevision(args, fields);
    const idemKey = checkIdemKey(args, fields);
    if (args.promotion !== undefined) fields.push(...S.unknownDefinitionFields(args.promotion));
    if (fields.length) return validationError(ctx, fields);
    const v = S.validateDefinition(args.promotion, 'update');
    if (v.audienceUnsupported) {
      return fail(ctx, 'UNSUPPORTED_AUDIENCE_RESTRICTION', { fields: [S.fieldError('/promotion/audienceRestriction', 'INCOMPATIBLE_FIELD')] });
    }
    const hash = S.requestHash({
      operation: 'update', id: args.id, expectedRevision: args.expectedRevision, definition: v.definition,
    });
    let receipt;
    try {
      const m = await ensureMigrated(ctx);
      if (m) return m;
      const claimed = await claim(ctx, {
        operation: 'update', idemKey, hash, intent: { promotionId: args.id, expectedRevision: args.expectedRevision, effectId: S.newEffectId() },
      });
      if (claimed.response) return claimed.response;
      receipt = claimed.owner;
    } catch (e) {
      return fail(ctx, 'PROMOTION_SERVICE_UNAVAILABLE');
    }
    try {
      const current = await readProjection(args.id);
      if (!current) return finishNoCommit(ctx, receipt, 'PROMOTION_NOT_FOUND');
      let policy = null;
      if (current.managementClass === 'protected-recovery') {
        policy = await store.collection('recovery_policies').findOne({ promotionId: current.id });
        const violations = recovery.protectedViolations(policy || { approved: {} }, args.promotion, v.definition);
        if (!policy || violations.length) return finishNoCommit(ctx, receipt, 'PROTECTED_POLICY_VIOLATION', { fields: violations });
      }
      if (v.fields.length) return finishNoCommit(ctx, receipt, 'VALIDATION_ERROR', { fields: v.fields });
      const definition = v.definition;
      if (args.expectedRevision !== current.revision) {
        return finishNoCommit(ctx, receipt, 'REVISION_CONFLICT', { details: { expectedRevision: args.expectedRevision, currentRevision: current.revision } });
      }
      if (current.revision >= LIMITS.revisionMax) return finishNoCommit(ctx, receipt, 'REVISION_EXHAUSTED');
      const before = S.definitionOf(current);
      const noOp = S.canonicalJson(before) === S.canonicalJson({ ...definition, audienceRestriction: null });
      let affected = skuScope();
      let lastResolved = current.private?.lastResolved || { parentSkus: [], sellableSkus: [] };
      if (!noOp) {
        const cat = await loadCatalog();
        const resolved = resolveTarget(cat, definition.target);
        if (resolved.unknown.length) {
          return finishNoCommit(ctx, receipt, 'VALIDATION_ERROR', {
            fields: resolved.unknown.map((i) => S.fieldError(`/promotion/target/values/${i}`, 'UNKNOWN_REFERENCE')),
          });
        }
        const old = current.target.kind === 'all' || !current.private?.lastResolved ? resolveTarget(cat, current.target) : current.private.lastResolved;
        const parents = union(old.parentSkus, resolved.parentSkus);
        const sellables = union(old.sellableSkus, resolved.sellableSkus);
        if (parents.length > LIMITS.affectedParents || sellables.length > LIMITS.affectedSellables) {
          return finishNoCommit(ctx, receipt, 'TARGET_SCOPE_TOO_LARGE');
        }
        affected = skuScope(parents, sellables);
        lastResolved = { parentSkus: resolved.parentSkus, sellableSkus: resolved.sellableSkus };
      }
      if (policy && !current.enabled && definition.enabled) {
        if (!recovery.integrityOk(policy, current) || !recovery.readiness(params).ready) {
          return finishNoCommit(ctx, receipt, 'RECOVERY_NOT_READY', { retryable: true });
        }
      }
      const at = iso(clock());
      const next = {
        ...current,
        ...definition,
        audienceRestriction: null,
        revision: current.revision + 1,
        updatedAt: at,
        private: { ...(current.private || {}), lastResolved },
      };
      delete next.slot;
      delete next.recentSlots;
      const preview = {
        promotion: S.readDto(next), affected, effectId: noOp ? null : receipt.intent.effectId,
      };
      if (!preflight(ctx, preview.promotion, preview.affected, requestOf(receipt))) return finishNoCommit(ctx, receipt, 'OUTPUT_TOO_LARGE');
      const newCode = definition.mode === 'coupon' ? definition.code : null;
      if (newCode && newCode !== current.code && !(await reserveCode(newCode, current.id, receipt.requestKey))) {
        return finishNoCommit(ctx, receipt, 'COUPON_CODE_CONFLICT');
      }
      return await commit(ctx, {
        receipt, current, next, preview, oldCode: current.code, newCode, audit: { before, after: S.definitionOf(next) },
      });
    } catch (e) {
      return precommitUnavailable(ctx, receipt);
    }
  }

  async function disablePromotion(ctx, args = {}) {
    const g = await guard(ctx, args);
    if (g) return g;
    const fields = topLevel(args, ['id', 'expectedRevision', 'idempotencyKey'], ['id', 'expectedRevision', 'idempotencyKey']);
    checkId(args, fields);
    checkRevision(args, fields);
    const idemKey = checkIdemKey(args, fields);
    if (fields.length) return validationError(ctx, fields);
    const hash = S.requestHash({ operation: 'disable', id: args.id, expectedRevision: args.expectedRevision });
    let receipt;
    try {
      const m = await ensureMigrated(ctx);
      if (m) return m;
      const claimed = await claim(ctx, {
        operation: 'disable', idemKey, hash, intent: { promotionId: args.id, expectedRevision: args.expectedRevision, effectId: S.newEffectId() },
      });
      if (claimed.response) return claimed.response;
      receipt = claimed.owner;
    } catch (e) {
      return fail(ctx, 'PROMOTION_SERVICE_UNAVAILABLE');
    }
    try {
      // Safety disable: no catalog expansion, reference validation, audience or recovery readiness.
      const current = await readProjection(args.id);
      if (!current) return finishNoCommit(ctx, receipt, 'PROMOTION_NOT_FOUND');
      if (args.expectedRevision !== current.revision) {
        return finishNoCommit(ctx, receipt, 'REVISION_CONFLICT', { details: { expectedRevision: args.expectedRevision, currentRevision: current.revision } });
      }
      if (current.revision >= LIMITS.revisionMax) return finishNoCommit(ctx, receipt, 'REVISION_EXHAUSTED');
      const wasEnabled = current.enabled === true;
      const next = {
        ...current, enabled: false, revision: current.revision + 1, updatedAt: iso(clock()),
      };
      delete next.slot;
      delete next.recentSlots;
      const preview = {
        promotion: S.readDto(next),
        affected: wasEnabled ? { ...SAFETY_DISABLE } : skuScope(),
        effectId: wasEnabled ? receipt.intent.effectId : null,
      };
      if (!preflight(ctx, preview.promotion, preview.affected, requestOf(receipt))) return finishNoCommit(ctx, receipt, 'OUTPUT_TOO_LARGE');
      return await commit(ctx, {
        receipt, current, next, preview, oldCode: current.code, newCode: current.code, audit: { before: S.definitionOf(current), after: S.definitionOf(next) },
      });
    } catch (e) {
      return precommitUnavailable(ctx, receipt);
    }
  }

  /**
   * Server recovery worker (scheduled; never an MCP tool). Resolves stale in-flight requests and
   * retries unsettled effects. Never discards private intent/linkage.
   */
  async function recoverRequests({ staleMs = DEFAULT_STALE_MS, limit = 50 } = {}) {
    const nowMs = clock();
    const report = {
      committed: 0, noCommit: 0, skipped: 0, effects: 0,
    };
    const stale = await requests().find({ state: { $in: ['claimed', 'writing'] }, touchedAtMs: { $lt: nowMs - staleMs } }, { limit });
    for (let i = 0; i < stale.length; i += 1) {
      const r = stale[i];
      const ref = r.requestKey;
      const markRetryable = async () => {
        const res = await requests().updateOne(
          { requestKey: ref, ownerToken: r.ownerToken, state: r.state },
          {
            $set: {
              state: 'retryable', committed: false, retryableAtMs: nowMs, touchedAtMs: nowMs, ownerToken: crypto.randomUUID(), error: { code: 'PROMOTION_SERVICE_UNAVAILABLE', fields: [], details: null },
            },
          },
        );
        if ((res?.matchedCount ?? 0) === 1) {
          await releaseOwnedCodes(ref);
          report.noCommit += 1;
        } else report.skipped += 1;
      };
      /* eslint-disable no-await-in-loop */
      if (r.state === 'claimed') {
        await markRetryable();
      } else {
        const id = r.intent.promotionId;
        let doc = await promotions().findOne({ id });
        const has = (d, x) => (d?.recentSlots || []).some((s) => s.ref === x);
        if (!has(doc, ref)) {
          const slot = r.intent.intendedSlot;
          if (slot === 0) {
            await promotions().insertOne({
              _id: id, id, fenced: true, slot: 1, recentSlots: [{ slot: 1, ref: `fence:${ref}` }],
            }).catch((e) => { if (!isDuplicateKeyError(e)) throw e; });
          } else if (doc && doc.slot === slot) {
            await promotions().replaceOne({ id, slot }, {
              ...doc, slot: slot + 1, recentSlots: [...doc.recentSlots, { slot: slot + 1, ref: `fence:${ref}` }].slice(-RECENT_SLOTS),
            });
          }
          doc = await promotions().findOne({ id });
        }
        if (has(doc, ref)) {
          const before = r.intent.preview;
          await finalizeCommitted(r, before, {
            oldCode: before.oldCode, newCode: before.promotion.code, promotionId: id, audit: {},
          });
          report.committed += 1;
        } else await markRetryable();
      }
      /* eslint-enable no-await-in-loop */
    }
    report.effects = (await fx.retryUnsettled({ limit })).length;
    return report;
  }

  return {
    listPromotions,
    getPromotion,
    createPromotion,
    updatePromotion,
    disablePromotion,
    recoverRequests,
  };
}

/* ---------- storefront runtime ---------- */

const toMinor = (v) => Math.round(Number(v) * 100);

/**
 * Loads current definitions for evaluating one cart. Before the explicit migration completes the
 * same evaluator uses the built-in legacy seed definitions (identical to the migrated records).
 */
async function loadPromotionRuntime(store, {
  params = {}, customer = null, cart = null, codes = null, clock = Date.now,
  plannerProvider = null, catalog = null,
} = {}) {
  const nowMs = clock();
  let definitions;
  if (await migrationComplete(store)) {
    // Only applicable candidates: enabled automatics plus the explicit code(s) being evaluated
    // (any state, so a disabled/expired coupon reports its exact error).
    const wanted = [...new Set((codes ?? cart?.coupons ?? []).map((c) => S.normalizeCode(String(c))).filter(Boolean))];
    const [automatic, coupons] = await Promise.all([
      store.collection('promotions').find({ fenced: { $ne: true }, enabled: true, mode: 'automatic' }, { limit: 1001 }),
      wanted.length ? store.collection('promotions').find({ fenced: { $ne: true }, code: { $in: wanted } }) : [],
    ]);
    definitions = [...automatic, ...coupons];
  } else {
    const at = new Date(0).toISOString();
    definitions = LEGACY_SEEDS.map((s) => legacyDoc(s, at));
  }
  const rec = recovery.createRecovery({ store, params, clock });
  const trust = await rec.trustFor({ customer, cart, promotions: definitions });
  const planner = await plannerCandidate({ provider: plannerProvider, customer, catalog });
  if (planner) definitions.push(planner);
  return {
    definitions, nowMs, trust, recovery: rec, customer,
    planner, stageDemoContext: plannerProvider?.stageContext === true,
    selection: plannerProvider?.configured ? 'best-saving' : selectionFrom(params),
  };
}

/** wknd.promotions/v2 selection gate; anything but an explicit opt-in keeps v1 precedence. */
function selectionFrom(params = {}) {
  return params.PROMOTION_SELECTION === 'best-saving' ? 'best-saving' : 'explicit-first';
}

/** Promotion runtime without storage (library callers/tests): legacy seed definitions only. */
function staticRuntime(nowMs = Date.now()) {
  const at = new Date(0).toISOString();
  return {
    definitions: LEGACY_SEEDS.map((s) => legacyDoc(s, at)), nowMs, trust: () => ({ ok: true }), selection: 'explicit-first',
  };
}

module.exports = {
  createPromotionService,
  selectionFrom,
  migrateLegacyPromotions,
  migrationComplete,
  loadPromotionRuntime,
  staticRuntime,
  resolveTarget,
  encodeCursor,
  decodeCursor,
  LEGACY_SEEDS,
  MigrationError,
  toMinor,
  PromotionError,
};
