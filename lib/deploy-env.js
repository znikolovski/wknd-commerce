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
  referencedNames(manifestTexts).forEach((name) => {
    if (!(name in env) && !(name in GATES) && !REQUIRED.includes(name)) {
      warnings.push(`${name} is referenced by the manifest but not declared (deploys as empty)`);
    }
  });
  return {
    ok: errors.length === 0, errors, warnings, gates, namespace: env.AIO_runtime_namespace || null,
  };
}

module.exports = {
  GATES, REQUIRED, referencedNames, parseEnv, checkDeployEnv,
};
