/**
 * wknd.promotions/v1 — bounds, normalization, DTO validation, canonical hashing and the fixed
 * error registry. Transport-independent; the MCP adapter and the storefront share this module
 * through lib/promotions.js. Frozen specification: candidate.5
 * (sha256 90260e5f65ccc929ac89f95fb7f9e98296b5330e310a8ca7fa5eb7579a01419d).
 */
const crypto = require('node:crypto');
const { validateBundle, TARGET_KEYS } = require('./bundles');

const API_VERSION = 'wknd.promotions/v1';

const LIMITS = {
  argsBytes: 16384,
  argsDepth: 8,
  resultBytes: 1048576,
  revisionMax: 2147483647,
  nameRawBytes: 960,
  nameMaxCodePoints: 120,
  nameMaxBytes: 480,
  codeRawChars: 64,
  basisPointsMax: 10000,
  amountMax: 100000000,
  targetMax: 100,
  skuRaw: 128,
  categoryRaw: 256,
  categoryMax: 120,
  categoryDepth: 8,
  affectedParents: 1000,
  affectedSellables: 5000,
  fieldErrors: 20,
  listDefault: 20,
  listMax: 50,
  cursorMax: 1024,
  cursorTtlSeconds: 900,
  idempotencyRaw: 64,
  actorBytes: 256,
  receiptPublicDays: 30,
  retryDelaySeconds: 5,
};

const PROMOTION_ID = /^prm_[0-9a-f]{32}$/;
const EFFECT_ID = /^eff_[0-9a-f]{32}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;
const SKU = /^[A-Z0-9][A-Z0-9-]{2,63}$/;
const CATEGORY = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const ASCII = /^\p{ASCII}*$/u;
const ASCII_EDGE = /^[ \t\r\n]+|[ \t\r\n]+$/g;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

const OPERATIONS = ['create', 'update', 'disable'];

const DEFINITION_KEYS = [
  'name', 'enabled', 'mode', 'code', 'discount', 'maxDiscountMinor', 'minimumMerchandiseMinor',
  'target', 'startsAt', 'endsAt', 'audienceRestriction',
];
const CREATE_REQUIRED = ['name', 'mode', 'discount', 'target'];
const CREATE_DEFAULTS = {
  enabled: false,
  code: null,
  maxDiscountMinor: null,
  minimumMerchandiseMinor: null,
  startsAt: null,
  endsAt: null,
  audienceRestriction: null,
};

const ERRORS = {
  VALIDATION_ERROR: ['Promotion arguments are invalid.', 'none'],
  REQUEST_TOO_LARGE: ['Promotion request exceeds the supported size.', 'none'],
  OUTPUT_TOO_LARGE: ['Promotion result exceeds the supported size.', 'none'],
  PROMOTION_NOT_FOUND: ['Promotion was not found.', 'none'],
  REVISION_CONFLICT: ['Promotion revision does not match.', 'none'],
  REVISION_EXHAUSTED: ['Promotion revision limit has been reached.', 'none'],
  COUPON_CODE_CONFLICT: ['Coupon code is already reserved.', 'none'],
  IDEMPOTENCY_CONFLICT: ['Idempotency key was used with different arguments.', 'none'],
  IDEMPOTENCY_RECORD_EXPIRED: ['Request receipt has expired; do not repeat the mutation.', 'none'],
  REQUEST_NOT_FOUND: ['Request receipt was not found; mutation outcome is unknown.', 'none'],
  INVALID_CURSOR: ['Cursor is invalid or expired; restart listing.', 'none'],
  UNSUPPORTED_AUDIENCE_RESTRICTION: ['Audience-restricted promotion management is not available.', 'none'],
  PROTECTED_POLICY_VIOLATION: ['Generic promotion management cannot change the protected recovery policy.', 'none'],
  RECOVERY_NOT_READY: ['Protected recovery requirements are not verified.', 'same-request'],
  TARGET_SCOPE_TOO_LARGE: ['Promotion target exceeds the supported scope.', 'none'],
  PROMOTION_STORAGE_UNINITIALIZED: ['Promotion storage requires an explicit migration.', 'none'],
  PROMOTION_CONFIGURATION_ERROR: ['Promotion service configuration is invalid.', 'none'],
  PROMOTION_SERVICE_UNAVAILABLE: ['Promotion service is unavailable.', 'same-request'],
  RECONCILIATION_REQUIRED: ['Mutation outcome is not yet known; look up the existing request.', 'lookup'],
};

