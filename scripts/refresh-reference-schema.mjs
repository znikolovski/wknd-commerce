#!/usr/bin/env node
/**
 * Refreshes schema/reference/*.graphql by introspecting a reference Adobe Commerce backend
 * (defaults to the public demo backend used by hlxsites/aem-boilerplate-commerce).
 *
 *   node scripts/refresh-reference-schema.mjs [--core=<url>] [--cs=<url>] [--cs-headers='{"x-api-key":"…"}']
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIntrospectionQuery, buildClientSchema, printSchema } from 'graphql';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split(/=(.*)/s)).map(([k, v]) => [k, v ?? true]));

async function demoConfig() {
  const res = await fetch('https://raw.githubusercontent.com/hlxsites/aem-boilerplate-commerce/main/demo-config.json');
  return (await res.json()).public.default;
}

async function introspect(url, headers) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query: getIntrospectionQuery() }),
  });
  const j = await r.json();
  if (!j.data) throw new Error(`${url}: ${JSON.stringify(j).slice(0, 300)}`);
  return printSchema(buildClientSchema(j.data));
}

const cfg = (args.core && args.cs) ? null : await demoConfig();
const coreUrl = args.core || cfg['commerce-core-endpoint'];
const csUrl = args.cs || cfg['commerce-endpoint'];
const coreHeaders = cfg?.headers?.all || {};
const csHeaders = args['cs-headers'] ? JSON.parse(args['cs-headers']) : { ...cfg.headers.all, ...cfg.headers.cs };

const core = await introspect(coreUrl, coreHeaders);
const cs = await introspect(csUrl, csHeaders);
fs.writeFileSync(path.join(root, 'schema/reference/core.graphql'), core);
fs.writeFileSync(path.join(root, 'schema/reference/catalog-service.graphql'), cs);
console.log(`reference schemas refreshed (core ${core.length} chars, catalog service ${cs.length} chars)`);
