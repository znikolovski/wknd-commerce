const { z } = require('zod');
const S = require('./promotion-schema');
const { definition, createDefinition } = require('./promotion-tool-schema');
const { isDuplicateKeyError } = require('./store');
const audiences = require('./promotion-authoring-audiences');
const { ENVIRONMENTS } = require('./promotion-authoring-environment');

const API_VERSION = 'wknd.promotion-drafts/v2';
const COLLECTION = 'promotion_drafts_v2';
const restrictionSchema = z.strictObject({
  environment: z.enum(ENVIRONMENTS),
  key: z.enum([...new Set(audiences.map((a) => a.key))]),
  version: z.literal(1),
});
const createSchema = z.strictObject({
  ...createDefinition, enabled: z.literal(false).optional(), audienceRestriction: restrictionSchema,
});
const updateSchema = z.strictObject({
  ...definition, enabled: z.literal(false), audienceRestriction: restrictionSchema,
});
const id = z.string().regex(/^pdr_[0-9a-f]{32}$/);
const revision = z.int().min(1).max(S.LIMITS.revisionMax);
const schemas = {
  validate: z.strictObject({ promotion: createSchema }),
  create: z.strictObject({ idempotencyKey: z.string().regex(S.UUID_V4), promotion: createSchema }),
  get: z.strictObject({ id }),
  list: z.strictObject({ limit: z.int().min(1).max(50).optional(), after: id.optional() }),
  update: z.strictObject({ id, expectedRevision: revision, promotion: updateSchema }),
  delete: z.strictObject({ id, expectedRevision: revision }),
};
const envelope = () => ({
  apiVersion: API_VERSION, financialAuthorization: false,
  activation: { blocked: true, reason: 'PROVIDER_NOT_VERIFIED' },
  availability: { status: 'unavailable', reason: 'FINANCIAL_AUTHORITY_NOT_PRESENT' },
});
const fail = (code, message, fields = []) => ({
  ...envelope(), ok: false, error: { code, message, fields: fields.slice(0, S.LIMITS.fieldErrors) },
});
const schemaFields = (error) => error.issues.map((issue) => ({
  path: `/${issue.path.join('/')}`, code: issue.code, message: issue.message,
}));

function validateDraftDefinition(promotion, kind = 'create') {
  if (promotion?.enabled === true) {
    return fail('RESTRICTED_ACTIVATION_BLOCKED', 'Audience-restricted drafts cannot be enabled or applied without a verified provider.');
  }
  const parsed = (kind === 'update' ? updateSchema : createSchema).safeParse(promotion);
  if (!parsed.success) return fail('INVALID_DRAFT', 'Draft definition is invalid.', schemaFields(parsed.error));
  const normalized = S.validateDefinition({ ...parsed.data, audienceRestriction: null }, kind);
  if (normalized.fields.length) return fail('INVALID_DRAFT', 'Draft definition is invalid.', normalized.fields);
  return {
    ...envelope(), ok: true, persisted: false,
    promotion: { ...normalized.definition, audienceRestriction: parsed.data.audienceRestriction },
  };
}

function draftDto(doc) {
  return structuredClone({
    id: doc.id, revision: doc.revision, state: 'draft', promotion: doc.promotion,
    createdAt: doc.createdAt, updatedAt: doc.updatedAt,
  });
}

