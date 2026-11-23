const fs = require('node:fs');
const path = require('node:path');
const {
  checkDeployEnv, referencedNames, parseEnv, GATES, TARGET_INPUTS,
} = require('../lib/deploy-env');

const root = path.join(__dirname, '..');
const manifests = ['app.config.yaml', 'src/commerce-runtime.yaml'].map((p) => fs.readFileSync(path.join(root, p), 'utf8'));
const COMPLETE = {
  AIO_runtime_namespace: 'ns-stage',
  WKND_RECOVERY_REDEMPTION_VERIFIED: 'true',
  WKND_PROMOTION_SELECTION: 'best-saving',
  WKND_AUTH0_ISSUER: 'https://example.auth0.com/',
  WKND_AUTH0_AUDIENCE: 'aud',
};

describe('deploy input check (fail closed)', () => {
  test('the manifests reference every promotion gate', () => {
    const names = referencedNames(manifests);
    Object.keys(GATES).forEach((g) => expect(names).toContain(g));
  });

  test('complete gates pass and only allowed gate values are reported', () => {
    const r = checkDeployEnv({ manifestTexts: manifests, env: { ...COMPLETE, WKND_MCP_DELEGATION_SECRET: 's3cr3t' } });
    expect(r.ok).toBe(true);
    expect(r.gates).toEqual({ WKND_RECOVERY_REDEMPTION_VERIFIED: 'true', WKND_PROMOTION_SELECTION: 'best-saving' });
    expect(JSON.stringify(r)).not.toContain('s3cr3t');
    expect(JSON.stringify(r)).not.toContain('example.auth0.com');
  });

  test.each(Object.keys(GATES))('missing %s refuses the deploy', (gate) => {
    const env = { ...COMPLETE };
    delete env[gate];
    const r = checkDeployEnv({ manifestTexts: manifests, env });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain(gate);
  });

  test('empty or unsupported gate values refuse the deploy', () => {
    expect(checkDeployEnv({ env: { ...COMPLETE, WKND_PROMOTION_SELECTION: '' } }).ok).toBe(false);
    const bad = checkDeployEnv({ env: { ...COMPLETE, WKND_RECOVERY_REDEMPTION_VERIFIED: 'yes-please' } });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).not.toContain('yes-please');
  });

  test('gates may be deployed off only explicitly', () => {
    const r = checkDeployEnv({ env: { ...COMPLETE, WKND_RECOVERY_REDEMPTION_VERIFIED: 'false', WKND_PROMOTION_SELECTION: 'explicit-first' } });
    expect(r.ok).toBe(true);
  });

  test('missing identity inputs refuse the deploy', () => {
    const env = { ...COMPLETE };
    delete env.WKND_AUTH0_ISSUER;
    expect(checkDeployEnv({ env }).errors).toContain('WKND_AUTH0_ISSUER is not set');
  });

  test('undeclared manifest references are warnings, by name only', () => {
    const r = checkDeployEnv({ manifestTexts: ['x: $WKND_NEW_THING'], env: COMPLETE });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(['WKND_NEW_THING is referenced by the manifest but not declared (deploys as empty)']);
  });

  describe('delegation rotation overlap', () => {
    const CURRENT = 'c'.repeat(40);
    const PREVIOUS = 'p'.repeat(40);

    test('an undeclared previous key is the intended default, not a warning', () => {
      const r = checkDeployEnv({ manifestTexts: manifests, env: { ...COMPLETE, WKND_MCP_DELEGATION_SECRET: CURRENT } });
      expect(r.ok).toBe(true);
      expect(r.delegationOverlap).toBe(false);
      expect(r.warnings.join('\n')).not.toContain('WKND_MCP_DELEGATION_SECRET_PREVIOUS');
    });

    test('a valid previous key is reported as an overlap by flag only', () => {
      const r = checkDeployEnv({
        env: { ...COMPLETE, WKND_MCP_DELEGATION_SECRET: CURRENT, WKND_MCP_DELEGATION_SECRET_PREVIOUS: PREVIOUS },
      });
      expect(r.ok).toBe(true);
      expect(r.delegationOverlap).toBe(true);
      expect(JSON.stringify(r)).not.toContain(CURRENT);
      expect(JSON.stringify(r)).not.toContain(PREVIOUS);
    });

    test.each([
      ['equal to the current key', { WKND_MCP_DELEGATION_SECRET: CURRENT, WKND_MCP_DELEGATION_SECRET_PREVIOUS: CURRENT }],
      ['shorter than 32 bytes', { WKND_MCP_DELEGATION_SECRET: CURRENT, WKND_MCP_DELEGATION_SECRET_PREVIOUS: 'short' }],
      ['set without a current key', { WKND_MCP_DELEGATION_SECRET_PREVIOUS: PREVIOUS }],
    ])('a previous key %s refuses the deploy, naming no value', (_, extra) => {
      const r = checkDeployEnv({ env: { ...COMPLETE, ...extra } });
      expect(r.ok).toBe(false);
      expect(r.errors.join('\n')).toContain('WKND_MCP_DELEGATION_SECRET_PREVIOUS');
      expect(JSON.stringify(r)).not.toContain(CURRENT);
      expect(JSON.stringify(r)).not.toContain(PREVIOUS);
    });

    test('the manifest maps the previous key only to the delegation verifier', () => {
      const text = manifests[0];
      expect(text.match(/\$WKND_MCP_DELEGATION_SECRET_PREVIOUS/g)).toHaveLength(1);
      expect(text).toContain('MCP_DELEGATION_SECRET_PREVIOUS: $WKND_MCP_DELEGATION_SECRET_PREVIOUS');
    });
  });

  describe('Environment-bound Target diagnostic / ID linkage (off by default)', () => {
    const yaml = require('js-yaml');
    const action = () => yaml.load(manifests[0]).application.runtimeManifest.packages.commerce.actions['target-diagnostic'];

    test('the action is a final raw web action whose every WKND_TARGET_* input is optional (deploys empty = off)', () => {
      const a = action();
      expect(a).toMatchObject({ function: 'actions/target-diagnostic/index.js', web: 'raw' });
      expect(a.annotations).toMatchObject({ final: true, 'require-adobe-auth': false });
      const refs = Object.values(a.inputs).map((v) => String(v).replace(/^\$/, ''));
      refs.filter((n) => n.startsWith('WKND_TARGET_')).forEach((n) => expect(TARGET_INPUTS).toContain(n));
      const r = checkDeployEnv({ manifestTexts: manifests, env: COMPLETE });
      expect(r).toMatchObject({ ok: true, targetDiagnostic: false });
      expect(r.warnings.join('\n')).not.toContain('WKND_TARGET_');
    });

    test('the action inputs never include promotion, delegation, Brevo or commerce secrets', () => {
      expect(Object.keys(action().inputs).filter((k) => /PROMOTION|RECOVERY|DELEGATION|BREVO|MCP_/.test(k))).toEqual([]);
    });

    test.each([
      'WKND_TARGET_DIAG_ENABLED', 'WKND_TARGET_ID_LINKAGE_ENABLED', 'WKND_TARGET_ID_BINDING_STORE_APPROVED', 'WKND_TARGET_ID_SERVICE_ENABLED',
    ])('%s=true without an exact expected namespace refuses the deploy (names only)', (flag) => {
      const env = {
        ...COMPLETE, AIO_runtime_namespace: '28538-wkndcommerce', WKND_TARGET_DIAG_ENVIRONMENT: 'stage', [flag]: 'true',
      };
      const r = checkDeployEnv({ manifestTexts: manifests, env });
      expect(r.ok).toBe(false);
      expect(r.errors.join('\n')).toContain('namespace-not-configured');
    });

    test('flags accept only true, false or empty; enabling requires an environment mapping', () => {
      expect(checkDeployEnv({ env: { ...COMPLETE, WKND_TARGET_ID_SERVICE_ENABLED: 'yes' } }).ok).toBe(false);
      expect(checkDeployEnv({ env: { ...COMPLETE, WKND_TARGET_DIAG_ENABLED: 'true' } }).errors.join())
        .toContain('invalid-environment');
      const on = checkDeployEnv({ env: {
        ...COMPLETE, WKND_TARGET_DIAG_ENABLED: 'true', WKND_TARGET_DIAG_ENVIRONMENT: 'stage',
        WKND_TARGET_DIAG_STAGE_NAMESPACE: COMPLETE.AIO_runtime_namespace,
      } });
      expect(on).toMatchObject({ ok: true, targetDiagnostic: true });
      expect(checkDeployEnv({ env: { ...COMPLETE, WKND_TARGET_DIAG_ENABLED: 'false' } }).ok).toBe(true);
    });

    test('retirement is optional and requires verified partner org plus approved storage when enabled', () => {
      const env = {
        ...COMPLETE, AIO_runtime_namespace: 'example-runtime', WKND_TARGET_DIAG_ENVIRONMENT: 'stage',
        WKND_TARGET_DIAG_STAGE_NAMESPACE: 'example-runtime', WKND_TARGET_ID_RETIREMENT_ENABLED: 'true',
        WKND_TARGET_ID_BINDING_STORE_APPROVED: 'true',
        WKND_TARGET_ID_ORG_ID: '28260E2056581D3B7F000101@AdobeOrg', WKND_TARGET_ID_DPID: '1547309',
      };
      expect(checkDeployEnv({ env }).ok).toBe(true);
      expect(checkDeployEnv({ env: { ...env, WKND_TARGET_ID_ORG_ID: '0'.repeat(24) + '@AdobeOrg' } }).errors.join()).toContain('WKND_TARGET_ID_ORG_ID');
      expect(checkDeployEnv({ env: { ...env, WKND_TARGET_ID_BINDING_STORE_APPROVED: 'false' } }).errors.join()).toContain('WKND_TARGET_ID_BINDING_STORE_APPROVED');
    });

    test('Production is permitted only with the mapped namespace; live decide needs verified Target config', () => {
      const env = {
        ...COMPLETE, AIO_runtime_namespace: 'example-runtime', WKND_TARGET_DIAG_ENVIRONMENT: 'production',
        WKND_TARGET_DIAG_STAGE_NAMESPACE: 'example-other', WKND_TARGET_DIAG_PRODUCTION_NAMESPACE: 'example-runtime',
        WKND_TARGET_DIAG_ENABLED: 'true',
      };
      expect(checkDeployEnv({ env }).ok).toBe(true);
      expect(checkDeployEnv({ env: { ...env, AIO_runtime_namespace: 'example-other' } }).errors.join()).toContain('namespace-mismatch');
      expect(checkDeployEnv({ env: { ...env, WKND_TARGET_DIAG_STAGE_NAMESPACE: 'example-runtime' } }).errors.join()).toContain('namespace-overlap');
      const live = {
        ...env, WKND_TARGET_ID_LINKAGE_ENABLED: 'true', WKND_TARGET_ID_LINKAGE_WORDING_VERSIONS: 'owner-v1',
        WKND_TARGET_ID_BINDING_STORE_APPROVED: 'true', WKND_TARGET_ID_SERVICE_ENABLED: 'true',
        WKND_TARGET_ID_ORG_ID: '000000000000000000000000@AdobeOrg', WKND_TARGET_ID_DPID: '123',
        WKND_TARGET_CLIENT_CODE: 'mockclient', WKND_TARGET_PROPERTY_TOKEN: '11111111-2222-4333-8444-555555555555',
        WKND_TARGET_DIAG_SHOPPER_KEYS: 'offline-test-key',
      };
      expect(checkDeployEnv({ env: live }).errors.join()).toContain('WKND_TARGET_DIAG_TARGET_CONFIG_APPROVED');
      expect(checkDeployEnv({ env: { ...live, WKND_TARGET_DIAG_TARGET_CONFIG_APPROVED: 'true' } }).ok).toBe(true);
      expect(checkDeployEnv({ env: { ...live, WKND_TARGET_ID_LINKAGE_WORDING_VERSIONS: '' } }).ok).toBe(false);
    });
  });

  test('parseEnv handles quotes, export and comments', () => {
    expect(parseEnv('# c\nexport A="1"\nB=\'two\'\nC= three \nnot a line')).toEqual({ A: '1', B: 'two', C: 'three' });
  });
});
