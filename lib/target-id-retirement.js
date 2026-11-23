/**
 * Owned, device-only AAM retirement. OFF by default. HTTP submission and scoped DCS code-171
 * observation are separate facts; neither releases the retained ID or proves unsegmentation/deletion.
 * Partner metadata was independently verified from selected-company metadata and container 9133.
 */
const crypto = require('node:crypto');
const { sha256 } = require('./promotion-schema');
const { DEFAULT_TIMEOUT_MS, DEFAULT_LEASE_MS, TIMEOUT_BOUNDS, LEASE_BOUNDS } = require('./target-id-binding');

const PARTNER = Object.freeze({
  host: 'ags050.demdex.net', partnerId: '8455', orgId: '28260E2056581D3B7F000101@AdobeOrg',
});
const ECID = /^\d{38}$/;
const DPID = /^\d{1,10}$/;
const inBounds = (n, [lo, hi]) => Number.isInteger(n) && n >= lo && n <= hi;
const regionOf = (v) => {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const safe = (fields) => ({
  status: 'pending', coverage: 'incomplete', evidence: false, financialAuthorization: false,
  historicalDeletion: false, unsegmentationVerified: false, ...fields,
});
const summary = (r, reason) => safe({
  submission: ['sending', 'submitted', 'unknown'].includes(r?.submission?.state) ? r.submission.state : 'not-submitted',
  observation: ['sending', 'opt-out-observed', 'unknown', 'unobserved'].includes(r?.observation?.state) ? r.observation.state : 'not-observed',
  regionalObservation: r?.observation?.state === 'opt-out-observed' && regionOf(r.observation.region) !== null,
  ...(reason ? { reason } : {}),
});

/** Only documented numeric error codes; conflicting/invalid responses never prove opt-out. */
async function observationOf(res) {
  if (!res.ok) return { state: 'unknown', region: null };
  let body;
  try { body = await res.json(); } catch { body = null; }
  const header = res.headers?.get?.('x-error');
  if (header && !/^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(header)) return { state: 'unknown', region: null };
  const codes = header ? header.split(',').map((n) => Number(n.trim())) : [];
  const object = body && typeof body === 'object' && !Array.isArray(body);
  if (object && body.errors !== undefined) {
    if (!Array.isArray(body.errors) || body.errors.some((e) => !Number.isInteger(e?.code))) {
      return { state: 'unknown', region: null };
    }
    codes.push(...body.errors.map((e) => e.code));
  }
  if (codes.length && codes.every((code) => code === 171)) {
    return { state: 'opt-out-observed', code: 171, region: regionOf(body?.dcs_region) };
  }
  return { state: codes.length || !object ? 'unknown' : 'unobserved', region: regionOf(body?.dcs_region) };
}

function createIdRetirementService({
  enabled = false, orgId, dpid, environment, namespace, consent, store, fetchImpl = fetch,
  now = Date.now, randomUUID = crypto.randomUUID,
  timeoutMs = DEFAULT_TIMEOUT_MS, leaseMs = DEFAULT_LEASE_MS,
} = {}) {
  const configured = enabled === true && orgId === PARTNER.orgId && DPID.test(dpid || '')
    && ['stage', 'production'].includes(environment) && typeof namespace === 'string' && Boolean(namespace)
    && typeof consent?.lookup === 'function' && ['get', 'put'].every((m) => typeof store?.[m] === 'function')
    && inBounds(timeoutMs, TIMEOUT_BOUNDS) && inBounds(leaseMs, LEASE_BOUNDS) && leaseMs >= 2 * timeoutMs;
  const scope = { ...PARTNER, environment, namespace, dpid };
  const scoped = (attempt, ecid) => attempt?.ecid === ecid
    && Object.keys(scope).every((key) => attempt?.scope?.[key] === scope[key]);

  async function run({ shopperKey, sub, step } = {}) {
    if (!configured) return safe({ status: 'unavailable', reason: enabled ? 'unconfigured' : 'disabled' });
    if (!['submit', 'observe'].includes(step) || typeof shopperKey !== 'string' || !shopperKey
      || typeof sub !== 'string' || !sub.trim()) return safe({ status: 'unavailable', reason: 'invalid-input' });
    try {
      const purpose = await consent.lookup({ shopperKey, sub });
      if (purpose?.state === 'absent') return safe({ reason: 'consent-absent' });
      if (!['withdrawn', 'granted'].includes(purpose?.state)) return safe({ reason: 'consent-unknown' });
      const current = await store.get(shopperKey);
      if (!current) return safe({ reason: 'no-retirement' });
      const record = current.record;
      if (record?.state !== 'retiring') return safe({ reason: 'not-retiring' });
      if (record.shopperKey !== shopperKey || record.subject !== sha256(sub)
        || record.orgId !== orgId || record.dpid !== dpid) return safe({ reason: 'foreign-record' });
      if (record.ecidSource !== 'server-issued' || !ECID.test(record.ecid || '')
        || (record.priorEcid && record.priorEcid !== record.ecid)
        || typeof record.consentGrantId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(record.consentGrantId)
        || record.retirement?.state !== 'pending') {
        return safe({ reason: 'unverified-record' });
      }
      const retirement = record.retirement || { state: 'pending' };
      const field = step === 'submit' ? 'submission' : 'observation';
      const prior = retirement[field];
      if (['submission', 'observation'].some((key) => retirement[key] && !scoped(retirement[key], record.ecid))) {
        return safe({ reason: 'unscoped-attempt', submission: 'unknown', observation: 'unknown', regionalObservation: false });
      }
      // A crashed/expired sender has an unknown outcome. Do not automatically resubmit.
      const activeField = ['submission', 'observation'].find((key) => retirement[key]?.state === 'sending');
      if (activeField) {
        const active = retirement[activeField];
        if (!scoped(active, record.ecid)) return summary(retirement, 'unscoped-attempt');
        if (!Number.isSafeInteger(active.leaseUntil) || now() >= active.leaseUntil) {
          const next = { ...retirement, [activeField]: { ...active, state: 'unknown' } };
          const saved = await store.put(shopperKey, { ...record, retirement: next }, { ifMatch: current.etag });
          return summary(saved ? next : retirement, saved ? 'outcome-unknown' : 'cas-conflict');
        }
        return summary(retirement, 'in-progress');
      }
      if (step === 'submit' && prior) return summary(retirement, prior.state === 'unknown' ? 'outcome-unknown' : undefined);
      if (step === 'observe') {
        const submission = retirement.submission;
        if (!['submitted', 'unknown'].includes(submission?.state) || !scoped(submission, record.ecid)) {
          return summary(retirement, 'submission-required');
        }
        if (prior?.state === 'opt-out-observed') return summary(retirement);
      }
      const at = now();
      const attempt = {
        state: 'sending', attemptId: randomUUID(), startedAt: new Date(at).toISOString(),
        leaseUntil: at + leaseMs, ecid: record.ecid, scope,
      };
      const claimed = { ...record, retirement: { ...retirement, state: 'pending', [field]: attempt } };
      const etag = await store.put(shopperKey, claimed, { ifMatch: current.etag });
      if (!etag) return summary(retirement, 'cas-conflict');
      const owner = await store.get(shopperKey);
      if (owner?.etag !== etag || owner.record?.state !== 'retiring'
        || owner.record.ecid !== record.ecid || attempt.leaseUntil - now() <= timeoutMs) {
        return summary(claimed.retirement, 'ownership-unavailable');
      }
      const url = new URL(`https://${PARTNER.host}/${step === 'submit' ? 'demoptout.jpg' : 'event'}`);
      url.searchParams.set('d_mid', record.ecid);
      url.searchParams.set('d_orgid', orgId);
      if (step === 'observe') url.searchParams.set('d_rtbd', 'json');
      let result;
      try {
        const res = await fetchImpl(url.href, {
          method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
        });
        result = step === 'submit'
          ? { state: res.ok ? 'submitted' : 'unknown', httpStatus: Number.isInteger(res.status) ? res.status : null }
          : await observationOf(res);
      } catch {
        result = { state: 'unknown' };
      }
      const next = {
        ...claimed.retirement,
        [field]: { ...attempt, ...result, completedAt: new Date(now()).toISOString() },
      };
      const saved = await store.put(shopperKey, { ...claimed, retirement: next }, { ifMatch: etag });
      return summary(saved ? next : claimed.retirement, saved ? undefined : 'cas-conflict');
    } catch {
      return safe({ status: 'unavailable', reason: 'store-or-consent-unavailable' });
    }
  }
  return { configured, run };
}

module.exports = { PARTNER, createIdRetirementService };