function createPromotionDraftService({ store, clock = Date.now }) {
  const drafts = () => store.collection(COLLECTION);
  const iso = () => new Date(clock()).toISOString();
  const environmentFor = (ctx) => ctx.authoringEnvironment === undefined ? 'stage' : ctx.authoringEnvironment;
  const filter = (ctx, draftId) => ({
    id: draftId, orgId: ctx.actor.orgId, deleted: false,
    'promotion.audienceRestriction.environment': environmentFor(ctx),
  });
  const success = (doc, extra = {}) => ({ ...envelope(), ok: true, persisted: true, draft: draftDto(doc), ...extra });
  const missing = () => fail('DRAFT_NOT_FOUND', 'Audience draft was not found.');
  const conflict = () => fail('REVISION_CONFLICT', 'Draft revision changed. Read the draft before saving again.');

  function guard(ctx, args, method) {
    if (!S.validateContext(ctx)) return fail('DRAFT_CONTEXT_INVALID', 'A verified operator or integration context is required.');
    if (!ENVIRONMENTS.includes(environmentFor(ctx))) return fail('DRAFT_ENVIRONMENT_UNAVAILABLE', 'Server authoring environment is unavailable.');
    const size = S.checkArgumentSize(args);
    if (size) return fail(size, S.ERRORS[size][0]);
    if (args.promotion?.enabled === true) return validateDraftDefinition(args.promotion);
    if (args.promotion?.audienceRestriction?.environment !== undefined
      && args.promotion.audienceRestriction.environment !== environmentFor(ctx)) {
      return fail('INVALID_DRAFT', 'Draft environment must match the server authoring environment.');
    }
    const parsed = schemas[method].safeParse(args);
    return parsed.success ? null : fail('INVALID_DRAFT', 'Draft arguments are invalid.', schemaFields(parsed.error));
  }

  async function create(ctx, args) {
    const invalid = guard(ctx, args, 'create');
    if (invalid) return invalid;
    const validated = validateDraftDefinition(args.promotion);
    if (!validated.ok) return validated;
    const identity = environmentFor(ctx) === 'stage' ? [ctx.actor, args.idempotencyKey]
      : [ctx.actor, environmentFor(ctx), args.idempotencyKey];
    const draftId = `pdr_${S.sha256(S.canonicalJson(identity)).slice(0, 32)}`;
    const at = iso();
    const doc = {
      _id: draftId, id: draftId, orgId: ctx.actor.orgId, deleted: false, revision: 1,
      promotion: validated.promotion, creationHash: S.requestHash(validated.promotion),
      createdAt: at, updatedAt: at, createdBy: ctx.actor, updatedBy: ctx.actor,
    };
    try {
      await drafts().insertOne(doc);
      return success(doc, { replayed: false });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await drafts().findOne({
        id: draftId, orgId: ctx.actor.orgId,
        'promotion.audienceRestriction.environment': environmentFor(ctx),
      });
      if (!existing) throw error;
      if (existing.creationHash !== doc.creationHash) return fail('IDEMPOTENCY_CONFLICT', 'Create key was used with different draft terms.');
      if (existing.deleted) return fail('DRAFT_DELETED', 'This create key belongs to a deleted draft. It cannot recreate it.');
      return success(existing, { replayed: true });
    }
  }

  async function get(ctx, args) {
    const invalid = guard(ctx, args, 'get');
    if (invalid) return invalid;
    const doc = await drafts().findOne(filter(ctx, args.id));
    return doc ? success(doc) : missing();
  }

  async function list(ctx, args = {}) {
    const invalid = guard(ctx, args, 'list');
    if (invalid) return invalid;
    const limit = args.limit || 20;
    const docs = await drafts().find({
      orgId: ctx.actor.orgId, deleted: false, ...(args.after ? { id: { $gt: args.after } } : {}),
      'promotion.audienceRestriction.environment': environmentFor(ctx),
    }, { sort: { id: 1 }, limit: limit + 1 });
    const page = docs.slice(0, limit);
    return {
      ...envelope(), ok: true, items: page.map(draftDto),
      nextAfter: docs.length > limit ? page[page.length - 1].id : null,
    };
  }

  async function update(ctx, args) {
    const invalid = guard(ctx, args, 'update');
    if (invalid) return invalid;
    const validated = validateDraftDefinition(args.promotion, 'update');
    if (!validated.ok) return validated;
    const doc = await drafts().findOne(filter(ctx, args.id));
    if (!doc) return missing();
    if (doc.revision !== args.expectedRevision) return conflict();
    if (doc.revision === S.LIMITS.revisionMax) return fail('REVISION_EXHAUSTED', 'Draft revision limit has been reached.');
    const next = { ...doc, revision: doc.revision + 1, promotion: validated.promotion, updatedAt: iso(), updatedBy: ctx.actor };
    const written = await drafts().replaceOne({ ...filter(ctx, args.id), revision: args.expectedRevision }, next);
    return written.matchedCount === 1 ? success(next) : conflict();
  }

  async function remove(ctx, args) {
    const invalid = guard(ctx, args, 'delete');
    if (invalid) return invalid;
    const doc = await drafts().findOne(filter(ctx, args.id));
    if (!doc) return missing();
    if (doc.revision !== args.expectedRevision) return conflict();
    if (doc.revision === S.LIMITS.revisionMax) return fail('REVISION_EXHAUSTED', 'Draft revision limit has been reached.');
    const written = await drafts().updateOne({ ...filter(ctx, args.id), revision: args.expectedRevision }, {
      $set: { deleted: true, revision: doc.revision + 1, updatedAt: iso(), updatedBy: ctx.actor },
    });
    return written.matchedCount === 1
      ? { ...envelope(), ok: true, persisted: true, deleted: true, id: doc.id, revision: doc.revision + 1 }
      : conflict();
  }

  return {
    create, get, list, update, delete: remove,
    async validate(ctx, args) {
      return guard(ctx, args, 'validate') || validateDraftDefinition(args.promotion);
    },
  };
}

function draftTools() {
  return Object.entries(schemas).map(([method, schema]) => ({
    name: method === 'list' ? 'list_audience_promotion_drafts' : `${method}_audience_promotion_draft`,
    description: `${method} a server-environment Stage/Production audience draft (wknd.promotion-drafts/v2). Separate draft storage, never live offers. Financial availability remains unavailable; cannot enable/apply. Create retries reuse the original UUID key; update/delete conflicts require a fresh read.`,
    schema, readOnly: ['get', 'list', 'validate'].includes(method), serviceValidated: true,
    argumentError: () => fail('REQUEST_TOO_LARGE', 'Draft arguments exceed the supported bounds.'),
    async run(store, args, context) {
      const result = await createPromotionDraftService({ store })[method](context, args);
      if (!result.ok) context.logger.error('mcp.draft.rejected', { code: result.error.code, correlationId: context.correlationId });
      return result;
    },
  }));
}

module.exports = {
  API_VERSION, COLLECTION, restrictionSchema, schemas, validateDraftDefinition, createPromotionDraftService, draftTools,
};
