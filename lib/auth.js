/**
 * Customer authentication — reuses the WKND Aero Auth0 tenant and API audience.
 * Mirrors workers/wknd-aero-api/src/booking-auth.js: RS256 access token validated against
 * the tenant JWKS, issuer and audience. The customer record is keyed by the token `sub`;
 * profile fields come from Auth0 /userinfo (cached on the customer document).
 */
const { createRemoteJWKSet, jwtVerify } = require('jose');

const keySets = new Map();

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

/**
 * Resolves the signed-in customer for a request, or null for guests.
 * Invalid/expired tokens raise a graphql-authorization error (the drop-ins clear the session).
 */
async function resolveCustomer({ headers, params, store, verify = verifyToken }) {
  const token = bearer(headers);
  if (!token) return null;
  let claims;
  try {
    claims = await verify(token, params);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new AuthError('The current customer isn\'t authorized.');
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
  AuthError, bearer, authConfig, verifyToken, resolveCustomer, requireCustomer, splitName,
};
