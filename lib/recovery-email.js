/**
 * Consented cart-recovery email (pilot). One email per inactivity episode, only to customers who
 * explicitly opted in to recovery emails, only within human-approved bounded runs, only to the
 * test-recipient allowlist while it is enabled (default), and never while paused (default).
 *
 * Eligibility reuses the protected recovery cohort (lib/recovery-policy.js): signed-in owner of a
 * non-empty active cart, inactive 24h..7d, no purchase since. Email links carry campaign
 * attribution only — never cart tokens, emails or customer ids; the shopper signs in normally.
 *
 * Collections: customers.marketing (preference), email_suppressions, recovery_email_runs,
 * recovery_email_ledger (unique per campaign/customer/episode), counters (pause switch).
 */
const crypto = require('node:crypto');
const { isDuplicateKeyError } = require('./store');
const { createBrevoClient } = require('./brevo');
const { withdrawIdLinkageForEmail } = require('./id-linkage-consent');
const { sha256, canonicalJson } = require('./promotion-schema');
const {
  qualifyingEpisode, POLICY_V1, DEFAULT_CAMPAIGN, promotionIdFor, integrityOk, readiness,
} = require('./recovery-policy');

const MAX_RUN_RECIPIENTS = 50;
const RUN_TTL_MS = 24 * 3600 * 1000;
const CLAIM_STALE_MS = 10 * 60 * 1000;
const SUPPRESS_EVENTS = new Set(['unsubscribed', 'hard_bounce', 'spam', 'blocked', 'invalid_email', 'complaint']);

class RecoveryEmailError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const emailKey = (email) => sha256(String(email || '').trim().toLowerCase());
const iso = (ms) => new Date(ms).toISOString();

/**
 * Allowlist entries are exact addresses (`name@example.com`) or whole domains (`@example.com`).
 * A domain entry matches only that exact domain (not subdomains or look-alikes).
 */