const FIELD_MESSAGES = {
  REQUIRED: 'Required field is missing.',
  INVALID_TYPE: 'Field has an invalid type.',
  UNKNOWN_FIELD: 'Field is not supported.',
  INVALID_FORMAT: 'Field has an invalid format.',
  DUPLICATE: 'Field contains duplicate values.',
  UNKNOWN_REFERENCE: 'Field references an unknown catalog entry.',
  DATE_ORDER: 'Start must not be after end.',
  INCOMPATIBLE_FIELD: 'Field is incompatible with other fields.',
  IMMUTABLE: 'Field cannot be changed.',
  PROTECTED: 'Field is managed by the recovery policy.',
};

const WARNINGS = {
  PROMOTION_CACHE_INVALIDATION_FAILED: 'Promotion was saved; cache invalidation requires recovery.',
  PROMOTION_EFFECTS_PENDING: 'Promotion was saved; effects are pending.',
};

class PromotionError extends Error {
  constructor(code, { fields = [], details = null, committed = false } = {}) {
    super(ERRORS[code][0]);
    this.code = code;
    this.fields = fields;
    this.details = details;
    this.committed = committed;
  }
}

function fieldError(path, code, message) {
  return { path, code, message: message || FIELD_MESSAGES[code] };
}

const rangeMessage = (min, max) => `Expected an integer from ${min} to ${max}.`;

function errorBody(code, { fields = [], details = null } = {}) {
  const [message, retryMode] = ERRORS[code];
  const sorted = [...fields].sort((a, b) => (a.path === b.path
    ? a.code.localeCompare(b.code) : (a.path < b.path ? -1 : 1)));
  const retryable = retryMode !== 'none';
  return {
    code,
    message,
    retryable,
    retryMode,
    retryAfterSeconds: retryable ? LIMITS.retryDelaySeconds : null,
    fields: sorted.slice(0, LIMITS.fieldErrors),
    fieldsTruncated: sorted.length > LIMITS.fieldErrors,
    details,
  };
}

function errorEnvelope({
  code, fields, details, committed = false, request = null, correlationId, mutationCorrelationId = null,
}) {
  return {
    apiVersion: API_VERSION,
    ok: false,
    committed,
    error: errorBody(code, { fields, details }),
    request,
    correlationId,
    mutationCorrelationId,
  };
}

// Realm-independent: objects cloned by another realm (structuredClone, VM) are still plain.
function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  if (Object.prototype.toString.call(v) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || Object.getPrototypeOf(proto) === null;
}
const isInt = (v) => Number.isSafeInteger(v);
const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');

function jsonDepth(v, depth = 1) {
  if (Array.isArray(v)) return v.reduce((m, x) => Math.max(m, jsonDepth(x, depth + 1)), depth);
  if (isPlainObject(v)) return Object.values(v).reduce((m, x) => Math.max(m, jsonDepth(x, depth + 1)), depth);
  return depth - 1;
}

/** Arguments must be plain JSON: rejects functions, symbols, non-finite numbers, class instances. */
function isJsonValue(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJsonValue);
  if (isPlainObject(v)) return Object.values(v).every(isJsonValue);
  return false;
}

function checkArgumentSize(args) {
  if (!isPlainObject(args) || !isJsonValue(args)) return 'VALIDATION_ERROR';
  if (utf8Bytes(JSON.stringify(args)) > LIMITS.argsBytes) return 'REQUEST_TOO_LARGE';
  if (jsonDepth(args) > LIMITS.argsDepth) return 'REQUEST_TOO_LARGE';
  return null;
}

/* ---------- canonical JSON / hashing ---------- */

function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const requestHash = (payload) => sha256(canonicalJson(payload));

/* ---------- scalar normalizers (null on failure) ---------- */

const trimAscii = (s) => s.replace(ASCII_EDGE, '');

function normalizeCode(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.codeRawChars || !ASCII.test(raw)) return null;
  const code = trimAscii(raw).toUpperCase();
  return CODE.test(code) ? code : null;
}

function normalizeSku(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.skuRaw || !ASCII.test(raw)) return null;
  const sku = trimAscii(raw).toUpperCase();
  return SKU.test(sku) ? sku : null;
}

function normalizeCategory(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.categoryRaw || !ASCII.test(raw)) return null;
  const path = trimAscii(raw).toLowerCase();
  if (!path.length || path.length > LIMITS.categoryMax || !CATEGORY.test(path)) return null;
  return path.split('/').length <= LIMITS.categoryDepth ? path : null;
}

