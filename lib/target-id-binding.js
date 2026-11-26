/**
 * Trusted ECID binding provider for the environment-bound Target AAM diagnostic (INERT — reached only from
 * actions/target-diagnostic when every live gate is approved). See docs/TARGET-AAM-DIAGNOSTIC.md,
 * "Binding provider lifecycle".
 *
 * Anonymously acquires and durably retains an ECID before transmitting any declared ID. Issues
 * `{ source:'server-issued', ecid, locationHint, blob, consentGrantId, declaredId? }` for an Auth0-verified
 * shopper using the documented Experience Cloud ID Service direct integration (`dpm.demdex.net/id`,
 * `d_ver=2`). The declared ID is the confirmed alias when approved, otherwise the verified sub, with authenticated
 * state 1. No traits, callbacks, cookies, browser identifiers or caller input. Anything not proven
 * returns `{ source:'unavailable', reason }` with a reason from BINDING_REASONS (never identifiers).
 * `confirm()` re-reads the authoritative consent so callers refuse to send or expose a result after a
 * withdrawal or reconsent: the consent grant ID is the generation token.
 *
 * Injected contracts:
 * - consent.lookup({ shopperKey, sub }) → { state:'granted', grantId } | { state:'withdrawn' } |
 *   { state:'absent' }. Anything else, or a throw, is "unknown": deny and change nothing.
 *   (lib/id-linkage-consent.js)
 * - store, compare-and-set on opaque etags never reused for a key, even after removal
 *   (lib/target-binding-store.js):
 *   get(key) → { etag, record } | null
 *   put(key, record, { ifMatch: etag | null }) → newEtag | null   (null ifMatch = create-if-absent)
 *   remove(key, { ifMatch? }) → boolean                             (no ifMatch = unconditional)
 */
const { sha256 } = require('./promotion-schema');
const { retireOrRemoveBinding } = require('./target-binding-store');

const ID_SERVICE = 'https://dpm.demdex.net/id';
const ORG_ID = /^[0-9A-F]{24}@AdobeOrg$/;
const DPID = /^\d{1,10}$/;
const ECID = /^\d{38}$/;
const PERSON_ALIAS = /^wpa_[0-9a-f]{32}$/;
const GRANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DECIMAL = /^\d{1,10}$/;
// ID Service documents d_blob as "512 bytes or less"; Target's Delivery API accepts up to 1024.
// The provider enforces the issuer's own limit; the Target adapter keeps the Delivery API limit.
const MAX_ISSUED_BLOB_BYTES = 512;
const MAX_TTL_S = 30 * 24 * 3600;
const DEFAULT_TIMEOUT_MS = 2000;
// Anonymous mint leases may lapse and be reclaimed. A lapsed lease with a known MID instead becomes
// non-authorizing retirement work: its linking request may have reached Adobe.
const DEFAULT_LEASE_MS = 10000;
const TIMEOUT_BOUNDS = Object.freeze([250, 10000]);
const LEASE_BOUNDS = Object.freeze([1000, 60000]);

/** Categorized, identifier-free reasons a binding is not issued. */
const BINDING_REASONS = Object.freeze([
  'unconfigured', 'invalid-input', 'store-error', 'foreign-record', 'consent-unknown', 'consent-absent',
  'consent-withdrawn', 'consent-changed', 'issuing-in-progress', 'cas-conflict', 'id-service-error',
  'id-service-unreachable', 'id-service-invalid',
  'retirement-pending', 'lease-insufficient', 'invalid-record-state',
]);
const unavailable = (reason) => ({ source: 'unavailable', reason });

/** Documented wire types only: a JSON integer or a decimal digit string. Booleans/arrays/floats are rejected. */
function wireInt(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : NaN;
  if (typeof v === 'string' && DECIMAL.test(v)) return Number(v);
  return NaN;
}

/** Anonymous acquisition omits sub; linking always supplies the already-persisted ECID. */
function idServiceUrl({
  orgId, dpid, sub, ecid,
}) {
  if (sub && !ECID.test(ecid || '')) throw new Error('Declared ID requires a known ECID');
  const q = [`d_orgid=${encodeURIComponent(orgId)}`, 'd_ver=2'];
  if (ecid) q.push(`d_mid=${ecid}`);
  if (sub) q.push(`d_cid=${encodeURIComponent(`${dpid}\u0001${sub}\u00011`)}`);
  return `${ID_SERVICE}?${q.join('&')}`;
}

