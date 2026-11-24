const { shopperKey } = require('../../lib/recovery-policy');

const SUB = 'auth0|offline-demo-activation';
const ISSUER = 'https://example.auth0.com/';
const NS = '28538-wkndcommerce';
const GRANT = '11111111-2222-4333-8444-555555555555';
const params = {
  AUTH0_ISSUER: ISSUER, AUTH0_AUDIENCE: 'offline',
  TARGET_DIAG_ENABLED: 'true', TARGET_DIAG_ENVIRONMENT: 'production',
  TARGET_DIAG_STAGE_NAMESPACE: '28538-wkndcommerce-stage', TARGET_DIAG_PRODUCTION_NAMESPACE: NS,
  TARGET_DIAG_TARGET_CONFIG_APPROVED: 'true', TARGET_DIAG_SHOPPER_KEYS: shopperKey(ISSUER, SUB),
  TARGET_CLIENT_CODE: 'exampleclient', TARGET_PROPERTY_TOKEN: GRANT,
  TARGET_ID_LINKAGE_ENABLED: 'true', TARGET_ID_LINKAGE_WORDING_VERSIONS: 'approved-v1',
  TARGET_ID_BINDING_STORE_APPROVED: 'true', TARGET_ID_SERVICE_ENABLED: 'true',
  TARGET_ID_ORG_ID: 'A'.repeat(24) + '@AdobeOrg', TARGET_ID_DPID: '1547309',
};

module.exports = { SUB, ISSUER, NS, GRANT, params };
