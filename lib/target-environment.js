/**
 * Server-owned, platform-verified namespace map. Never infer a workspace from a suffix.
 * The action supplies namespace from Runtime's process environment, not request parameters.
 */
const ENVIRONMENTS = Object.freeze(['stage', 'production']);

function environmentGate(config = {}, namespace) {
  const environment = config.TARGET_DIAG_ENVIRONMENT;
  if (!ENVIRONMENTS.includes(environment)) return 'invalid-environment';
  const stage = config.TARGET_DIAG_STAGE_NAMESPACE;
  const production = config.TARGET_DIAG_PRODUCTION_NAMESPACE;
  if (stage && production && stage === production) return 'namespace-overlap';
  const expected = environment === 'stage' ? stage : production;
  if (typeof expected !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(expected)) return 'namespace-not-configured';
  if (!namespace || namespace !== expected) return 'namespace-mismatch';
  return null;
}

module.exports = { ENVIRONMENTS, environmentGate };
