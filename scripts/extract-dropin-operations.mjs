#!/usr/bin/env node
/**
 * Extracts every GraphQL operation (with fragments resolved) from the pinned storefront
 * drop-ins into test/contract/dropin-operations.json — the contract the mock backend must meet.
 * Keep DROPINS in sync with the storefront's package.json (masterclass-demo).
 *
 *   node scripts/extract-dropin-operations.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DROPINS = {
  'storefront-cart': '3.4.1',
  'storefront-checkout': '3.5.0',
  'storefront-order': '4.1.1',
  'storefront-pdp': '3.4.0',
  'storefront-product-discovery': '3.1.3',
  'storefront-recommendations': '4.1.0',
  'storefront-auth': '4.1.1',
  'storefront-account': '4.2.1',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dropins-'));
execSync('npm init -y', { cwd: tmp, stdio: 'ignore' });
execSync(`npm i --no-audit --no-fund --ignore-scripts @dropins/tools@3.0.0 ${Object.entries(DROPINS).map(([n, v]) => `@dropins/${n}@${v}`).join(' ')}`, { cwd: tmp, stdio: 'inherit' });

function walk(d, acc = []) {
  fs.readdirSync(d).forEach((f) => {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p, acc); else if (p.endsWith('.js')) acc.push(p);
  });
  return acc;
}

const strip = (s) => s.replace(/\$\{[^}]*\}/g, '');
const out = {};
Object.keys(DROPINS).forEach((pkg) => {
  const lits = [];
  walk(path.join(tmp, 'node_modules/@dropins', pkg)).forEach((f) => {
    const src = fs.readFileSync(f, 'utf8');
    const re = /`([^`]*)`/g;
    let m = re.exec(src);
    while (m) {
      lits.push(m[1]);
      m = re.exec(src);
    }
  });
  // fragments are imported across chunks under minified aliases → resolve them by name
  const frags = new Map();
  lits.forEach((l) => {
    const s = strip(l);
    [...s.matchAll(/fragment\s+([A-Za-z_0-9]+)\s+on\s+[A-Za-z_0-9]+\s*\{/g)].forEach((fm) => {
      let depth = 0;
      let j = s.indexOf('{', fm.index);
      for (; j < s.length; j += 1) {
        if (s[j] === '{') depth += 1;
        else if (s[j] === '}') {
          depth -= 1;
          if (!depth) break;
        }
      }
      const body = s.slice(fm.index, j + 1);
      if (!frags.has(fm[1]) || body.length > frags.get(fm[1]).length) frags.set(fm[1], body);
    });
  });
  lits.forEach((l) => {
    const mm = l.match(/^\s*(query|mutation)\s+([A-Za-z_0-9]+)/);
    if (!mm) return;
    let doc = strip(l);
    const have = new Set([...doc.matchAll(/fragment\s+([A-Za-z_0-9]+)\s+on/g)].map((x) => x[1]));
    let added = true;
    while (added) {
      added = false;
      new Set([...doc.matchAll(/\.\.\.\s*([A-Za-z_][A-Za-z_0-9]*)/g)].map((x) => x[1])).forEach((n) => {
        if (n === 'on' || have.has(n) || !frags.has(n)) return;
        doc += `\n${frags.get(n)}`;
        have.add(n);
        added = true;
      });
    }
    out[`${pkg}/${mm[2]}`] = doc;
  });
});

fs.writeFileSync(path.join(root, 'test/contract/dropin-operations.json'), JSON.stringify(out, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${Object.keys(out).length} operations written to test/contract/dropin-operations.json`);