function normalizeName(raw) {
  if (typeof raw !== 'string' || utf8Bytes(raw) > LIMITS.nameRawBytes) return null;
  const name = trimAscii(raw.normalize('NFC'));
  const points = [...name].length;
  if (points < 1 || points > LIMITS.nameMaxCodePoints || utf8Bytes(name) > LIMITS.nameMaxBytes) return null;
  return CONTROL_OR_FORMAT.test(name) ? null : name;
}

function parseTimestamp(raw) {
  if (typeof raw !== 'string' || raw.length !== 24) return null;
  const m = TIMESTAMP.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 2000 || year > 2099) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== raw) return null;
  return ms;
}

function normalizeIdempotencyKey(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.idempotencyRaw) return null;
  const key = trimAscii(raw).toLowerCase();
  return UUID_V4.test(key) ? key : null;
}

const validRevision = (v) => isInt(v) && v >= 1 && v <= LIMITS.revisionMax;

/* ---------- verified server context ---------- */

function validContextString(s) {
  return typeof s === 'string' && s.length > 0 && utf8Bytes(s) <= LIMITS.actorBytes && !/[\p{Cc}]/u.test(s);
}

/**
 * Verified actor kinds (internal context, never accepted from tool arguments):
 * - `ims-operator`: individually verified IMS user and org.
 * - `integration`: a shared server-configured integration credential (e.g. MCP shared-secret
 *   header). subject/orgId are server-owned constants for that integration, not a human or a
 *   proven IMS org membership.
 * The boundary builds this only after verifying its credential; shape alone is not authentication.
 */
const ACTOR_KINDS = ['ims-operator', 'integration'];

function validateContext(ctx) {
  return Boolean(ctx && ctx.actor && ACTOR_KINDS.includes(ctx.actor.kind)
    && validContextString(ctx.actor.subject) && validContextString(ctx.actor.orgId)
    && typeof ctx.correlationId === 'string' && UUID_V4.test(ctx.correlationId));
}

/* ---------- definition validation ---------- */

function checkUnknownKeys(obj, allowed, path, fields) {
  Object.keys(obj).forEach((k) => {
    if (!allowed.includes(k)) fields.push(fieldError(`${path}/${k}`, 'UNKNOWN_FIELD'));
  });
}

/** Structural unknown-field scan used before the receipt claim for updates. */
function unknownDefinitionFields(def, path = '/promotion') {
  const fields = [];
  if (!isPlainObject(def)) return [fieldError(path, 'INVALID_TYPE')];
  checkUnknownKeys(def, DEFINITION_KEYS, path, fields);
  if (isPlainObject(def.discount)) {
    const allowed = def.discount.kind === 'fixed' ? ['kind', 'amountMinor', 'currency'] : ['kind', 'basisPoints'];
    checkUnknownKeys(def.discount, allowed, `${path}/discount`, fields);
  }
  if (isPlainObject(def.target)) {
    checkUnknownKeys(def.target, def.target.kind === 'bundle' ? TARGET_KEYS : def.target.kind === 'all' ? ['kind'] : ['kind', 'values'], `${path}/target`, fields);
  }
  return fields;
}

function validateDiscount(raw, path, fields) {
  if (!isPlainObject(raw)) {
    fields.push(fieldError(path, raw === undefined ? 'REQUIRED' : 'INVALID_TYPE'));
    return raw;
  }
  if (raw.kind === 'percentage') {
    checkUnknownKeys(raw, ['kind', 'basisPoints'], path, fields);
    if (raw.basisPoints === undefined) fields.push(fieldError(`${path}/basisPoints`, 'REQUIRED'));
    else if (!isInt(raw.basisPoints)) fields.push(fieldError(`${path}/basisPoints`, 'INVALID_TYPE'));
    else if (raw.basisPoints < 1 || raw.basisPoints > LIMITS.basisPointsMax) {
      fields.push(fieldError(`${path}/basisPoints`, 'OUT_OF_RANGE', rangeMessage(1, LIMITS.basisPointsMax)));
    }
    return { kind: 'percentage', basisPoints: raw.basisPoints };
  }
  if (raw.kind === 'fixed') {
    checkUnknownKeys(raw, ['kind', 'amountMinor', 'currency'], path, fields);
    if (raw.amountMinor === undefined) fields.push(fieldError(`${path}/amountMinor`, 'REQUIRED'));
    else if (!isInt(raw.amountMinor)) fields.push(fieldError(`${path}/amountMinor`, 'INVALID_TYPE'));
    else if (raw.amountMinor < 1 || raw.amountMinor > LIMITS.amountMax) {
      fields.push(fieldError(`${path}/amountMinor`, 'OUT_OF_RANGE', rangeMessage(1, LIMITS.amountMax)));
    }
    if (raw.currency === undefined) fields.push(fieldError(`${path}/currency`, 'REQUIRED'));
    else if (raw.currency !== 'AUD') fields.push(fieldError(`${path}/currency`, 'INVALID_FORMAT'));
    return { kind: 'fixed', amountMinor: raw.amountMinor, currency: raw.currency };
  }
  fields.push(fieldError(`${path}/kind`, raw.kind === undefined ? 'REQUIRED' : 'INVALID_FORMAT'));
  return raw;
}

