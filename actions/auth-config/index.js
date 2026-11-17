/**
 * Public sign-in configuration for the shop — same contract as the WKND Aero worker's
 * GET /api/auth/config, so scripts/wknd-auth.js can use either endpoint.
 */
async function main(params) {
  const { AUTH0_ISSUER: issuer, AUTH0_CLIENT_ID: clientId, AUTH0_AUDIENCE: audience } = params;
  if (!issuer || !clientId || !audience) {
    return { statusCode: 503, body: { error: 'Customer sign-in is not configured.' } };
  }
  return {
    statusCode: 200,
    headers: { 'Cache-Control': 'public, max-age=300' },
    body: { issuer, clientId, audience },
  };
}

exports.main = main;
