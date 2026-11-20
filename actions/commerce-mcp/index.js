const { randomUUID } = require('node:crypto');
const Logger = require('@adobe/aio-lib-core-logging');
const { WebStandardStreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
const { getStore } = require('../../lib/store');
const { triggerPrerender } = require('../../lib/invoke');
const { createCommerceServer } = require('../../lib/mcp-server');
const {
  McpHttpError, requestHeaders, authenticateIntegration, checkOrigin,
} = require('../../lib/mcp-auth');

const MAX_BODY_BYTES = 65536;

function decodeRequestBody(raw) {
  if (typeof raw !== 'string') throw new McpHttpError(400, 'INVALID_BODY', 'A raw JSON request body is required.');
  if (raw.length > Math.ceil(MAX_BODY_BYTES / 3) * 4) {
    throw new McpHttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 65536 bytes.');
  }
  let bytes;
  if (/^\s*[{[]/.test(raw)) bytes = Buffer.from(raw, 'utf8');
  else {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
      throw new McpHttpError(400, 'INVALID_BODY', 'Invalid body encoding.');
    }
    bytes = Buffer.from(raw, 'base64');
  }
  if (bytes.length > MAX_BODY_BYTES) throw new McpHttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 65536 bytes.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const body = JSON.parse(text);
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('not a single request');
  } catch {
    throw new McpHttpError(400, 'INVALID_JSON', 'A single valid JSON-RPC request is required.');
  }
  return text;
}

function createMain({ openStore = getStore, logger = Logger('commerce-mcp', { level: 'info' }), prerender = triggerPrerender } = {}) {
  return async function main(params) {
    const correlationId = randomUUID();
    let cors = {};
    let server;
    let store;
    let response;
    try {
      const headers = requestHeaders(params.__ow_headers);
      cors = checkOrigin(params, headers);
      const method = String(params.__ow_method || '').toUpperCase();
      if (params.__ow_query) throw new McpHttpError(400, 'QUERY_NOT_SUPPORTED', 'Query parameters are not supported.');
      if (method === 'OPTIONS') {
        return {
          statusCode: 204,
          headers: { ...cors, 'Cache-Control': 'no-store', 'X-Request-Id': correlationId },
          body: '',
        };
      }
      const actor = authenticateIntegration(params, headers);
      if (method !== 'POST') throw new McpHttpError(405, 'METHOD_NOT_ALLOWED', 'Only POST and OPTIONS are supported.');
      if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '')) {
        throw new McpHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
      }
      const text = decodeRequestBody(params.__ow_body);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES,
      });
      server = createCommerceServer({
        openStore: async () => {
          if (!store) {
            store = await openStore({
              __ims_oauth_s2s: params.__ims_oauth_s2s, __ims_env: params.__ims_env, DB_REGION: params.DB_REGION,
            });
          }
          return store;
        },
        context: {
          actor, correlationId, logger,
          promotionCursorKey: params.PROMOTION_CURSOR_KEY,
          promotionWritesEnabled: params.MCP_PROMOTION_WRITES_ENABLED === 'true',
          recoveryRedemptionVerified: params.RECOVERY_REDEMPTION_VERIFIED === 'true',
          prerender: (skus) => prerender({ PRERENDER_ACTION: 'commerce/prerender' }, skus),
        },
      });
      await server.connect(transport);
      // Forward protocol headers only: never forward the integration key downstream.
      const protocolHeaders = new Headers();
      for (const key of ['content-type', 'accept', 'mcp-protocol-version']) {
        if (headers[key]) protocolHeaders.set(key, headers[key]);
      }
      const result = await transport.handleRequest(new Request('https://runtime.adobe.io/commerce-mcp', {
        method: 'POST', headers: protocolHeaders, body: text,
      }));
      response = {
        statusCode: result.status,
        headers: {
          ...Object.fromEntries(result.headers), ...cors, 'Cache-Control': 'no-store', 'X-Request-Id': correlationId,
        },
        body: await result.text(),
      };
    } catch (error) {
      const known = error instanceof McpHttpError;
      logger.error(known ? `mcp.http.${error.code}` : 'mcp.http.failed', { correlationId });
      response = {
        statusCode: known ? error.status : 500,
        headers: {
          ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Request-Id': correlationId,
          ...(error.status === 405 ? { Allow: 'POST, OPTIONS' } : {}),
        },
        body: JSON.stringify({
          error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Commerce MCP is unavailable.' },
          correlationId,
        }),
      };
    } finally {
      for (const [resource, code] of [[server, 'mcp.server.close-failed'], [store, 'mcp.store.close-failed']]) {
        if (resource) {
          try { await resource.close(); } catch { logger.error(code, { correlationId }); }
        }
      }
    }
    return response;
  };
}

exports.main = createMain();
exports.createMain = createMain;
