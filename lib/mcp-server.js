const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const reads = require('./mcp-reads');
const { changeSale } = require('./mcp-sales');
const { promotionTools } = require('./mcp-promotions');
const { bundleOpportunities } = require('./bundles');

const MAX_ARGUMENT_BYTES = 16384;
const MAX_RESULT_BYTES = 1048576;
const sku = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,63}$/);
const category = z.string().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*){0,7}$/);
const number = z.string().regex(/^WKND-DEMO-\d{6}-[A-F0-9]{6}$/);
const page = { page: z.int().min(1).max(100).optional(), pageSize: z.int().min(1).max(50).optional() };
const search = { ...page, q: z.string().max(120).optional() };
const date = z.string().regex(/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s, 'Use an exact UTC timestamp.');
const dates = { startsAt: date.nullable().optional(), endsAt: date.nullable().optional() };
const windowValid = (v) => !v.startsAt || !v.endsAt || v.startsAt <= v.endsAt;
const selection = z.union([
  z.strictObject({ category }),
  z.strictObject({ skus: z.array(sku).min(1).max(100).refine((s) => new Set(s).size === s.length, 'Duplicate SKUs.') }),
]);

function withinArgumentBounds(value) {
  const pending = [[value, 1]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (item && typeof item === 'object') {
      if (depth > 8) return false;
      Object.values(item).forEach((v) => pending.push([v, depth + 1]));
    }
  }
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_ARGUMENT_BYTES;
}

function toolResult(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) {
    throw new reads.McpToolError('OUTPUT_TOO_LARGE', 'Narrow the selection or reduce the page size.');
  }
  return { content: [{ type: 'text', text }], ...(value.ok === false ? { isError: true } : {}) };
}

function definitions() {
  const read = (name, description, schema, run) => ({ name, description, schema, run, readOnly: true });
  const sale = (name, description, schema, convert = (v) => v) => ({
    name, description, schema, readOnly: false,
    run: (store, args, context) => changeSale(store, convert(args), context),
  });
  return [
    read('bundle_opportunities', 'Bounded dated demo-order unit demand and co-purchase, compatible exact-variant kits and fresh AUD stock/price quotes. No PII, margin/surplus inference or financial approval. Create proposals disabled with create_promotion; separate Aero booking only.',
      z.strictObject({
        startsAt: date.optional(), endsAt: date.optional(), limit: z.int().min(1).max(10).optional(),
        orderLimit: z.int().min(1).max(500).optional(), safetyBuffer: z.int().min(0).max(20).optional(), category: category.optional(),
      }), bundleOpportunities),
    read('commerce_stats', 'Commerce catalog and latest 500 order aggregates; no customer data.', z.strictObject({}), reads.stats),
    read('list_categories', 'List catalog categories.', z.strictObject(page), reads.listCategories),
    read('list_products', 'List products, current AUD prices and sale definitions. Category matches include slash descendants only.',
      z.strictObject({ ...search, category: category.optional(), status: z.enum(['enabled', 'disabled']).optional(), onSaleOnly: z.boolean().optional() }), reads.listProducts),
    read('get_product', 'Read a parent product and its variant prices.', z.strictObject({ sku }), reads.getProduct),
    read('list_inventory', 'Read inventory quantities; this tool cannot change stock.',
      z.strictObject({ ...search, lowStockOnly: z.boolean().optional() }), reads.listInventory),
    read('list_orders', 'Read order summaries without customer, address, payment or access-token data. Optional exact order number, never email search.',
      z.strictObject({ ...page, number: number.optional() }), reads.listOrders),
    read('get_order', 'Read an order summary and line items; no customer or payment information.',
      z.strictObject({ number }), reads.getOrder),
    sale('set_product_sale', 'Set an AUD sale amount (integer cents) for a SKU; parent SKUs also change all variants. Regular prices are never changed. Not atomic or idempotent: inspect outcomes before retrying.',
      z.strictObject({ sku, amountMinor: z.int().min(0).max(100000000), ...dates }).refine(windowValid, 'Sale end must not precede its start.')),
    sale('clear_product_sale', 'Clear special prices/dates for a SKU; parent SKUs also clear all variants. Regular prices stay unchanged.',
      z.strictObject({ sku }), (v) => ({ ...v, clear: true })),
    sale('bulk_product_sale', 'Apply a 1% to below 90% sale to explicit SKUs or one category. At most 100 parents/1000 prices; not atomic or idempotent.',
      z.strictObject({ selection, percent: z.number().min(1).lt(90).multipleOf(0.01), ...dates }).refine(windowValid, 'Sale end must not precede its start.')),
    sale('bulk_clear_product_sale', 'Clear product sales for explicit SKUs or one category. No whole-catalog default; not atomic or idempotent.',
      z.strictObject({ selection }), (v) => ({ ...v, clear: true })),
    ...promotionTools(),
  ];
}

function createCommerceServer({ openStore, context }) {
  const server = new Server({ name: 'wknd-commerce', version: '1.0.0' }, { capabilities: { tools: {} } });
  const tools = definitions();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name, description: t.description,
      inputSchema: z.toJSONSchema(t.schema, { target: 'draft-7' }),
      annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly, idempotentHint: t.readOnly, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const t = tools.find((item) => item.name === request.params.name);
    if (!t) return toolResult({ ok: false, error: { code: 'UNKNOWN_TOOL', message: 'Unknown commerce tool.' }, correlationId: context.correlationId });
    const args = request.params.arguments ?? {};
    if (!withinArgumentBounds(args)) {
      if (t.argumentError) return toolResult(t.argumentError(context));
      return toolResult({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Arguments exceed size or depth limits.' }, correlationId: context.correlationId });
    }
    // Promotion validation/normalization and its frozen error envelopes belong to the shared service.
    const parsed = t.serviceValidated ? { success: true, data: args } : t.schema.safeParse(args);
    if (!parsed.success) {
      return toolResult({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'Arguments do not match the published tool schema.' }, correlationId: context.correlationId });
    }
    try {
      const store = await openStore();
      const result = await t.run(store, parsed.data, context);
      return toolResult(result);
    } catch (error) {
      const known = error instanceof reads.McpToolError;
      context.logger.error(known ? 'mcp.tool.rejected' : 'mcp.tool.failed', { correlationId: context.correlationId, tool: t.name });
      return toolResult({
        ok: false,
        error: { code: known ? error.code : 'COMMERCE_UNAVAILABLE', message: known ? error.message : 'Commerce is unavailable. Investigate before retrying writes.' },
        correlationId: context.correlationId,
      });
    }
  });
  return server;
}

module.exports = { createCommerceServer, MAX_ARGUMENT_BYTES, MAX_RESULT_BYTES };
