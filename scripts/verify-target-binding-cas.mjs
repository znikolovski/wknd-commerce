#!/usr/bin/env node
/**
 * Offline CLI only: default dry-run, --memory runs the probe against a new in-memory store.
 * Deliberately no .env loading, credentials, live DB option or network effects.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifyTargetBindingCas } = require('../lib/verify-target-binding-cas');
const { createMemoryStore } = require('../lib/store');

async function main() {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    if (arg === '--memory') options.memory = true;
    else {
      const match = /^--(environment|namespace|stage-namespace|production-namespace|prefix)=(.+)$/.exec(arg);
      if (!match) throw new Error('Only explicit environment, namespace map, prefix and --memory options are supported');
      options[match[1]] = match[2];
    }
  }
  const result = await verifyTargetBindingCas({
    environment: options.environment,
    namespace: options.namespace,
    stageNamespace: options['stage-namespace'],
    productionNamespace: options['production-namespace'],
    prefix: options.prefix,
    execute: options.memory === true,
    platformNamespace: options.memory ? options.namespace : undefined,
    getStore: () => createMemoryStore(),
  });
  console.log(JSON.stringify({ ...result, storage: options.memory ? 'memory-only' : 'none' }));
}

main().catch(() => {
  console.error('CAS probe refused or failed; check explicit environment, namespace map and disposable prefix. No live DB mode exists.');
  process.exitCode = 1;
});