function validateTarget(raw, path, fields) {
  if (!isPlainObject(raw)) {
    fields.push(fieldError(path, raw === undefined ? 'REQUIRED' : 'INVALID_TYPE'));
    return raw;
  }
  if (raw.kind === 'bundle') return validateBundle(raw, path, fields);
  if (raw.kind === 'all') {
    checkUnknownKeys(raw, ['kind'], path, fields);
    return { kind: 'all' };
  }
  if (raw.kind !== 'skus' && raw.kind !== 'categories') {
    fields.push(fieldError(`${path}/kind`, raw.kind === undefined ? 'REQUIRED' : 'INVALID_FORMAT'));
    return raw;
  }
  checkUnknownKeys(raw, ['kind', 'values'], path, fields);
  const vpath = `${path}/values`;
  if (raw.values === undefined) {
    fields.push(fieldError(vpath, 'REQUIRED'));
    return raw;
  }
  if (!Array.isArray(raw.values)) {
    fields.push(fieldError(vpath, 'INVALID_TYPE'));
    return raw;
  }
  if (raw.values.length < 1 || raw.values.length > LIMITS.targetMax) {
    fields.push(fieldError(vpath, 'OUT_OF_RANGE', `Expected 1 to ${LIMITS.targetMax} entries.`));
    return raw;
  }
  const normalize = raw.kind === 'skus' ? normalizeSku : normalizeCategory;
  const values = raw.values.map((v, i) => {
    const n = normalize(v);
    if (n === null) fields.push(fieldError(`${vpath}/${i}`, typeof v === 'string' ? 'INVALID_FORMAT' : 'INVALID_TYPE'));
    return n ?? v;
  });
  if (new Set(values).size !== values.length) fields.push(fieldError(vpath, 'DUPLICATE'));
  return { kind: raw.kind, values: [...values].sort() };
}

function validateNullableInt(raw, path, min, fields) {
  if (raw === null) return null;
  if (!isInt(raw)) fields.push(fieldError(path, 'INVALID_TYPE'));
  else if (raw < min || raw > LIMITS.amountMax) fields.push(fieldError(path, 'OUT_OF_RANGE', rangeMessage(min, LIMITS.amountMax)));
  return raw;
}

function validateNullableTimestamp(raw, path, fields) {
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    fields.push(fieldError(path, 'INVALID_TYPE'));
    return raw;
  }
  if (parseTimestamp(raw) === null) fields.push(fieldError(path, 'INVALID_FORMAT'));
  return raw;
}

/**
 * Validates and normalizes a create or full-update definition.
 * Returns the normalized definition (best effort, also for hashing claimed invalid input) and
 * any field errors. `audienceUnsupported` flags a non-null audience restriction separately so
 * callers return UNSUPPORTED_AUDIENCE_RESTRICTION instead of a generic validation error.
 * @param {object} raw input definition
 * @param {'create'|'update'} kind
 */
