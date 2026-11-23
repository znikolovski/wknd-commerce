/**
 * Fail-closed deploy input check (names and allowed values only; never prints values).
 *
 * `aio app deploy` injects `$WKND_*` references from .env as default action inputs. A checkout
 * whose .env lacks a gate silently deploys that gate in its default state (e.g. a missing
 * WKND_RECOVERY_REDEMPTION_VERIFIED turns the protected recovery offer off, a missing
 * WKND_PROMOTION_SELECTION reverts to v1 explicit-coupon precedence). Gates must therefore be
 * set explicitly to an allowed value; to deploy a gate off, set it to its "off" value.
 */

/** Gates whose absence would change live promotion behaviour. */
const GATES = Object.freeze({
  WKND_RECOVERY_REDEMPTION_VERIFIED: ['true', 'false'],
  WKND_PROMOTION_SELECTION: ['best-saving', 'explicit-first'],
});

/** Identity inputs that must be present (delegation and recovery bindings depend on them). */
const REQUIRED = Object.freeze(['WKND_AUTH0_ISSUER', 'WKND_AUTH0_AUDIENCE']);

/** Manifest inputs whose absence is the intended default (deployed empty, feature off). */
const TARGET_FLAGS = Object.freeze([
  'WKND_TARGET_DIAG_ENABLED', 'WKND_TARGET_ID_LINKAGE_ENABLED', 'WKND_TARGET_ID_BINDING_STORE_APPROVED',
  'WKND_TARGET_ID_SERVICE_ENABLED',
]);
const TARGET_INPUTS = Object.freeze([
  ...TARGET_FLAGS, 'WKND_TARGET_DIAG_ENVIRONMENT', 'WKND_TARGET_DIAG_ALLOWED_ORIGINS',
  'WKND_TARGET_DIAG_SHOPPER_KEYS', 'WKND_TARGET_DIAG_TIMEOUT_MS', 'WKND_TARGET_CLIENT_CODE',
  'WKND_TARGET_PROPERTY_TOKEN', 'WKND_TARGET_ID_LINKAGE_WORDING_VERSIONS', 'WKND_TARGET_ID_ORG_ID',
  'WKND_TARGET_ID_DPID', 'WKND_TARGET_ID_LEASE_MS', 'WKND_TARGET_ID_TIMEOUT_MS',
]);

/** Manifest inputs whose absence is the intended default (deployed empty, feature off). */
const OPTIONAL = Object.freeze(['WKND_MCP_DELEGATION_SECRET_PREVIOUS', ...TARGET_INPUTS]);

/**
 * The Target diagnostic / ID-linkage feature is Stage-only and off by default: every flag must be
 * empty, 'true' or 'false', and no flag may be 'true' outside a `-stage` namespace. Names only.
 */
function targetDiagnosticErrors(env) {
  const errors = [];
  const on = TARGET_FLAGS.filter((name) => env[name] === 'true');
  TARGET_FLAGS.forEach((name) => {
    if (![undefined, '', 'true', 'false'].includes(env[name])) errors.push(`${name} has an unsupported value (allowed: true, false or empty)`);
  });
  if (on.length && !String(env.AIO_runtime_namespace || '').endsWith('-stage')) {
    errors.push(`${on.join(', ')} may only be true in a -stage namespace`);
  }
  if (env.WKND_TARGET_DIAG_ENABLED === 'true' && env.WKND_TARGET_DIAG_ENVIRONMENT !== 'stage') {
    errors.push('WKND_TARGET_DIAG_ENABLED requires WKND_TARGET_DIAG_ENVIRONMENT=stage');
  }
  return errors;
}

const MIN_DELEGATION_SECRET_BYTES = 32;

/** Rotation-overlap rules for the delegation secret pair; reports names only. */
function delegationErrors(env) {
  const current = env.WKND_MCP_DELEGATION_SECRET || '';
  const previous = env.WKND_MCP_DELEGATION_SECRET_PREVIOUS || '';
  if (!previous) return [];
  const errors = [];
  if (!current) errors.push('WKND_MCP_DELEGATION_SECRET_PREVIOUS is set without WKND_MCP_DELEGATION_SECRET');
  if (Buffer.byteLength(previous, 'utf8') < MIN_DELEGATION_SECRET_BYTES) {
    errors.push(`WKND_MCP_DELEGATION_SECRET_PREVIOUS is shorter than ${MIN_DELEGATION_SECRET_BYTES} bytes`);
  }
  if (previous === current) {
    errors.push('WKND_MCP_DELEGATION_SECRET_PREVIOUS must differ from WKND_MCP_DELEGATION_SECRET');
  }
  return errors;
}

const REF = /\$(WKND_[A-Z0-9_]+)/g;

/** `$WKND_*` names referenced by the given manifest texts, sorted and unique. */
function referencedNames(manifestTexts = []) {
  const names = new Set();
  manifestTexts.forEach((text) => {
    for (const m of String(text).matchAll(REF)) names.add(m[1]);
  });
  return [...names].sort();
}

/** Parses dotenv-style text into a plain object (KEY=value; no interpolation). */
function parseEnv(text = '') {
  const out = {};
  String(text).split('\n').forEach((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) return;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  });
  return out;
}

/**
 * @param {{ manifestTexts: string[], env: Record<string,string> }} input
 * @returns {{ ok: boolean, errors: string[], warnings: string[], gates: Record<string,string>,
 *   namespace: string|null }} `gates` holds only the allowed gate values (never secrets)
 */
function checkDeployEnv({ manifestTexts = [], env = {} }) {
  const errors = [];
  const warnings = [];
  const gates = {};
  Object.entries(GATES).forEach(([name, allowed]) => {
    const value = env[name];
    if (value === undefined || value === '') {
      errors.push(`${name} is not set (set it explicitly to one of: ${allowed.join(', ')})`);
    } else if (!allowed.includes(value)) {
      errors.push(`${name} has an unsupported value (allowed: ${allowed.join(', ')})`);
    } else {
      gates[name] = value;
    }
  });
  REQUIRED.forEach((name) => {
    if (!env[name]) errors.push(`${name} is not set`);
  });
  errors.push(...delegationErrors(env));
  errors.push(...targetDiagnosticErrors(env));
  referencedNames(manifestTexts).forEach((name) => {
    if (!(name in env) && !(name in GATES) && !REQUIRED.includes(name) && !OPTIONAL.includes(name)) {
      warnings.push(`${name} is referenced by the manifest but not declared (deploys as empty)`);
    }
  });
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    gates,
    namespace: env.AIO_runtime_namespace || null,
    delegationOverlap: Boolean(env.WKND_MCP_DELEGATION_SECRET_PREVIOUS),
    targetDiagnostic: env.WKND_TARGET_DIAG_ENABLED === 'true',
  };
}

module.exports = {
  GATES, REQUIRED, OPTIONAL, TARGET_INPUTS, referencedNames, parseEnv, checkDeployEnv,
};
