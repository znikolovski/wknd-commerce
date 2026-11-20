const { z } = require('zod');
const { loadCatalog } = require('./catalog');
const { createPromotionService } = require('./promotions');
const { McpToolError } = require('./mcp-reads');
const { errorEnvelope } = require('./promotion-schema');

const id = z.string().regex(/^prm_[0-9a-f]{32}$/);
const key = z.string().max(64);
const revision = z.int().min(1).max(2147483647);
const amount = z.int().min(1).max(100000000);
const definition = {
  name: z.string().max(960),
  enabled: z.boolean(),
  mode: z.enum(['coupon', 'automatic']),
  code: z.string().max(64).nullable(),
  discount: z.union([
    z.strictObject({ kind: z.literal('percentage'), basisPoints: z.int().min(1).max(10000) }),
    z.strictObject({ kind: z.literal('fixed'), amountMinor: amount, currency: z.literal('AUD') }),
  ]),
  maxDiscountMinor: amount.nullable(),
  minimumMerchandiseMinor: z.int().min(0).max(100000000).nullable(),
  target: z.union([
    z.strictObject({ kind: z.literal('all') }),
    z.strictObject({ kind: z.enum(['skus', 'categories']), values: z.array(z.string().max(256)).min(1).max(100) }),
  ]),
  startsAt: z.string().max(24).nullable(),
  endsAt: z.string().max(24).nullable(),
  audienceRestriction: z.null(),
};
const optionalCreate = new Set(['enabled', 'code', 'maxDiscountMinor', 'minimumMerchandiseMinor', 'startsAt', 'endsAt', 'audienceRestriction']);
const createDefinition = Object.fromEntries(Object.entries(definition).map(([k, v]) => [k, optionalCreate.has(k) ? v.optional() : v]));

function promotionTools() {
  function tool(name, method, description, schema, readOnly) {
    return {
      name, description, schema, readOnly, serviceValidated: true,
      argumentError: (context) => errorEnvelope({ code: 'REQUEST_TOO_LARGE', correlationId: context.correlationId }),
      async run(store, args, context) {
        if (!readOnly && !context.promotionWritesEnabled) {
          throw new McpToolError('PROMOTION_WRITES_DISABLED', 'Promotion writes require deployment approval after real-database verification and migration.');
        }
        const service = createPromotionService({
          store,
          loadCatalog: () => loadCatalog(store, { fresh: true }),
          cursorKey: context.promotionCursorKey,
          params: { RECOVERY_REDEMPTION_VERIFIED: context.recoveryRedemptionVerified },
        });
        const result = await service[method]({ actor: context.actor, correlationId: context.correlationId }, args);
        if (!result.ok) context.logger.error('mcp.promotion.rejected', { code: result.error.code, correlationId: context.correlationId });
        return result;
      },
    };
  }
  return [
    tool('list_promotions', 'listPromotions', 'List promotions (wknd.promotions/v1); opaque 15-minute live keyset cursor bound to filters and limit. No shopper or audience data.',
      z.strictObject({ limit: z.int().min(1).max(50).optional(), cursor: z.string().max(1024).optional(), enabled: z.boolean().optional() }), true),
    tool('get_promotion', 'getPromotion', 'Read a promotion by ID OR reconcile an existing mutation using request.operation and the original idempotencyKey. Missing/expired receipts never authorize another write. Read-only managementClass identifies protected recovery.',
      z.strictObject({
        id: id.optional(),
        request: z.strictObject({ operation: z.enum(['create', 'update', 'disable']), idempotencyKey: key }).optional(),
      }), true),
    tool('create_promotion', 'createPromotion', 'Create a coupon or automatic promotion. Supply a UUIDv4 idempotencyKey; default disabled, nullable fields default null. Audience targeting unsupported. Cannot create private recovery policy. Unknown outcome: use get_promotion(request), never a new key.',
      z.strictObject({ idempotencyKey: key, promotion: z.strictObject(createDefinition) }), false),
    tool('update_promotion', 'updatePromotion', 'Full replacement requires EVERY mutable definition key, current expectedRevision and UUIDv4 idempotencyKey. Protected recovery permits only name/enabled changes. On unknown outcome reconcile the original request.',
      z.strictObject({ id, expectedRevision: revision, idempotencyKey: key, promotion: z.strictObject(definition) }), false),
    tool('disable_promotion', 'disablePromotion', 'Revision-aware safety disable; no catalog/provider dependency. Uses global promotion invalidation without product-price changes/PDP rendering. IdempotencyKey is UUIDv4; reconcile unknown outcomes with the same request.',
      z.strictObject({ id, expectedRevision: revision, idempotencyKey: key }), false),
  ];
}

module.exports = { promotionTools };
