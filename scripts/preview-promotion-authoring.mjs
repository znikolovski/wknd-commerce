import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import authoring from '../lib/promotion-authoring.js';
import drafts from '../lib/promotion-drafts.js';
import storage from '../lib/store.js';

const page = await readFile(new URL('../src/dx-excshell-1/web-src/promotion-authoring-preview.html', import.meta.url));
const service = drafts.createPromotionDraftService({ store: storage.createMemoryStore() });
const port = Number(process.env.PORT || 4178);
const server = http.createServer(async (req, res) => {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  if (req.method === 'GET' && req.url === '/') return send(200, page, 'text/html');
  if (req.method === 'GET' && req.url === '/audiences') return send(200, authoring.authoringCatalogue());
  const method = /^\/drafts\/(validate|create|get|list|update|delete)$/.exec(req.url)?.[1];
  if (req.method !== 'POST' || (!method && req.url !== '/preview')) return send(404, { error: 'Unknown local preview route.' });
  let raw = '';
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 16384) return send(413, { error: 'Fixture request exceeds 16 KiB.' });
    }
    let args;
    try {
      args = JSON.parse(raw);
    } catch {
      return send(400, { error: 'Fixture request must be JSON.' });
    }
    const result = method
      ? { ...await service[method]({
        actor: { kind: 'integration', subject: 'local-preview', orgId: 'local-preview' },
        correlationId: randomUUID(),
      }, args), localSimulation: true, storage: 'memory-cleared-on-restart' }
      : authoring.previewAudienceDraft(args);
    return send(result.ok ? 200 : 400, result);
  } catch (error) {
    console.error('Fixture preview failed:', error.message);
    return send(500, { error: 'Fixture preview failed. Check the local server log.' });
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`C01/C02 local preview: http://127.0.0.1:${port} (simulated memory storage clears on restart; no live DB, credentials or providers)`);
});
server.on('error', (error) => {
  console.error(`Cannot start ${fileURLToPath(import.meta.url)}: ${error.message}`);
  process.exitCode = 1;
});