/** Validates an ID Service response; returns the binding fields or null. */
function parseIdServiceResponse(body, { expectedEcid } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const ecid = body.d_mid;
  const locationHint = wireInt(body.dcs_region);
  const blob = body.d_blob;
  if (typeof ecid !== 'string' || !ECID.test(ecid) || (expectedEcid && ecid !== expectedEcid)) return null;
  if (!Number.isInteger(locationHint) || locationHint < 1) return null;
  if (typeof blob !== 'string' || !blob || Buffer.byteLength(blob, 'utf8') > MAX_ISSUED_BLOB_BYTES) return null;
  // id_sync_ttl is the re-synchronization interval, never membership expiry.
  const ttl = wireInt(body.id_sync_ttl);
  const ttlS = Number.isInteger(ttl) && ttl > 0 && ttl <= MAX_TTL_S ? ttl : 0;
  return {
    ecid, locationHint, blob, ttlS,
  };
}

/** Normalizes an authoritative consent answer; anything malformed is 'unknown'. */
function consentState(answer) {
  if (answer?.state === 'granted') {
    return typeof answer.grantId === 'string' && GRANT_ID.test(answer.grantId)
      ? { state: 'granted', grantId: answer.grantId } : { state: 'unknown' };
  }
  if (answer?.state === 'withdrawn' || answer?.state === 'absent') return { state: answer.state };
  return { state: 'unknown' };
}

const issued = (r) => ({
  source: 'server-issued',
  ecid: r.ecid,
  locationHint: r.locationHint,
  blob: r.blob,
  consentGrantId: r.consentGrantId,
  ...(r.declaredId !== undefined ? { declaredId: r.declaredId } : {}),
});
const aliasBindingKey = (shopperKey, alias) => sha256(JSON.stringify(['target-person-alias/v1', shopperKey, alias]));
const inBounds = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * @param {object} deps
 * @param {string} deps.orgId IMS org (server config)
 * @param {string} deps.dpid declared-ID data source (registry; e.g. the wkndCustomerId source)
 * @param {{ lookup: Function }} deps.consent authoritative server-side consent (no default)
 * @param {{ get: Function, put: Function, remove: Function }} deps.store CAS binding store (no default)
 */
