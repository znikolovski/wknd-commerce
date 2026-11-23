const { z } = require('zod');

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

module.exports = { definition, createDefinition };
