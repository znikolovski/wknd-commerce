const fs = require('node:fs');
const path = require('node:path');
const {
  checkDeployEnv, referencedNames, parseEnv, GATES,
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

  test('parseEnv handles quotes, export and comments', () => {
    expect(parseEnv('# c\nexport A="1"\nB=\'two\'\nC= three \nnot a line')).toEqual({ A: '1', B: 'two', C: 'three' });
  });
});
