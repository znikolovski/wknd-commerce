/**
 * Small helpers for raw web actions.
 */

function decodeBody(params) {
  if (!params.__ow_body) return {};
  if (typeof params.__ow_body === 'object') return params.__ow_body;
  let raw = params.__ow_body;
  if (!/^\s*[{[]/.test(raw)) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch { /* keep */ }
  }
  try { return JSON.parse(raw); } catch { return {}; }
}

function parseQueryString(qs = '') {
  return Object.fromEntries(new URLSearchParams(qs));
}

/** Normalises GraphQL-over-HTTP GET/POST into { query, variables, operationName }. */
function parseRequest(params) {
  const method = (params.__ow_method || 'post').toLowerCase();
  const src = method === 'get'
    ? { ...parseQueryString(params.__ow_query), ...params }
    : { ...decodeBody(params) };
  let { variables } = src;
  if (typeof variables === 'string') {
    try { variables = JSON.parse(variables); } catch { variables = {}; }
  }
  return { query: src.query, variables: variables || {}, operationName: src.operationName || undefined };
}

function allowedOrigins(params) {
  return String(params.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
}

// Entries may wildcard one host label, e.g. https://*--masterclass-demo--znikolovski.aem.page
function originMatches(pattern, origin) {
  if (!pattern.includes('*')) return pattern === origin;
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+')}$`, 'i');
  return re.test(origin || '');
}

function corsHeaders(params, origin) {
  const allowed = allowedOrigins(params);
  let allowOrigin = allowed[0];
  if (!allowed.length || allowed.includes('*')) allowOrigin = '*';
  else if (allowed.some((p) => originMatches(p, origin))) allowOrigin = origin;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Store, Magento-Store-Code, Magento-Store-View-Code, Magento-Website-Code, Magento-Environment-Id, Magento-Customer-Group, x-api-key, X-Request-Id',
    Vary: 'Origin',
  };
}

function json(statusCode, body, headers = {}) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...headers }, body };
}

module.exports = {
  originMatches,
  decodeBody, parseRequest, corsHeaders, json, allowedOrigins,
};