function createIdServiceBindingProvider({
  orgId, dpid, consent, store, fetchImpl = fetch, now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS, leaseMs = DEFAULT_LEASE_MS,
  personAlias, allowAliasMigration = false,
} = {}) {
  const configured = ORG_ID.test(orgId || '') && DPID.test(dpid || '')
    && typeof consent?.lookup === 'function'
    && ['get', 'put', 'remove'].every((m) => typeof store?.[m] === 'function')
    && inBounds(timeoutMs, TIMEOUT_BOUNDS) && inBounds(leaseMs, LEASE_BOUNDS) && leaseMs >= 2 * timeoutMs;

  async function lookupConsent(shopperKey, sub) {
    try {
      return consentState(await consent.lookup({ shopperKey, sub }));
    } catch {
      return { state: 'unknown' };
    }
  }
  const validInput = (shopperKey, sub) => typeof shopperKey === 'string' && Boolean(shopperKey)
    && typeof sub === 'string' && Boolean(sub.trim()) && sub.length <= 256;

  /** Local containment only: retain known IDs pending retirement, never claim upstream deletion. */
  async function invalidate(shopperKey, sub) {
    if (!configured || typeof shopperKey !== 'string' || !shopperKey) return false;
    try {
      let key = shopperKey;
      if (personAlias) {
        if (!validInput(shopperKey, sub)) return false;
        const alias = await personAlias.resolve({ sub, create: false });
        if (!alias.binding || !await personAlias.confirm({ sub, binding: alias.binding })) return false;
        const scoped = aliasBindingKey(shopperKey, alias.binding.personAlias);
        if (await store.get(scoped)) key = scoped;
      }
      return await retireOrRemoveBinding(store, key, await store.get(key));
    } catch {
      return false;
    }
  }

  /**
   * True only while consent is still granted under the same grant the binding was issued for.
   * Call immediately before sending and again before exposing any downstream result.
   */
  async function confirm({ shopperKey, sub, binding } = {}) {
    if (!configured || !validInput(shopperKey, sub) || typeof binding?.consentGrantId !== 'string') return false;
    const c = await lookupConsent(shopperKey, sub);
    if (c.state !== 'granted' || c.grantId !== binding.consentGrantId) return false;
    try {
      let key = shopperKey;
      if (personAlias) {
        const alias = await personAlias.resolve({ sub, create: false });
        if (!alias.binding || alias.binding.personAlias !== binding.declaredId
          || !await personAlias.confirm({ sub, binding: alias.binding })) return false;
        const scoped = aliasBindingKey(shopperKey, binding.declaredId);
        if (await store.get(scoped)) key = scoped;
      }
      const current = await store.get(key);
      const record = current?.record;
      return record?.state === 'bound' && record.shopperKey === shopperKey
        && record.consentGrantId === binding.consentGrantId && record.ecid === binding.ecid
        && (!personAlias || record.declaredId === binding.declaredId)
        && (!record.orgId || record.orgId === orgId) && (!record.dpid || record.dpid === dpid);
    } catch {
      return false;
    }
  }

  async function resolve({ shopperKey, sub } = {}) {
    if (!configured) return unavailable('unconfigured');
    if (!validInput(shopperKey, sub)) return unavailable('invalid-input');
    let cur;
    let storageKey = shopperKey;
    try {
      cur = await store.get(shopperKey);
    } catch {
      return unavailable('store-error');
    }
    let rec = cur?.record;
    // A record must belong to this shopper; anything else is never reused, sent or overwritten.
    if (rec && (rec.shopperKey !== shopperKey
      || (rec.orgId && rec.orgId !== orgId) || (rec.dpid && rec.dpid !== dpid))) return unavailable('foreign-record');
    if (rec && !['issuing', 'bound', 'retiring'].includes(rec.state)) return unavailable('invalid-record-state');

    const pre = await lookupConsent(shopperKey, sub);
    if (pre.state === 'unknown') return unavailable('consent-unknown');
    if (pre.state !== 'granted') {
      if (cur) await retireOrRemoveBinding(store, shopperKey, cur).catch(() => false);
      return unavailable(pre.state === 'withdrawn' ? 'consent-withdrawn' : 'consent-absent');
    }
    let sameGrant = rec?.consentGrantId === pre.grantId;
    let declaredId = sub;
    let aliasBinding;
    if (personAlias) {
      const result = await personAlias.resolve({ sub, create: false });
      if (!result.binding || !PERSON_ALIAS.test(result.binding.personAlias || '')
        || result.binding.consentGeneration !== pre.grantId
        || !await personAlias.confirm({ sub, binding: result.binding })) {
        return unavailable('consent-unknown');
      }
      aliasBinding = result.binding;
      declaredId = result.binding.personAlias;
      if (rec && rec.declaredId !== declaredId) {
        // Only a same-grant legacy identity transition may start a separate alias binding.
        // The old MID remains untouched and non-authorizing; ambiguous issuance/withdrawal may not migrate.
        const migratable = allowAliasMigration && sameGrant && rec.state === 'retiring'
          && rec.retirement?.state === 'pending' && rec.retirement.reason === 'identity-mapping-changed'
          && !rec.retirement.submission && !rec.retirement.observation
          && rec.subject === sha256(sub) && rec.orgId === orgId && rec.dpid === dpid
          && rec.ecidSource === 'server-issued' && ECID.test(rec.ecid || '')
          && (rec.declaredId === undefined || rec.declaredId === sub);
        if (!migratable) {
          await retireOrRemoveBinding(store, shopperKey, cur, { reason: 'identity-mapping-changed' });
          return unavailable('retirement-pending');
        }
      }
      if (!rec || rec.declaredId !== declaredId) {
        storageKey = aliasBindingKey(shopperKey, declaredId);
        cur = await store.get(storageKey);
        rec = cur?.record;
        if (rec && (rec.shopperKey !== shopperKey || rec.subject !== sha256(sub)
          || rec.orgId !== orgId || rec.dpid !== dpid || rec.declaredId !== declaredId)) {
          return unavailable('foreign-record');
        }
        if (rec && !['issuing', 'bound', 'retiring'].includes(rec.state)) return unavailable('invalid-record-state');
        sameGrant = rec?.consentGrantId === pre.grantId;
      }
    }
    const t = now();
    if (rec?.state === 'retiring') return unavailable('retirement-pending');
    // Old issuing records without an explicit anonymous phase may already have transmitted a
    // declared ID. An unknown MID cannot be invented or silently discarded.
    if (rec && ((rec.state === 'issuing' && !ECID.test(rec.priorEcid || '')
      && (rec.phase !== 'minting' || rec.priorEcid !== null))
      || (rec.state === 'bound' && !ECID.test(rec.ecid || '')))) {
      await retireOrRemoveBinding(store, storageKey, cur, { reason: 'identity-unknown' }).catch(() => false);
      return unavailable('retirement-pending');
    }
    if (rec && ((!sameGrant && (ECID.test(rec.ecid || '') || ECID.test(rec.priorEcid || '')))
      || (rec.state === 'issuing' && t >= rec.leaseUntil && ECID.test(rec.priorEcid || '')))) {
      await retireOrRemoveBinding(store, storageKey, cur, { reason: 'issuance-uncertain' }).catch(() => false);
      return unavailable('retirement-pending');
    }
    if (rec?.state === 'bound' && sameGrant && ECID.test(rec.ecid || '') && t < rec.resyncAt) return issued(rec);
    if (rec?.state === 'issuing' && t < rec.leaseUntil) return unavailable('issuing-in-progress');

    // Continuity only within the same shopper and the same consent grant; a new grant mints afresh.
    let priorEcid = null;
    let ecidSource = rec?.ecidSource;
    let regionHints = { ...rec?.regionHints };
    if (rec?.state === 'bound' && Number.isSafeInteger(rec.locationHint) && rec.locationHint > 0) {
      regionHints.lastBound = rec.locationHint;
    }
    if (sameGrant && rec?.state === 'bound' && ECID.test(rec.ecid || '')) priorEcid = rec.ecid;
    if (sameGrant && rec?.state === 'issuing' && ECID.test(rec.priorEcid || '')) priorEcid = rec.priorEcid;

    const subject = sha256(sub);
    let claim;
    try {
      claim = await store.put(storageKey, {
        state: 'issuing', shopperKey, subject, orgId, dpid,
        ...(personAlias ? { declaredId } : {}),
        phase: priorEcid ? 'linking' : 'minting',
        ...(ecidSource ? { ecidSource } : {}),
        regionHints,
        consentGrantId: pre.grantId, priorEcid, leaseUntil: t + leaseMs,
      }, { ifMatch: cur?.etag ?? null });
    } catch {
      return unavailable('store-error');
    }
    if (!claim) return unavailable('cas-conflict');

    // Check after claiming. Withdrawal removes anonymous claims or retires known IDs, changing the
    // etag in either case so a late holder cannot authorize a binding.
    const post = await lookupConsent(shopperKey, sub);
    if (post.state !== 'granted' || post.grantId !== pre.grantId) {
      if (post.state === 'withdrawn' || post.state === 'absent') {
        const current = await store.get(storageKey).catch(() => null);
        if (current?.etag === claim) await retireOrRemoveBinding(store, storageKey, current).catch(() => false);
      }
      return unavailable(post.state === 'unknown' ? 'consent-unknown' : 'consent-changed');
    }

    async function request(ecid, declaredSub) {
      let res;
      try {
        res = await fetchImpl(idServiceUrl({
          orgId, dpid, sub: declaredSub, ecid,
        }), {
          method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { reason: 'id-service-unreachable' };
      }
      if (!res.ok) return { reason: 'id-service-error' };
      try {
        const parsed = parseIdServiceResponse(await res.json(), { expectedEcid: ecid });
        return parsed ? { parsed } : { reason: 'id-service-invalid' };
      } catch {
        return { reason: 'id-service-invalid' };
      }
    }

    // Anonymous acquisition cannot create a declared-ID link. Persist its MID under our CAS lease
    // BEFORE any declared-ID transmission, including the cold-start/lost-response path.
    if (!priorEcid) {
      const mint = await request(undefined, undefined);
      if (mint.reason) return unavailable(mint.reason);
      priorEcid = mint.parsed.ecid;
      ecidSource = 'server-issued';
      regionHints = { ...regionHints, anonymousMint: mint.parsed.locationHint };
      try {
        claim = await store.put(storageKey, {
          state: 'issuing', shopperKey, subject, orgId, dpid,
          ...(personAlias ? { declaredId } : {}),
          phase: 'linking',
          ecidSource,
          regionHints,
          consentGrantId: pre.grantId, priorEcid, leaseUntil: t + leaseMs,
        }, { ifMatch: claim });
      } catch {
        return unavailable('store-error');
      }
      if (!claim) return unavailable('cas-conflict');
    }

    const beforeLink = await lookupConsent(shopperKey, sub);
    if (beforeLink.state !== 'granted' || beforeLink.grantId !== pre.grantId) {
      const current = await store.get(storageKey).catch(() => null);
      if (current?.etag === claim) {
        await retireOrRemoveBinding(store, storageKey, current, { reason: 'consent-changed' }).catch(() => false);
      }
      return unavailable(beforeLink.state === 'unknown' ? 'consent-unknown' : 'consent-changed');
    }
    // The consent lookup may have outlived our lease or another holder may have retired it. Read
    // ownership after that await; leave a full request-timeout budget before transmitting a CID.
    let owner;
    try {
      owner = await store.get(storageKey);
    } catch {
      return unavailable('store-error');
    }
    if (owner?.record?.state === 'retiring') return unavailable('retirement-pending');
    if (owner?.etag !== claim) return unavailable('cas-conflict');
    if (owner.record?.state !== 'issuing') return unavailable('invalid-record-state');
    if (owner.record.phase !== 'linking' || owner.record.shopperKey !== shopperKey
      || owner.record.consentGrantId !== pre.grantId || owner.record.priorEcid !== priorEcid
      || owner.record.orgId !== orgId || owner.record.dpid !== dpid) return unavailable('cas-conflict');
    if (!Number.isSafeInteger(owner.record.leaseUntil) || owner.record.leaseUntil - now() <= timeoutMs) {
      await retireOrRemoveBinding(store, storageKey, owner, { reason: 'lease-insufficient' }).catch(() => false);
      return unavailable('lease-insufficient');
    }
    if (personAlias && !await personAlias.confirm({ sub, binding: aliasBinding })) return unavailable('consent-changed');
    const response = await request(priorEcid, declaredId);
    if (response.reason) {
      const current = await store.get(storageKey).catch(() => null);
      if (current?.etag === claim) {
        await retireOrRemoveBinding(store, storageKey, current, { reason: 'issuance-uncertain' }).catch(() => false);
      }
      return unavailable(response.reason);
    }
    const { parsed } = response;
    const record = {
      state: 'bound',
      shopperKey,
      subject,
      orgId,
      dpid,
      ...(personAlias ? { declaredId } : {}),
      ...(ecidSource ? { ecidSource } : {}),
      regionHints: { ...regionHints, lastBound: parsed.locationHint },
      consentGrantId: pre.grantId,
      ecid: parsed.ecid,
      locationHint: parsed.locationHint,
      blob: parsed.blob,
      issuedAt: t,
      resyncAt: t + parsed.ttlS * 1000,
    };
    let written;
    try {
      written = await store.put(storageKey, record, { ifMatch: claim });
    } catch {
      return unavailable('store-error');
    }
    return written ? issued(record) : unavailable('cas-conflict');
  }

  return {
    configured, resolve, confirm, invalidate,
  };
}

module.exports = {
  ID_SERVICE,
  MAX_ISSUED_BLOB_BYTES,
  DEFAULT_LEASE_MS,
  DEFAULT_TIMEOUT_MS,
  TIMEOUT_BOUNDS,
  LEASE_BOUNDS,
  BINDING_REASONS,
  idServiceUrl,
  parseIdServiceResponse,
  consentState,
  createIdServiceBindingProvider,
};
