/**
 * Human operator surface for promotions and recovery-email runs (ExC Shell admin UI).
 *
 * The `commerce-admin/promotions` action is IMS-protected (require-adobe-auth); the gateway has
 * validated the bearer token, and this module derives an individually verified `ims-operator`
 * actor from it. That actor is what the shared promotion service audits and what recovery-email
 * run approval requires (a shared integration credential cannot approve). Sending is not exposed.
 */
const crypto = require('node:crypto');
const { loadCatalog } = require('./catalog');
const { createPromotionService } = require('./promotions');
const { createRecoveryEmail, RecoveryEmailError } = require('./recovery-email');
const S = require('./promotion-schema');

class OperatorError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function headerOf(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/**
 * Verified operator from the gateway-validated IMS access token and org header.
 * @returns {{ kind: 'ims-operator', subject: string, orgId: string }}
 */
function imsOperatorFrom(headers = {}, params = {}) {
  const org = headerOf(headers, 'x-gw-ims-org-id');
  if (!org) throw new OperatorError('Missing IMS organisation.', 401);
  if (params.ADMIN_IMS_ORG && org !== params.ADMIN_IMS_ORG) {
    throw new OperatorError('This IMS organisation cannot manage the WKND store.', 403);
  }
  const auth = String(headerOf(headers, 'authorization') || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let claims = null;
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
  } catch (e) {
    claims = null;
  }
  const subject = claims?.user_id;
  // Service/technical-account tokens are not an individually verified person.
  if (typeof subject !== 'string' || !subject || /@techacct\.adobe\.com$/i.test(subject)) {
    throw new OperatorError('Sign in as an individual Adobe user to manage promotions.', 401);
  }
  return { kind: 'ims-operator', subject, orgId: org };
}

function createPromotionsAdmin({
  store, params = {}, clock = Date.now, catalog = () => loadCatalog(store, { fresh: true }),
}) {
  const service = createPromotionService({
    store, clock, loadCatalog: catalog, cursorKey: params.PROMOTION_CURSOR_KEY, params,
  });
  const email = createRecoveryEmail({ store, params, clock });
  const ctxFor = (actor) => ({ actor, correlationId: crypto.randomUUID() });
  const idem = (args) => args.idempotencyKey || crypto.randomUUID();

  async function setEnabled(actor, { id, expectedRevision, enabled, idempotencyKey }) {
    if (typeof enabled !== 'boolean') throw new OperatorError('enabled must be true or false.');
    if (!enabled) {
      return service.disablePromotion(ctxFor(actor), { id, expectedRevision, idempotencyKey: idem({ idempotencyKey }) });
    }
    const current = await service.getPromotion(ctxFor(actor), { id });
    if (!current.ok) return current;
    // The service enforces expectedRevision (REVISION_CONFLICT) and protected-policy rules.
    return service.updatePromotion(ctxFor(actor), {
      id,
      expectedRevision,
      idempotencyKey: idem({ idempotencyKey }),
      promotion: { ...S.definitionOf(current.promotion), enabled: true },
    });
  }

  const OPS = {
    'promotions.list': (actor, a) => service.listPromotions(ctxFor(actor), pick(a, ['limit', 'cursor', 'enabled'])),
    'promotions.get': (actor, a) => service.getPromotion(ctxFor(actor), pick(a, ['id'])),
    'promotions.create': (actor, a) => service.createPromotion(ctxFor(actor), {
      idempotencyKey: idem(a), promotion: a.promotion,
    }),
    'promotions.update': (actor, a) => service.updatePromotion(ctxFor(actor), {
      id: a.id, expectedRevision: a.expectedRevision, idempotencyKey: idem(a), promotion: a.promotion,
    }),
    'promotions.setEnabled': (actor, a) => setEnabled(actor, a),
    'email.status': () => email.status(),
    'email.runs': (actor, a) => email.listRuns({ limit: a.limit }),
    'email.requestRun': (actor, a) => email.requestRun(ctxFor(actor), pick(a, ['maxRecipients', 'templateId'])),
    'email.approveRun': (actor, a) => email.approveRun(ctxFor(actor), pick(a, ['runId', 'templateId', 'maxRecipients'])),
    'email.pause': () => email.pause().then(() => ({ paused: true })),
    'email.resume': () => email.resume().then(() => ({ paused: false })),
  };

  return {
    ops: Object.keys(OPS),
    async handle(actor, op, args = {}) {
      const fn = OPS[op];
      if (!fn) throw new OperatorError(`Unknown op ${op}`);
      try {
        return await fn(actor, args || {});
      } catch (e) {
        if (e instanceof RecoveryEmailError) throw new OperatorError(e.message, e.code === 'NOT_FOUND' ? 404 : 409);
        throw e;
      }
    },
  };
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
}

module.exports = { createPromotionsAdmin, imsOperatorFrom, OperatorError };