function allowlisted(allowlist, email) {
  const address = String(email || '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 1) return false;
  return allowlist.has(address) || allowlist.has(address.slice(at));
}

function settings(params = {}) {
  const allowlist = String(params.RECOVERY_EMAIL_ALLOWLIST || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return {
    allowlistEnabled: params.RECOVERY_EMAIL_ALLOWLIST_DISABLED !== 'true',
    allowlist: new Set(allowlist),
    dailyBudget: Math.min(Number(params.RECOVERY_EMAIL_DAILY_BUDGET) || 50, 300),
    templateId: params.BREVO_RECOVERY_TEMPLATE_ID || null,
    cartUrl: params.SHOP_CART_URL || null,
    campaignId: DEFAULT_CAMPAIGN.campaignId,
  };
}

/* ---------- consent (explicit, per purpose; never inferred or bundled) ---------- */

/**
 * Separate express-consent purposes (Spam Act 2003): cart reminders never imply news & offers and
 * vice versa. Every change is appended to marketing_consent_events with its wording version and
 * source so consent can be evidenced later; the profile keeps only the current state.
 */
const CONSENT_PURPOSES = Object.freeze({
  recovery: { field: 'recoveryEmail', prompt: 'Choose whether to receive cart reminders.' },
  audience: { field: 'audienceEmail', prompt: 'Choose whether to receive WKND news and offers.' },
});
const CONSENT_SOURCES = ['account-settings', 'ios', 'checkout'];
const WORDING_VERSION = /^[a-z0-9][a-z0-9._-]{0,47}$/;

async function appendConsentEvent(store, {
  subject, subjectKind, purpose, optIn, source, wordingVersion, at,
}) {
  const id = crypto.randomUUID();
  await store.collection('marketing_consent_events').insertOne({
    _id: id, id, subject, subjectKind, purpose, optIn, source, wordingVersion, at,
  });
}

async function setMarketingConsent(store, customer, purpose, optIn, {
  clock = Date.now, source = 'account-settings', wordingVersion = null,
} = {}) {
  const def = CONSENT_PURPOSES[purpose];
  if (!def) throw new RecoveryEmailError('INVALID', 'Unknown email preference.');
  if (!customer?.sub) throw new RecoveryEmailError('SIGN_IN_REQUIRED', 'Sign in to manage email preferences.');
  // Consent must come from the shopper directly (website or app), never via a delegated agent.
  if (customer.delegated) throw new RecoveryEmailError('DIRECT_SIGN_IN_REQUIRED', 'Change email preferences in your WKND account.');
  if (typeof optIn !== 'boolean') throw new RecoveryEmailError('INVALID', def.prompt);
  if (!CONSENT_SOURCES.includes(source)) throw new RecoveryEmailError('INVALID', 'Unknown consent source.');
  if (wordingVersion !== null && (typeof wordingVersion !== 'string' || !WORDING_VERSION.test(wordingVersion))) {
    throw new RecoveryEmailError('INVALID', 'Unknown consent wording version.');
  }
  if (purpose === 'audience' && optIn && !wordingVersion) {
    throw new RecoveryEmailError('INVALID', 'Consent wording version is required.');
  }
  const at = iso(clock());
  await store.collection('customers').updateOne(
    { sub: customer.sub },
    { $set: { [`marketing.${def.field}`]: { optIn, source, wordingVersion, updatedAt: at } } },
  );
  await appendConsentEvent(store, {
    subject: sha256(customer.sub), subjectKind: 'customer', purpose, optIn, source, wordingVersion, at,
  });
  return optIn;
}

const setRecoveryEmailOptIn = (store, customer, optIn, options = {}) => setMarketingConsent(store, customer, 'recovery', optIn, options);

const hasConsent = (customer, purpose) => customer?.marketing?.[CONSENT_PURPOSES[purpose]?.field]?.optIn === true;
const isOptedIn = (customer) => hasConsent(customer, 'recovery');

/* ---------- pause switch ---------- */

async function isPaused(store) {
  const doc = await store.collection('counters').findOne({ key: 'recovery-email-paused' });
  return doc ? doc.value !== false : true; // paused until explicitly resumed
}

async function setPaused(store, paused) {
  await store.collection('counters').updateOne({ key: 'recovery-email-paused' }, { $set: { value: Boolean(paused) } }, { upsert: true });
  return Boolean(paused);
}

/* ---------- candidates ---------- */

async function candidates(store, { clock, params }) {
  const nowMs = clock();
  const s = settings(params);
  const lower = iso(nowMs - POLICY_V1.maxInactivityMs);
  const upper = iso(nowMs - POLICY_V1.minInactivityMs);
  const carts = await store.collection('carts').find(
    { status: 'active', customerSub: { $exists: true, $ne: null }, activityAt: { $gte: lower, $lte: upper } },
    { limit: 1000 },
  );
  const out = [];
  const counts = {
    inactiveCarts: carts.length, optedIn: 0, suppressed: 0, notAllowlisted: 0, alreadyEmailed: 0, eligible: 0,
  };
  for (let i = 0; i < carts.length; i += 1) {
    const cart = carts[i];
    /* eslint-disable no-await-in-loop */
    const customer = await store.collection('customers').findOne({ sub: cart.customerSub });
    if (!customer || !isOptedIn(customer) || !customer.email) continue; // eslint-disable-line no-continue
    counts.optedIn += 1;
    if (await store.collection('email_suppressions').findOne({ key: emailKey(customer.email) })) {
      counts.suppressed += 1;
      continue; // eslint-disable-line no-continue
    }
    if (s.allowlistEnabled && !allowlisted(s.allowlist, customer.email)) {
      counts.notAllowlisted += 1;
      continue; // eslint-disable-line no-continue
    }
    const ep = await qualifyingEpisode(store, { customer, cart, nowMs });
    if (!ep.eligible) continue; // eslint-disable-line no-continue
    const ledgerKey = sha256(canonicalJson(['recovery-email', s.campaignId, customer.sub, ep.episodeStart]));
    if (await store.collection('recovery_email_ledger').findOne({ key: ledgerKey })) {
      counts.alreadyEmailed += 1;
      continue; // eslint-disable-line no-continue
    }
    /* eslint-enable no-await-in-loop */
    counts.eligible += 1;
    out.push({
      cart, customer, episodeStart: ep.episodeStart, ledgerKey,
    });
  }
  return { list: out, counts };
}

/* ---------- suppression sync (polling; no webhook required) ---------- */

const BLOCK_REASONS = {
  unsubscribedViaEmail: 'unsubscribed',
  unsubscribedViaApi: 'unsubscribed',
  unsubscribedViaMA: 'unsubscribed',
  hardBounce: 'hard_bounce',
  contactFlaggedAsSpam: 'spam',
  adminBlocked: 'blocked',
};

async function recordSuppression(store, email, reason, { clock }) {
  const key = emailKey(email);
  await store.collection('email_suppressions').insertOne({
    _id: key, key, reason, at: iso(clock()),
  }).catch((e) => { if (!isDuplicateKeyError(e)) throw e; });
  if (reason === 'unsubscribed') {
    // Withdraw-all: every authoritative state change (linkage, then every email purpose) is attempted
    // regardless of the others' failures; evidence failures are reported only afterwards.
    let linkageError = null;
    try {
      await withdrawIdLinkageForEmail(store, email, { clock });
    } catch (e) {
      linkageError = e;
    }
    // An unsubscribe withdraws every marketing purpose. Provider casing may differ from the profile.
    const at = iso(clock());
    const withdrawn = { optIn: false, source: 'brevo-unsubscribe', wordingVersion: null, updatedAt: at };
    const $set = Object.fromEntries(Object.values(CONSENT_PURPOSES).map((d) => [`marketing.${d.field}`, withdrawn]));
    const variants = [...new Set([String(email).trim(), String(email).trim().toLowerCase()])];
    const emailState = await Promise.allSettled(variants.map((e) => store.collection('customers').updateOne({ email: e }, { $set })));
    const emailStateError = emailState.find((r) => r.status === 'rejected')?.reason;
    let emailEvidenceError = null;
    if (!emailStateError) {
      try {
        await Promise.all(Object.keys(CONSENT_PURPOSES).map((purpose) => appendConsentEvent(store, {
          subject: key, subjectKind: 'email', purpose, optIn: false, source: 'brevo-unsubscribe', wordingVersion: null, at,
        })));
      } catch {
        emailEvidenceError = new RecoveryEmailError('EVIDENCE_FAILED', 'Email preference evidence could not be saved.');
      }
    }
    // State failures outrank evidence failures.
    if (linkageError && linkageError.code !== 'EVIDENCE_FAILED') throw linkageError;
    if (emailStateError) throw emailStateError;
    if (linkageError) throw linkageError;
    if (emailEvidenceError) throw emailEvidenceError;
  }
}

/**
 * Pulls Brevo's transactional blocked/unsubscribed contacts into local suppression (idempotent).
 * Throws on provider failure so callers can fail closed.
 */
async function syncSuppressions(store, brevo, { clock = Date.now, maxPages = 10 } = {}) {
  let synced = 0;
  for (let page = 0; page < maxPages; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { contacts } = await brevo.listBlockedContacts({ limit: 100, offset: page * 100 });
    for (let i = 0; i < contacts.length; i += 1) {
      const c = contacts[i];
      if (typeof c?.email === 'string') {
        // eslint-disable-next-line no-await-in-loop
        await recordSuppression(store, c.email, BLOCK_REASONS[c.reason?.code] || 'blocked', { clock });
        synced += 1;
      }
    }
    if (contacts.length < 100) break;
  }
  return synced;
}

/* ---------- operator workflow (aggregate only; no recipient data leaves the service) ---------- */

function createRecoveryEmail({
  store, params = {}, clock = Date.now, brevo = null,
}) {
  const runs = () => store.collection('recovery_email_runs');
  const ledger = () => store.collection('recovery_email_ledger');

  async function offerReady() {
    const id = promotionIdFor(DEFAULT_CAMPAIGN.campaignId);
    const [doc, policy] = await Promise.all([
      store.collection('promotions').findOne({ id, fenced: { $ne: true } }),
      store.collection('recovery_policies').findOne({ promotionId: id }),
    ]);
    return Boolean(doc?.enabled && integrityOk(policy, doc) && readiness(params).ready);
  }

  async function sentToday() {
    const day = iso(clock()).slice(0, 10);
    return ledger().countDocuments({ day, state: { $in: ['sent', 'claimed', 'unknown'] } });
  }

  return {
    /** Aggregate counts for CX Coworker; never recipient identities. */
    async status() {
      const { counts } = await candidates(store, { clock, params });
      const s = settings(params);
      return {
        paused: await isPaused(store),
        allowlistEnabled: s.allowlistEnabled,
        allowlistSize: s.allowlist.size,
        offerReady: await offerReady(),
        templateConfigured: Boolean(s.templateId),
        dailyBudget: s.dailyBudget,
        sentToday: await sentToday(),
        audience: counts,
        policy: { percentOff: POLICY_V1.basisPoints / 100, maxDiscount: POLICY_V1.capMinor / 100, window: '24h-7d', oneEmailPerEpisode: true },
      };
    },

    /** Recent runs for the human approval screen (run metadata only; never recipients). */
    async listRuns({ limit = 20 } = {}) {
      const n = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 50);
      const rows = await runs().find({}, { sort: { requestedAt: -1 }, limit: n });
      return rows.map((r) => ({
        runId: r.runId,
        state: r.state,
        templateId: r.templateId,
        maxRecipients: r.maxRecipients,
        requestedBy: r.requestedBy,
        requestedAt: r.requestedAt,
        expiresAt: Number.isFinite(r.expiresAtMs) ? iso(r.expiresAtMs) : null,
        approvedBy: r.approvedBy || null,
        approvedAt: r.approvedAt || null,
        sent: r.sent || 0,
      }));
    },

    pause: () => setPaused(store, true),
    resume: () => setPaused(store, false),

    /** Operator requests a bounded run; a different human must approve it. */
    async requestRun(ctx, { maxRecipients, templateId }) {
      if (!ctx?.actor?.subject) throw new RecoveryEmailError('UNAUTHORIZED', 'Operator context required.');
      const max = Number(maxRecipients);
      if (!Number.isInteger(max) || max < 1 || max > MAX_RUN_RECIPIENTS) {
        throw new RecoveryEmailError('INVALID', `maxRecipients must be 1 to ${MAX_RUN_RECIPIENTS}.`);
      }
      const s = settings(params);
      const template = String(templateId || s.templateId || '');
      if (!/^\d{1,9}$/.test(template)) throw new RecoveryEmailError('INVALID', 'A Brevo template id is required.');
      const runId = `rer_${crypto.randomBytes(12).toString('hex')}`;
      const nowMs = clock();
      await runs().insertOne({
        _id: runId,
        runId,
        state: 'requested',
        campaignId: s.campaignId,
        policyVersion: POLICY_V1.policyVersion,
        templateId: template,
        maxRecipients: max,
        requestedBy: ctx.actor.subject,
        requestedAt: iso(nowMs),
        expiresAtMs: nowMs + RUN_TTL_MS,
        sent: 0,
      });
      return { runId, state: 'requested', maxRecipients: max, templateId: template, expiresAt: iso(nowMs + RUN_TTL_MS) };
    },

    /**
     * Human approval bound to the exact run (template, size, policy). The requester cannot
     * approve their own run; the approving surface must confirm a human decision.
     */
    async approveRun(ctx, { runId, templateId, maxRecipients }) {
      // A shared integration credential cannot prove a distinct human approver.
      if (ctx?.actor?.kind !== 'ims-operator') {
        throw new RecoveryEmailError('HUMAN_APPROVAL_REQUIRED', 'Run approval requires an individually verified operator.');
      }
      const run = await runs().findOne({ runId });
      if (!run || run.state !== 'requested') throw new RecoveryEmailError('NOT_FOUND', 'Run is not awaiting approval.');
      if (!ctx?.actor?.subject || ctx.actor.subject === run.requestedBy) {
        throw new RecoveryEmailError('SELF_APPROVAL', 'A different person must approve this run.');
      }
      if (String(templateId) !== run.templateId || Number(maxRecipients) !== run.maxRecipients) {
        throw new RecoveryEmailError('APPROVAL_MISMATCH', 'Approval must match the requested template and size.');
      }
      if (clock() >= run.expiresAtMs) throw new RecoveryEmailError('EXPIRED', 'Run request expired.');
      const res = await runs().updateOne({ runId, state: 'requested' }, { $set: { state: 'approved', approvedBy: ctx.actor.subject, approvedAt: iso(clock()) } });
      if ((res?.matchedCount ?? 0) !== 1) throw new RecoveryEmailError('CONFLICT', 'Run changed.');
      return { runId, state: 'approved' };
    },

    /**
     * Executes one approved run (scheduled worker or explicit operator trigger). Rechecks pause,
     * offer readiness, consent, suppression, allowlist, cart state, purchases and budget per
     * recipient. Ambiguous provider outcomes are recorded as `unknown` and never resent.
     */
    async executeRun({ runId }) {
      const run = await runs().findOne({ runId });
      if (!run || run.state !== 'approved') throw new RecoveryEmailError('NOT_APPROVED', 'Run is not approved.');
      if (clock() >= run.expiresAtMs) {
        await runs().updateOne({ runId, state: 'approved' }, { $set: { state: 'expired' } });
        throw new RecoveryEmailError('EXPIRED', 'Run approval expired.');
      }
      if (await isPaused(store)) throw new RecoveryEmailError('PAUSED', 'Recovery email is paused.');
      if (!(await offerReady())) throw new RecoveryEmailError('OFFER_NOT_READY', 'Recovery offer is not enabled and verified.');
      const s = settings(params);
      if (!s.cartUrl) throw new RecoveryEmailError('NOT_CONFIGURED', 'An environment-specific SHOP_CART_URL is required.');
      if (!brevo) throw new RecoveryEmailError('NOT_CONFIGURED', 'Email provider is not configured.');
      // Fail closed: never send without current unsubscribe/bounce state from Brevo.
      try {
        await syncSuppressions(store, brevo, { clock });
      } catch (e) {
        throw new RecoveryEmailError('SUPPRESSION_SYNC_FAILED', 'Could not refresh unsubscribes from Brevo; nothing was sent.');
      }
      const claimed = await runs().updateOne({ runId, state: 'approved' }, { $set: { state: 'running', startedAt: iso(clock()) } });
      if ((claimed?.matchedCount ?? 0) !== 1) throw new RecoveryEmailError('CONFLICT', 'Run is already running.');

      const result = {
        sent: 0, failed: 0, unknown: 0, deferred: 0,
      };
      try {
        const budget = Math.max(0, s.dailyBudget - (await sentToday()));
        const limit = Math.min(run.maxRecipients, budget);
        const { list } = await candidates(store, { clock, params });
        for (let i = 0; i < list.length && result.sent + result.unknown < limit; i += 1) {
          const c = list[i];
          const nowMs = clock();
          /* eslint-disable no-await-in-loop */
          try {
            await ledger().insertOne({
              _id: c.ledgerKey, key: c.ledgerKey, runId, campaignId: run.campaignId, state: 'claimed', day: iso(nowMs).slice(0, 10), claimedAtMs: nowMs,
            });
          } catch (e) {
            if (isDuplicateKeyError(e)) continue; // eslint-disable-line no-continue
            throw e;
          }
          try {
            const { messageId } = await brevo.sendTemplate({
              to: { email: c.customer.email, name: c.customer.firstname || undefined },
              templateId: run.templateId,
              params: {
                FIRSTNAME: c.customer.firstname || '',
                CART_URL: `${s.cartUrl}?utm_source=brevo&utm_medium=email&utm_campaign=${encodeURIComponent(run.campaignId)}`,
                PERCENT_OFF: POLICY_V1.basisPoints / 100,
                MAX_DISCOUNT: POLICY_V1.capMinor / 100,
              },
              tags: [run.campaignId],
            });
            await ledger().updateOne({ key: c.ledgerKey }, { $set: { state: 'sent', messageId, sentAt: iso(clock()) } });
            result.sent += 1;
          } catch (e) {
            if (e.ambiguous) {
              await ledger().updateOne({ key: c.ledgerKey }, { $set: { state: 'unknown' } });
              result.unknown += 1;
            } else if (e.status === 429) {
              await ledger().deleteOne({ key: c.ledgerKey, state: 'claimed' });
              result.deferred += 1;
              break;
            } else {
              await ledger().updateOne({ key: c.ledgerKey }, { $set: { state: 'failed', status: e.status || null } });
              result.failed += 1;
            }
          }
          /* eslint-enable no-await-in-loop */
        }
      } finally {
        await runs().updateOne({ runId }, { $set: { state: 'completed', completedAt: iso(clock()), result } });
      }
      return { runId, ...result };
    },

    /** Marks claims older than the stale window as `unknown` (crash mid-send); never resends. */
    async reconcileStaleClaims() {
      const stale = await ledger().find({ state: 'claimed', claimedAtMs: { $lt: clock() - CLAIM_STALE_MS } }, { limit: 100 });
      await Promise.all(stale.map((l) => ledger().updateOne({ key: l.key, state: 'claimed' }, { $set: { state: 'unknown' } })));
      return stale.length;
    },
  };
}

/**
 * Scheduled executor: runs at most the oldest human-approved run per invocation, and only when
 * a Brevo API key is configured. executeRun keeps every guard (approval, expiry, pause, offer
 * readiness, suppression sync, consent, allowlist, budget, once-per-episode ledger). Returns
 * aggregates only; never recipients.
 */
async function executeNextApprovedRun({
  store, params = {}, clock = Date.now, createClient = createBrevoClient,
}) {
  if (!params.BREVO_API_KEY) return { state: 'not-configured' };
  const [run] = await store.collection('recovery_email_runs').find({ state: 'approved' }, { sort: { approvedAt: 1 }, limit: 1 });
  if (!run) return { state: 'idle' };
  const svc = createRecoveryEmail({
    store, params, clock, brevo: createClient({ apiKey: params.BREVO_API_KEY }),
  });
  try {
    const r = await svc.executeRun({ runId: run.runId });
    return {
      state: 'completed', runId: run.runId, sent: r.sent, failed: r.failed, unknown: r.unknown, deferred: r.deferred,
    };
  } catch (e) {
    if (e instanceof RecoveryEmailError) return { state: 'skipped', runId: run.runId, code: e.code };
    throw e;
  }
}

/* ---------- Brevo webhook (unsubscribe/bounce/complaint suppression) ---------- */

function tokenMatches(expected, provided) {
  if (!expected || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Idempotent suppression from Brevo webhook events. Authenticated with a shared token
 * (`Authorization: Bearer <BREVO_WEBHOOK_TOKEN>`, configured on the Brevo webhook).
 * @returns {{ status: number, suppressed?: boolean }}
 */
async function handleBrevoWebhook(store, { headers = {}, body = {}, params = {} }, { clock = Date.now } = {}) {
  const auth = headers.authorization || headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tokenMatches(params.BREVO_WEBHOOK_TOKEN, token)) return { status: 401 };
  const events = Array.isArray(body) ? body : [body];
  let suppressed = false;
  for (let i = 0; i < Math.min(events.length, 100); i += 1) {
    const ev = events[i] || {};
    const event = String(ev.event || '').toLowerCase();
    if (!SUPPRESS_EVENTS.has(event) || typeof ev.email !== 'string') continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await recordSuppression(store, ev.email, event === 'unsubscribed' ? 'unsubscribed' : event, { clock });
    suppressed = true;
  }
  return { status: 200, suppressed };
}

module.exports = {
  createRecoveryEmail,
  executeNextApprovedRun,
  handleBrevoWebhook,
  syncSuppressions,
  setRecoveryEmailOptIn,
  setMarketingConsent,
  hasConsent,
  isOptedIn,
  CONSENT_PURPOSES,
  isPaused,
  setPaused,
  RecoveryEmailError,
  MAX_RUN_RECIPIENTS,
  allowlisted,
};
