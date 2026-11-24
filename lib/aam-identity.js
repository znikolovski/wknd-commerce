const { createBindingStore } = require('./target-binding-store');
const { sourceConfig, hash, AamError } = require('./aam-outbound');
const { IDENTITIES } = require('./aam-membership');
const { DPID } = require('./person-alias');

async function registerDestinationIdentity({ store, params, person, sub, binding, delegated, now }) {
  if (params.AAM_IDENTITY_REGISTRATION_ENABLED !== 'true' || delegated || !binding) return;
  if (params.AAM_CONFIG_VERIFIED !== 'true' || params.AAM_IDENTITY_FORMAT !== 'person-alias') {
    throw new AamError('IDENTITY_REGISTRATION_CONFIG_INVALID', 503);
  }
  const config = sourceConfig(params, params.__OW_NAMESPACE);
  if (String(config.scope.dpid) !== DPID || config.scope.environment !== binding.environment
    || !await person.confirm({ sub, binding })) throw new AamError('IDENTITY_REGISTRATION_REJECTED', 503);
  const identityKey = hash(JSON.stringify([config.scopeKey, binding.personAlias]));
  const identities = createBindingStore(store, { collection: IDENTITIES });
  const before = await identities.get(identityKey);
  const registration = {
    identityKey, scopeKey: config.scopeKey, source: 'server-person-alias-v1', customerSub: sub,
    personAlias: binding.personAlias, auth0Issuer: params.AUTH0_ISSUER,
    consentGeneration: binding.consentGeneration, verifiedAt: now(), expiresAt: now() + config.ttlMs,
  };
  if (before && before.record.customerSub !== sub) throw new AamError('IDENTITY_REGISTRATION_CONFLICT', 503);
  if (!await identities.put(identityKey, registration, { ifMatch: before?.etag ?? null })) {
    throw new AamError('IDENTITY_REGISTRATION_CONFLICT', 503);
  }
  if (!await person.confirm({ sub, binding })) throw new AamError('IDENTITY_REGISTRATION_REJECTED', 503);
}

module.exports = { registerDestinationIdentity };
