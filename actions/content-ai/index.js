/**
 * content-ai — public proxy for AEM Content AI search (Frescopa-style site search).
 *   POST …/content-ai/search     → POST {CONTENT_AI_URL}/content-sources/search
 *   POST …/content-ai/gensearch  → POST {CONTENT_AI_URL}/content-sources/gensearch
 * Content AI has no CORS, the IMS token never reaches the browser and the content source is
 * pinned server-side. Hits are reduced to the fields the search modal renders (raw hits carry
 * ~5 KB of crawl metadata each).
 */
const logging = require('@adobe/aio-lib-core-logging');
const { aemHeaders } = require('../../lib/aem');
const { decodeBody, corsHeaders } = require('../../lib/http');
const { searchBody, genBody, toSearchResponse, toGenResponse } = require('../../lib/content-ai');

async function main(params) {
  const logger = logging('content-ai', { level: params.LOG_LEVEL || 'info' });
  const headers = params.__ow_headers || {};
  const cors = corsHeaders(params, headers.origin);
  const method = (params.__ow_method || 'post').toLowerCase();
  if (method === 'options') return { statusCode: 204, headers: { ...cors, 'Access-Control-Max-Age': '600' } };
  if (method !== 'post') return { statusCode: 405, headers: cors, body: { error: 'POST only' } };

  const route = String(params.__ow_path || '').replace(/^\/+/, '');
  const input = decodeBody(params);
  const source = params.CONTENT_AI_SOURCE;
  const builders = { search: searchBody, gensearch: genBody };
  if (!builders[route]) return { statusCode: 404, headers: cors, body: { error: 'Unknown route' } };
  const body = builders[route](input, source);
  if (!body) return { statusCode: 400, headers: cors, body: { error: 'query is required' } };

  try {
    const res = await fetch(`${String(params.CONTENT_AI_URL).replace(/\/$/, '')}/content-sources/${route}`, {
      method: 'POST',
      headers: { ...(await aemHeaders(params)), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(route === 'gensearch' ? 28000 : 12000),
    });
    const text = await res.text();
    if (!res.ok) {
      logger.warn(`${route} ${res.status}: ${text.slice(0, 300)}`);
      return { statusCode: res.status === 429 ? 429 : 502, headers: cors, body: { error: 'Search is temporarily unavailable.' } };
    }
    const json = JSON.parse(text);
    return {
      statusCode: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Cache-Control': route === 'search' ? 'public, max-age=120' : 'no-store',
      },
      body: route === 'search' ? toSearchResponse(json, params.SITE_ORIGIN) : toGenResponse(json, params.SITE_ORIGIN),
    };
  } catch (e) {
    logger.error(e);
    return { statusCode: 504, headers: cors, body: { error: 'Search timed out.' } };
  }
}

exports.main = main;
