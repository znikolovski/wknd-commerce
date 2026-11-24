/**
 * Customer authentication — reuses the WKND Aero Auth0 tenant and API audience.
 * Mirrors workers/wknd-aero-api/src/booking-auth.js: RS256 access token validated against
 * the tenant JWKS, issuer and audience. The customer record is keyed by the token `sub`;
 * profile fields come from Auth0 /userinfo (cached on the customer document).
 */
const { createRemoteJWKSet, jwtVerify } = require('jose');

const keySets = new Map();

/*
 * Delegated shopper assertions from the WKND LLM app (ChatGPT/MCP). The MCP server verifies the
 * shopper's Auth0 token for its own resource, then signs a short-lived HS256 assertion for the same
 * Auth0 `sub`, so the shopper gets the same customer record (and active cart) as on the website.
 */
const DELEGATION_HEADER = 'x-wknd-delegation';
const DELEGATION_AUDIENCE = 'urn:wknd-commerce:storefront';
const DELEGATION_SCOPE = 'shop:cart';
const DELEGATION_MAX_LIFETIME_S = 120;
const MIN_SECRET_BYTES = 32;

class AuthError extends Error {
  constructor(message, category = 'graphql-authorization') {
    super(message);
    this.extensions = { category };
  }
}

function bearer(headers = {}) {
  const raw = headers.authorization || headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token && token !== 'null' && token !== 'undefined' ? token : null;
}

function authConfig(params) {
  return {
    issuer: params.AUTH0_ISSUER,
    audience: params.AUTH0_AUDIENCE,
    clientId: params.AUTH0_CLIENT_ID,
  };
}

async function verifyToken(token, params, { jwks } = {}) {
  const { issuer, audience } = authConfig(params);
  if (!issuer || !audience) throw new AuthError('Customer sign-in is not configured.');
  if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL('.well-known/jwks.json', issuer)));
  const { payload } = await jwtVerify(token, jwks || keySets.get(issuer), {
    issuer, audience, algorithms: ['RS256'], requiredClaims: ['sub', 'exp'],
  });
  return payload;
}

async function fetchUserInfo(token, params) {
  try {
    const res = await fetch(new URL('userinfo', params.AUTH0_ISSUER), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    return res.ok ? res.json() : {};
  } catch {
    return {};
  }
}

function splitName(info = {}) {
  const first = info.given_name || (info.name && !info.name.includes('@') ? info.name.split(' ')[0] : '') || '';
  const last = info.family_name || (info.name && info.name.includes(' ') ? info.name.split(' ').slice(1).join(' ') : '') || '';
  return { firstname: first, lastname: last };
}

function isDelegated(headers = {}) {
  const value = headers[DELEGATION_HEADER] ?? headers['X-WKND-Delegation'];
  return typeof value === 'string' && value.trim().toLowerCase() === 'mcp';
}

/**
 * Keys accepted for delegated assertions: the current secret, plus the previous one only while a
 * rotation overlap is configured. An empty, short or duplicate previous key is never accepted.
 */
function delegationKeys(secret, previous) {
  const keys = [secret];
  if (typeof previous === 'string' && previous !== secret
    && Buffer.byteLength(previous, 'utf8') >= MIN_SECRET_BYTES) keys.push(previous);
  return keys;
}

/**
 * Verifies a delegated shopper assertion and rejects replays (each `jti` is accepted once).
 * @returns {Promise<object>} claims
 */
async function verifyDelegation(token, params, store, { now = Math.floor(Date.now() / 1000) } = {}) {
  const secret = params.MCP_DELEGATION_SECRET;
  const issuer = params.MCP_DELEGATION_ISSUER;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES || !issuer) {
    throw new AuthError('Delegated shopper sign-in is not configured.');
  }
  let payload;
  for (const key of delegationKeys(secret, params.MCP_DELEGATION_SECRET_PREVIOUS)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(key), {
        issuer,
        audience: DELEGATION_AUDIENCE,
        algorithms: ['HS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'jti'],
        clockTolerance: 30,
        currentDate: new Date(now * 1000),
      }));
      break;
    } catch {
      // try the next accepted key
    }
  }
  if (!payload) {
    throw new AuthError('The current customer isn\'t authorized.', 'graphql-authentication');
  }
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
  if (payload.identity_issuer !== params.AUTH0_ISSUER || !scopes.includes(DELEGATION_SCOPE)
    || payload.exp - payload.iat > DELEGATION_MAX_LIFETIME_S || typeof payload.jti !== 'string'
    || payload.jti.length > 128 || typeof payload.sub !== 'string' || !payload.sub.trim()) {
    throw new AuthError('The current customer isn\'t authorized.', 'graphql-authentication');
  }
  const replays = store.collection('delegation_jti');
  if (await replays.findOne({ jti: payload.jti })) {
    throw new AuthError('The current customer isn\'t authorized.', 'graphql-authentication');
  }
  await replays.insertOne({ jti: payload.jti, exp: payload.exp });
  // opportunistic pruning keeps the replay window small without a scheduled job
  if (Math.random() < 0.05) await replays.deleteMany({ exp: { $lt: now - 60 } }).catch(() => {});
  return payload;
}

