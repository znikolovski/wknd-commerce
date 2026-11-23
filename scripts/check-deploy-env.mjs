#!/usr/bin/env node
/**
 * Fail-closed deploy input check (run automatically as the pre-app-deploy hook).
 *   node scripts/check-deploy-env.mjs                # this checkout's .env
 *   node scripts/check-deploy-env.mjs --env=<path>   # another checkout's .env
 * Prints names, the namespace and allowed gate values only — never secret values. Exits 1 when
 * a promotion gate or required identity input is missing, so a checkout with an incomplete
 * .env cannot silently deploy live gates off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { checkDeployEnv, parseEnv } = require(path.join(root, 'lib/deploy-env.js'));

const envArg = process.argv.slice(2).find((a) => a.startsWith('--env='));
const envFile = envArg ? path.resolve(envArg.slice(6)) : path.join(root, '.env');
const fileEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
const processEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => k.startsWith('WKND_') || k === 'AIO_runtime_namespace'));
const env = { ...fileEnv, ...processEnv };

const manifests = ['app.config.yaml', 'src/commerce-runtime.yaml']
  .map((p) => path.join(root, p)).filter((p) => fs.existsSync(p))
  .map((p) => fs.readFileSync(p, 'utf8'));

const result = checkDeployEnv({ manifestTexts: manifests, env });
console.log(`deploy-env: namespace=${result.namespace || '(unset)'} gates=${JSON.stringify(result.gates)} delegationOverlap=${result.delegationOverlap}`);
result.warnings.forEach((w) => console.log(`deploy-env: warning: ${w}`));
result.errors.forEach((e) => console.error(`deploy-env: ERROR: ${e}`));
if (!result.ok) {
  console.error('deploy-env: refusing to deploy with incomplete gate configuration.');
  process.exit(1);
}
