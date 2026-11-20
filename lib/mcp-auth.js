const { createHash, timingSafeEqual } = require('node:crypto');

const SECRET_HEADER = 'x-wknd-mcp-key';

class McpHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requestHeaders(input = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (typeof value !== 'string' || Object.hasOwn(headers, key)) {
      throw new McpHttpError(400, 'INVALID_HEADERS', 'Invalid request headers.');
    }
    headers[key] = value;
  }
  return headers;
}

function authenticateIntegration(params, headers) {
  const secret = params.MCP_SHARED_SECRET;
  const orgId = params.MCP_ORG_ID;
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(secret)
    || typeof orgId !== 'string' || !/^[A-Za-z0-9_-]{1,128}(?:@AdobeOrg)?$/.test(orgId)) {
    throw new McpHttpError(503, 'MCP_NOT_CONFIGURED', 'Commerce MCP is not configured.');
  }
  const supplied = headers[SECRET_HEADER];
  if (typeof supplied !== 'string' || supplied.length > 128
    || !timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(secret).digest())) {
    throw new McpHttpError(401, 'UNAUTHORIZED', 'A valid commerce MCP key is required.');
  }
  return Object.freeze({
    kind: 'integration',
    subject: 'cx-coworker',
    orgId,
  });
}

function checkOrigin(params, headers) {
  if (!Object.hasOwn(headers, 'origin')) return {};
  const allowed = String(params.MCP_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(headers.origin) || headers.origin === 'null' || headers.origin === '*') {
    throw new McpHttpError(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed.');
  }
  return {
    'Access-Control-Allow-Origin': headers.origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, Accept, MCP-Protocol-Version, ${SECRET_HEADER}`,
    Vary: 'Origin',
  };
}

module.exports = {
  McpHttpError, SECRET_HEADER, requestHeaders, authenticateIntegration, checkOrigin,
};