function validateDefinition(raw, kind, path = '/promotion') {
  const fields = [];
  if (!isPlainObject(raw)) return { definition: raw, fields: [fieldError(path, raw === undefined ? 'REQUIRED' : 'INVALID_TYPE')], audienceUnsupported: false };
  checkUnknownKeys(raw, DEFINITION_KEYS, path, fields);
  const input = kind === 'create' ? { ...CREATE_DEFAULTS, ...raw } : raw;
  const required = kind === 'create' ? CREATE_REQUIRED : DEFINITION_KEYS;
  required.forEach((k) => {
    if (input[k] === undefined) fields.push(fieldError(`${path}/${k}`, 'REQUIRED'));
  });
  if (kind === 'create' && input.mode === 'coupon' && raw.code === undefined) {
    fields.push(fieldError(`${path}/code`, 'REQUIRED'));
  }
  const def = {};
  if (input.name !== undefined) {
    def.name = normalizeName(input.name);
    if (def.name === null) {
      fields.push(fieldError(`${path}/name`, typeof input.name === 'string' ? 'INVALID_FORMAT' : 'INVALID_TYPE'));
      def.name = input.name;
    }
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') fields.push(fieldError(`${path}/enabled`, 'INVALID_TYPE'));
    def.enabled = input.enabled;
  }
  if (input.mode !== undefined) {
    if (input.mode !== 'coupon' && input.mode !== 'automatic') fields.push(fieldError(`${path}/mode`, 'INVALID_FORMAT'));
    def.mode = input.mode;
  }
  if (input.code !== undefined) {
    if (input.code === null) def.code = null;
    else {
      def.code = normalizeCode(input.code);
      if (def.code === null) {
        fields.push(fieldError(`${path}/code`, typeof input.code === 'string' ? 'INVALID_FORMAT' : 'INVALID_TYPE'));
        def.code = input.code;
      }
    }
    if (def.mode === 'automatic' && def.code !== null) fields.push(fieldError(`${path}/code`, 'INCOMPATIBLE_FIELD'));
    if (def.mode === 'coupon' && def.code === null) fields.push(fieldError(`${path}/code`, 'REQUIRED'));
  }
  if (input.discount !== undefined) def.discount = validateDiscount(input.discount, `${path}/discount`, fields);
  if (input.maxDiscountMinor !== undefined) def.maxDiscountMinor = validateNullableInt(input.maxDiscountMinor, `${path}/maxDiscountMinor`, 1, fields);
  if (input.minimumMerchandiseMinor !== undefined) {
    def.minimumMerchandiseMinor = validateNullableInt(input.minimumMerchandiseMinor, `${path}/minimumMerchandiseMinor`, 0, fields);
  }
  if (input.target !== undefined) def.target = validateTarget(input.target, `${path}/target`, fields);
  if (input.startsAt !== undefined) def.startsAt = validateNullableTimestamp(input.startsAt, `${path}/startsAt`, fields);
  if (input.endsAt !== undefined) def.endsAt = validateNullableTimestamp(input.endsAt, `${path}/endsAt`, fields);
  const s = parseTimestamp(def.startsAt);
  const e = parseTimestamp(def.endsAt);
  if (s !== null && e !== null && s > e) fields.push(fieldError(`${path}/endsAt`, 'DATE_ORDER'));
  let audienceUnsupported = false;
  if (input.audienceRestriction !== undefined) {
    def.audienceRestriction = input.audienceRestriction;
    if (input.audienceRestriction !== null) {
      audienceUnsupported = !require('./audience-demo').canonicalRestriction(input.audienceRestriction);
    }
  }
  return { definition: def, fields, audienceUnsupported };
}

/* ---------- DTOs ---------- */

function readDto(doc) {
  return {
    id: doc.id,
    revision: doc.revision,
    managementClass: doc.managementClass || 'standard',
    name: doc.name,
    enabled: doc.enabled,
    mode: doc.mode,
    code: doc.code,
    discount: { ...doc.discount },
    maxDiscountMinor: doc.maxDiscountMinor,
    minimumMerchandiseMinor: doc.minimumMerchandiseMinor,
    target: doc.target.kind === 'bundle' ? JSON.parse(JSON.stringify(doc.target))
      : doc.target.kind === 'all' ? { kind: 'all' } : { kind: doc.target.kind, values: [...doc.target.values] },
    startsAt: doc.startsAt,
    endsAt: doc.endsAt,
    audienceRestriction: doc.audienceRestriction ? structuredClone(doc.audienceRestriction) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const definitionOf = (doc) => Object.fromEntries(DEFINITION_KEYS.map((k) => [k, doc[k] ?? null]));

const newPromotionId = () => `prm_${crypto.randomBytes(16).toString('hex')}`;
const newEffectId = () => `eff_${crypto.randomBytes(16).toString('hex')}`;

module.exports = {
  API_VERSION,
  LIMITS,
  ERRORS,
  WARNINGS,
  FIELD_MESSAGES,
  OPERATIONS,
  DEFINITION_KEYS,
  CREATE_DEFAULTS,
  PROMOTION_ID,
  EFFECT_ID,
  UUID_V4,
  PromotionError,
  fieldError,
  errorBody,
  errorEnvelope,
  isPlainObject,
  isInt,
  utf8Bytes,
  checkArgumentSize,
  canonicalJson,
  requestHash,
  sha256,
  normalizeCode,
  normalizeSku,
  normalizeCategory,
  normalizeName,
  parseTimestamp,
  normalizeIdempotencyKey,
  validRevision,
  validateContext,
  ACTOR_KINDS,
  unknownDefinitionFields,
  validateDefinition,
  readDto,
  definitionOf,
  newPromotionId,
  newEffectId,
};
