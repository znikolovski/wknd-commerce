/**
 * content-ai — public proxy for AEM Content AI search (Frescopa-style site search).
 *   POST …/content-ai/search     → POST {CONTENT_AI_URL}/content-sources/search
 *   POST …/content-ai/gensearch  → POST {CONTENT_AI_URL}/content-sources/gensearch
 * The IMS token never reaches the browser; the content source is pinned server-side.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { aemHeaders } = require('../../lib/aem');
const { decodeBody, corsHeaders } = require('../../lib/http');

const MAX_QUERY = 300;
const MAX_LIMIT = 20;

function searchBody(input, source) {
  const text = String(input.query?.text ?? input.query ?? '').slice(0, MAX_QUERY).trim();
  if (!text) return null;
  const type = ['vector', 'fulltext', 'hybrid'].includes(input.query?.type) ? input.query.type : 'vector';
  const limit = Math.min(Number(input.queryOptions?.pagination?.limit) || 8, MAX_LIMIT);
  const cursor = input.queryOptions?.pagination?.cursor;
  return {
    contentSource: { name: source },
    query: { type, text, ...(input.query?.options ? { options: input.query.options } : {}) },
    queryOptions: { pagination: { limit, ...(cursor ? { cursor: String(cursor).slice(0, 500) } : {}) } },
  };
}

function genBody(input, source) {
  const query = String(input.query ?? '').slice(0, MAX_QUERY * 4).trim();
  return query ? { query, contentSource: { name: source } } : null;
}

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
  const body = route === 'gensearch' ? genBody(input, source) : route === 'search' ? searchBody(input, source) : undefined;
  if (body === undefined) return { statusCode: 404, headers: cors, body: { error: 'Unknown route' } };
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
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': route === 'search' ? 'public, max-age=120' : 'no-store' },
      body: JSON.parse(text),
    };
  } catch (e) {
    logger.error(e);
    return { statusCode: 504, headers: cors, body: { error: 'Search timed out.' } };
  }
}

exports.main = main;
