/**
 * Storefront GraphQL engine shared by the Runtime action and tests.
 */
const {
  parse, validate, execute, specifiedRules, NoSchemaIntrospectionCustomRule, getOperationAST,
  defaultFieldResolver, isNonNullType, isListType, isScalarType, isEnumType,
} = require('graphql');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const SDL = require('./schema-sdl');
const { buildResolvers } = require('./resolvers');
const { loadCatalog } = require('./catalog');
const { resolveCustomer } = require('./auth');

const CACHEABLE_ROOT_FIELDS = new Set([
  'products', 'refineProduct', 'variants', 'categories', 'productSearch', 'attributeMetadata',
  'storeConfig', 'availableStores', 'countries', 'country', 'attributesForm', 'attributesList',
  'checkoutAgreements', '__typename',
]);
const MAX_QUERY_LENGTH = 60000;
const MAX_DEPTH = 18;

let schema;
const documentCache = new Map();

function getSchema() {
  if (!schema) {
    const base = makeExecutableSchema({
      typeDefs: SDL,
      resolvers: {},
      resolverValidationOptions: { requireResolversToMatchSchema: 'ignore' },
    });
    schema = makeExecutableSchema({
      typeDefs: SDL,
      resolvers: buildResolvers(base),
      resolverValidationOptions: { requireResolversToMatchSchema: 'ignore' },
    });
  }
  return schema;
}

function depthOf(node, depth = 0) {
  if (!node.selectionSet) return depth;
  return Math.max(...node.selectionSet.selections.map((s) => depthOf(s, depth + 1)));
}

const SCALAR_DEFAULTS = {
  Boolean: false, Int: 0, Float: 0, String: '', ID: '',
};

/**
 * Commerce declares many non-null fields for features the demo store doesn't model
 * (gift options, B2B, returns…). Instead of hand-filling each, unmodelled non-null lists
 * resolve to [] and non-null scalars/enums to neutral defaults.
 */
function fieldResolver(source, args, context, info) {
  const value = defaultFieldResolver(source, args, context, info);
  if (value !== undefined && value !== null) return value;
  const type = info.returnType;
  if (!isNonNullType(type)) return value;
  const inner = type.ofType;
  if (isListType(inner)) return [];
  if (isEnumType(inner)) return inner.getValues()[0].value;
  if (isScalarType(inner) && inner.name in SCALAR_DEFAULTS) return SCALAR_DEFAULTS[inner.name];
  return value;
}

function parseDocument(query) {
  if (documentCache.has(query)) return documentCache.get(query);
  const doc = parse(query);
  if (documentCache.size > 500) documentCache.clear();
  documentCache.set(query, doc);
  return doc;
}

function errorShape(e) {
  const original = e.originalError || e;
  return {
    message: e.message,
    locations: e.locations,
    path: e.path,
    extensions: {
      category: original.extensions?.category || e.extensions?.category || 'graphql',
      ...(original.code ? { code: original.code } : {}),
    },
  };
}

/**
 * @param {object} req { query, variables, operationName, headers }
 * @param {object} deps { store, params, verify }
 * @returns {Promise<{ body: object, cacheable: boolean }>}
 */
async function runGraphQL(req, deps) {
  const { query, variables, operationName } = req;
  if (!query || typeof query !== 'string') {
    return { body: { errors: [{ message: 'Must provide query string.', extensions: { category: 'graphql-input' } }] }, cacheable: false };
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return { body: { errors: [{ message: 'Query is too large.', extensions: { category: 'graphql-input' } }] }, cacheable: false };
  }
  const s = getSchema();
  let doc;
  try {
    doc = parseDocument(query);
  } catch (e) {
    return { body: { errors: [errorShape(e)] }, cacheable: false };
  }
  const rules = deps.params?.ALLOW_INTROSPECTION === 'true' ? specifiedRules : [...specifiedRules, NoSchemaIntrospectionCustomRule];
  const validationErrors = validate(s, doc, rules);
  if (validationErrors.length) return { body: { errors: validationErrors.map(errorShape) }, cacheable: false };

  const op = getOperationAST(doc, operationName);
  if (!op) return { body: { errors: [{ message: 'Unknown operation.', extensions: { category: 'graphql-input' } }] }, cacheable: false };
  if (depthOf(op) > MAX_DEPTH) return { body: { errors: [{ message: 'Query is too deep.', extensions: { category: 'graphql-input' } }] }, cacheable: false };

  const rootFields = op.selectionSet.selections.map((sel) => sel.name?.value);
  const cacheable = op.operation === 'query' && rootFields.every((f) => CACHEABLE_ROOT_FIELDS.has(f));

  const contextValue = {
    store: deps.store,
    params: deps.params || {},
    namespace: deps.namespace ?? process.env.__OW_NAMESPACE,
    audienceFetchImpl: deps.audienceFetchImpl,
    factService: deps.factService,
    customer: null,
    cat: await loadCatalog(deps.store, {
      placeholderImage: deps.params?.PLACEHOLDER_IMAGE,
      siteOrigin: deps.params?.SITE_ORIGIN,
    }),
  };
  try {
    contextValue.customer = await resolveCustomer({
      headers: req.headers || {}, params: deps.params || {}, store: deps.store, verify: deps.verify,
    });
  } catch (e) {
    // Like Commerce: a stale/invalid token only fails customer-scoped fields (field-level
    // graphql-authorization errors survive API Mesh and trigger the drop-ins' sign-out).
    contextValue.authError = e;
  }

  const result = await execute({
    schema: s, document: doc, variableValues: variables || {}, operationName, contextValue, fieldResolver,
  });
  const body = { data: result.data ?? null };
  if (result.errors?.length) body.errors = result.errors.map(errorShape);
  return { body, cacheable: cacheable && !contextValue.customer && !result.errors?.length };
}

module.exports = { runGraphQL, getSchema };