/** The reviewed order a delegated placeOrder must match: { grand_total, items: [[sku, qty]] }. */
function orderExpectation(claim) {
  if (claim === undefined) return undefined;
  const items = claim?.items;
  if (!claim || typeof claim !== 'object' || !Number.isFinite(claim.grand_total)
    || !Array.isArray(items) || items.length > 100 || !items.every((i) => Array.isArray(i)
      && i.length === 2 && typeof i[0] === 'string' && Number.isInteger(i[1]) && i[1] > 0)) {
    throw new AuthError('The current customer isn\'t authorized.', 'graphql-authentication');
  }
  return { grand_total: claim.grand_total, items };
}

async function resolveDelegatedCustomer(token, params, store) {
  const claims = await verifyDelegation(token, params, store);
  const orderExpect = orderExpectation(claims.order_expect);
  const customers = store.collection('customers');
  const existing = await customers.findOne({ sub: claims.sub });
  if (existing) {
    return {
      ...existing, token, delegated: true, orderExpect,
    };
  }
  // First sign-in happened in ChatGPT: create the customer; the website refreshes the
  // Auth0 profile on its next sign-in (profileFetchedAt: 0), as it does for new customers.
  const now = new Date().toISOString();
  const email = typeof claims.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(claims.email)
    ? claims.email : null;
  await customers.updateOne(
    { sub: claims.sub },
    {
      $setOnInsert: {
        sub: claims.sub,
        id: claims.sub,
        email: email || `${claims.sub.replace(/[^a-z0-9]/gi, '')}@users.wknd.example`,
        firstname: '',
        lastname: '',
        picture: null,
        addresses: [],
        profileFetchedAt: 0,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
  return {
    ...(await customers.findOne({ sub: claims.sub })), token, delegated: true, orderExpect,
  };
}

/**
 * Resolves the signed-in customer for a request, or null for guests.
 * Invalid/expired tokens raise a graphql-authorization error (the drop-ins clear the session).
 */
async function resolveCustomer({
  headers, params, store, verify = verifyToken,
}) {
  const token = bearer(headers);
  if (!token) return null;
  if (isDelegated(headers)) return resolveDelegatedCustomer(token, params, store);
  let claims;
  try {
    claims = await verify(token, params);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    // Commerce semantics: a bad/expired token is an *authentication* error — the auth drop-in
    // clears its session cookie when it sees this category.
    throw new AuthError('The current customer isn\'t authorized.', 'graphql-authentication');
  }
  const customers = store.collection('customers');
  let customer = await customers.findOne({ sub: claims.sub });
  const stale = !customer || !customer.email || Date.now() - (customer.profileFetchedAt || 0) > 86400000;
  if (stale) {
    const info = claims.email ? claims : await fetchUserInfo(token, params);
    const now = new Date().toISOString();
    const profile = {
      email: info.email || customer?.email || `${claims.sub.replace(/[^a-z0-9]/gi, '')}@users.wknd.example`,
      ...splitName(info),
      picture: info.picture || null,
      emailIdentityVerified: info.sub === claims.sub && info.email_verified === true
        && typeof info.email === 'string',
      profileFetchedAt: Date.now(),
      updatedAt: now,
    };
    if (customer?.firstname) profile.firstname = customer.firstname;
    if (customer?.lastname) profile.lastname = customer.lastname;
    await customers.updateOne(
      { sub: claims.sub },
      {
        $set: profile,
        $setOnInsert: {
          sub: claims.sub, createdAt: now, addresses: [], id: claims.sub,
        },
      },
      { upsert: true },
    );
    customer = await customers.findOne({ sub: claims.sub });
  }
  return { ...customer, token };
}

function requireCustomer(ctx) {
  if (ctx.authError) throw ctx.authError;
  if (!ctx.customer) throw new AuthError('The current customer isn\'t authorized.');
  return ctx.customer;
}

module.exports = {
  AuthError,
  bearer,
  authConfig,
  verifyToken,
  verifyDelegation,
  delegationKeys,
  resolveCustomer,
  requireCustomer,
  splitName,
  DELEGATION_AUDIENCE,
  DELEGATION_SCOPE,
};
