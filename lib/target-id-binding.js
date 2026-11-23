/**
 * Trusted ECID binding provider for the Stage-only Target AAM diagnostic (OFFLINE DESIGN — not wired
 * to any action, store collection, manifest or deployment). See docs/TARGET-AAM-DIAGNOSTIC.md.
 *
 * Issues `{ source:'server-issued', ecid, locationHint, blob }` for an Auth0-verified shopper using the
 * documented Experience Cloud ID Service direct integration (`dpm.demdex.net/id`, `d_ver=2`). The only
 * declared ID sent is the verified `sub` under the registry DPID with authenticated state 1. No traits,
 * callbacks, browser identifiers or caller input. Anything not proven returns `null` (unavailable).
 *
 * Lifecycle (all server-side, keyed by `shopperKey(AUTH0_ISSUER, sub)`):
 * - Consent: `consent.allowed(shopperKey)` must return exactly `true` before every resolve; otherwise the
 *   stored binding is invalidated and nothing is issued. There is no default consent source.
 * - Persistence: a binding store is REQUIRED (minting a fresh ECID per call would churn device profiles
 *   linked to the shopper). Store writes are conditional on the previously read revision.
 * - Resync: a stored binding is reused until `resyncAt`, derived from `id_sync_ttl` (the documented
 *   re-synchronization interval — NOT membership expiry). On resync the stored ECID is sent as `d_mid`
 *   so the shopper keeps one ECID. A missing/invalid TTL means "do not reuse".
 * - Account switch: bindings are per shopper key; another shopper never reads this binding.
 * - Logout: the binding is server-held and never sent to a browser, so logout needs no device action;
 *   the next call simply requires a verified sub again.
 * - Withdrawal: consent `false` (or `invalidate()`) deletes the binding; no automatic reinstatement
 *   until consent is `true` again, when a new resolve re-issues.
 */
const ID_SERVICE = 'https://dpm.demdex.net/id';
const ORG_ID = /^[0-9A-F]{24}@AdobeOrg$/;
const DPID = /^\d{1,10}$/;
const ECID = /^\d{38}$/;
// ID Service documents d_blob as "512 bytes or less"; Target's Delivery API accepts up to 1024.
// The provider enforces the issuer's own limit; the Target adapter keeps the Delivery API limit.
const MAX_ISSUED_BLOB_BYTES = 512;
const MAX_TTL_S = 30 * 24 * 3600;
const DEFAULT_TIMEOUT_MS = 2000;

/** Builds the ID Service request URL. Only org, version, optional stored ECID and the declared ID. */
function idServiceUrl({ orgId, dpid, sub, ecid }) {
  const q = [`d_orgid=${encodeURIComponent(orgId)}`, 'd_ver=2'];
  if (ecid) q.push(`d_mid=${ecid}`);
  q.push(`d_cid=${encodeURIComponent(`${dpid}\u0001${sub}\u00011`)}`);
  return `${ID_SERVICE}?${q.join('&')}`;
}

/** Validates an ID Service response; returns the binding fields or null. */
function parseIdServiceResponse(body, { expectedEcid } = {}) {
  if (!body || typeof body !== 'object') return null;
  const ecid = String(body.d_mid ?? '');
  const locationHint = Number(body.dcs_region);
  const blob = body.d_blob;
  if (!ECID.test(ecid) || (expectedEcid && ecid !== expectedEcid)) return null;
  if (!Number.isInteger(locationHint) || locationHint < 1) return null;
  if (typeof blob !== 'string' || !blob || Buffer.byteLength(blob, 'utf8') > MAX_ISSUED_BLOB_BYTES) return null;
  const ttl = Number(body.id_sync_ttl);
  const ttlS = Number.isInteger(ttl) && ttl > 0 && ttl <= MAX_TTL_S ? ttl : 0;
  return {
    ecid, locationHint, blob, ttlS,
  };
}

/**
 * @param {object} deps
 * @param {string} deps.orgId IMS org (server config)
 * @param {string} deps.dpid declared-ID data source (registry; e.g. the wkndCustomerId source)
 * @param {{ allowed: (shopperKey: string) => Promise<boolean> }} deps.consent server-side consent
 * @param {{ get, put, remove }} deps.store binding store (approval required before any real store)
 */
function createIdServiceBindingProvider({
  orgId, dpid, consent, store, fetchImpl = fetch, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const configured = ORG_ID.test(orgId || '') && DPID.test(dpid || '')
    && typeof consent?.allowed === 'function'
    && ['get', 'put', 'remove'].every((m) => typeof store?.[m] === 'function');

  async function invalidate(shopperKey) {
    if (configured) await store.remove(shopperKey).catch(() => {});
  }

  async function resolve({ shopperKey, sub } = {}) {
    if (!configured || typeof shopperKey !== 'string' || !shopperKey
      || typeof sub !== 'string' || !sub.trim() || sub.length > 256) return null;
    let allowed = false;
    try {
      allowed = (await consent.allowed(shopperKey)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      await invalidate(shopperKey);
      return null;
    }
    const stored = await store.get(shopperKey).catch(() => null);
    const t = now();
    if (stored && ECID.test(stored.ecid || '') && t < stored.resyncAt) {
      return {
        source: 'server-issued', ecid: stored.ecid, locationHint: stored.locationHint, blob: stored.blob,
      };
    }
    let parsed;
    try {
      const res = await fetchImpl(idServiceUrl({
        orgId, dpid, sub, ecid: stored?.ecid && ECID.test(stored.ecid) ? stored.ecid : undefined,
      }), {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      parsed = parseIdServiceResponse(await res.json(), {
        expectedEcid: stored?.ecid && ECID.test(stored.ecid) ? stored.ecid : undefined,
      });
    } catch {
      return null;
    }
    if (!parsed) return null;
    const record = {
      ecid: parsed.ecid,
      locationHint: parsed.locationHint,
      blob: parsed.blob,
      issuedAt: t,
      resyncAt: t + parsed.ttlS * 1000,
    };
    const written = await store.put(shopperKey, record, { expectedRevision: stored?.revision ?? null })
      .catch(() => false);
    if (!written) return null;
    return {
      source: 'server-issued', ecid: record.ecid, locationHint: record.locationHint, blob: record.blob,
    };
  }

  return { configured, resolve, invalidate };
}

module.exports = {
  ID_SERVICE,
  MAX_ISSUED_BLOB_BYTES,
  idServiceUrl,
  parseIdServiceResponse,
  createIdServiceBindingProvider,
};
