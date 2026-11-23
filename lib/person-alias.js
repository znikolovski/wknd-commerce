const crypto = require('node:crypto');
const { sha256 } = require('./promotion-schema');
const { shopperKey } = require('./recovery-policy');
const { createBindingStore } = require('./target-binding-store');
const { createIdLinkageConsentSource } = require('./id-linkage-consent');

const API_VERSION = 'wknd.person-binding/v1';
const ORG_ID = '28260E2056581D3B7F000101@AdobeOrg';
const DPID = '1547309';
const TTL_MS = 5 * 60 * 1000;
const ALIAS = /^wpa_[0-9a-f]{32}$/;

function createPersonAliasSource(store, config, { now = Date.now } = {}) {
  const aliases = createBindingStore(store, { collection: 'person_aliases_v1' });
  const consent = createIdLinkageConsentSource(store, { issuer: config.AUTH0_ISSUER });
  const configured = config.TARGET_PERSON_ALIAS_APPROVED === 'true'
    && config.TARGET_ID_LINKAGE_ENABLED === 'true'
    && config.TARGET_ID_BINDING_STORE_APPROVED === 'true'
    && config.TARGET_ID_ORG_ID === ORG_ID && config.TARGET_ID_DPID === DPID;
  const scope = {
    environment: config.TARGET_DIAG_ENVIRONMENT,
    runtimeNamespace: config.__OW_NAMESPACE,
    orgId: ORG_ID,
    dpid: DPID,
    namespace: 'wkndCustomerId',
    issuer: `https://${config.__OW_NAMESPACE}.adobeioruntime.net/api/v1/web/commerce/target-diagnostic`,
  };
  const keyFor = (sub) => sha256(JSON.stringify([scope, config.AUTH0_ISSUER, shopperKey(config.AUTH0_ISSUER, sub)]));

  async function resolve({ sub, create = true } = {}) {
    if (!configured) return { status: 'unavailable', reason: 'alias-not-approved', binding: null };
    const key = shopperKey(config.AUTH0_ISSUER, sub);
    const before = await consent.lookup({ shopperKey: key, sub });
    if (before.state !== 'granted') {
      return {
        status: before.state === 'unknown' ? 'unavailable' : 'ok',
        consent: before.state,
        reason: before.state === 'unknown' ? 'consent-unknown' : null,
        binding: null,
      };
    }
    const aliasKey = keyFor(sub);
    let current = await aliases.get(aliasKey);
    if (!current && !create) {
      return { status: 'unavailable', consent: 'granted', reason: 'alias-not-issued', binding: null };
    }
    if (!current) {
      const record = { ...scope, alias: `wpa_${crypto.randomUUID().replace(/-/g, '')}` };
      await aliases.put(aliasKey, record, { ifMatch: null });
      current = await aliases.get(aliasKey);
    }
    const record = current?.record;
    if (!record || !ALIAS.test(record.alias)
      || Object.entries(scope).some(([k, v]) => record[k] !== v)) {
      throw new Error('Invalid person alias mapping');
    }
    const after = await consent.lookup({ shopperKey: key, sub });
    if (after.state !== 'granted' || after.grantId !== before.grantId) {
      return { status: 'unavailable', reason: 'consent-changed', binding: null };
    }
    const issuedAt = now();
    return {
      status: 'ok',
      consent: 'granted',
      binding: {
        source: 'server-issued', personAlias: record.alias, ...scope,
        consentGeneration: after.grantId,
        issuedAt: new Date(issuedAt).toISOString(),
        expiresAt: new Date(issuedAt + TTL_MS).toISOString(),
        freshnessMs: TTL_MS,
      },
    };
  }

  async function confirm({ sub, binding } = {}) {
    if (!configured || !binding || binding.source !== 'server-issued'
      || !ALIAS.test(binding.personAlias || '')
      || Object.entries(scope).some(([k, v]) => binding[k] !== v)) return false;
    const issuedAt = Date.parse(binding.issuedAt);
    const expiresAt = Date.parse(binding.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
      || issuedAt > now() || expiresAt !== issuedAt + TTL_MS || now() >= expiresAt
      || binding.freshnessMs !== TTL_MS) return false;
    const c = await consent.lookup({ shopperKey: shopperKey(config.AUTH0_ISSUER, sub), sub });
    if (c.state !== 'granted' || c.grantId !== binding.consentGeneration) return false;
    return (await aliases.get(keyFor(sub)))?.record?.alias === binding.personAlias;
  }
  return { configured, resolve, confirm };
}

module.exports = {
  API_VERSION, ORG_ID, DPID, TTL_MS, createPersonAliasSource,
};
