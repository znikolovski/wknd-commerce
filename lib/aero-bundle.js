const crypto = require('node:crypto');
const { SignJWT } = require('jose');
const { isDuplicateKeyError } = require('./store');
const { bundleId, QUOTE_MS } = require('./bundles');

const MANAGEMENT_CLASS = 'protected-aero-booking';
const DAY = 24 * 60 * 60 * 1000;
const API_ORIGIN = 'https://wknd-aero-api.jaggah.workers.dev';
const ASSERTION_ISSUER = 'urn:wknd-commerce:storefront';
const COMPONENTS = Object.freeze([
  { sku: 'WKND-HYD-002', quantity: 1, name: 'Collapsible Bottle 1L' },
  { sku: 'WKND-LGT-001', quantity: 1, name: 'Alpine Start Headlamp 400' },
  { sku: 'WKND-TRV-009', quantity: 1, name: 'Wilderness First Aid Kit' },
]);
const NAME = 'Adventure Essentials — confirmed demo flight';
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const promotionId = (key) => `prm_${hash(['aero-bundle', key]).slice(0, 32)}`;
const enabled = (params) => params.AERO_BUNDLE_ENABLED === 'true';

class AeroBundleError extends Error {
  constructor(message, code = 'AERO_BUNDLE_UNAVAILABLE') {
    super(message);
    this.extensions = { category: 'graphql', code };
    this.code = code;
  }
}

function createAeroBundle({ store, params = {}, clock = Date.now, fetchImpl = fetch }) {
  const entitlements = () => store.collection('aero_bundle_entitlements');
  const redemptions = () => store.collection('aero_bundle_redemptions');
  const keyFor = (customer, bookingId) => hash(['aero-bundle/v1', params.AUTH0_ISSUER, customer.sub, bookingId]);
  const invalid = (bookingId, reason = 'BOOKING_NOT_ELIGIBLE') => ({
    status: 'INELIGIBLE', reason, booking_id: bookingId, components: [],
  });

  async function bookingFor(customer, bookingId) {
    if (!customer?.sub) throw new AeroBundleError('Sign in to check the flight offer.', 'AERO_BUNDLE_SIGN_IN_REQUIRED');
    if (!/^BK_[0-9a-f]{16}$/.test(bookingId)) throw new AeroBundleError('Invalid booking reference.', 'AERO_BUNDLE_INVALID_BOOKING');
    const secret = params.WKND_BOOKING_ASSERTION_SECRET;
    if (!params.AUTH0_ISSUER || typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new AeroBundleError('Flight offer verification is not configured.');
    }
    const origin = new URL(API_ORIGIN);
    const now = Math.floor(clock() / 1000);
    const assertion = await new SignJWT({
      identity_issuer: params.AUTH0_ISSUER, scope: 'bookings:read',
    }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(ASSERTION_ISSUER)
      .setAudience(origin.origin).setSubject(customer.sub).setIssuedAt(now).setExpirationTime(now + 60)
      .setJti(crypto.randomUUID()).sign(new TextEncoder().encode(secret));
    let response;
    try {
      response = await fetchImpl(new URL(`/api/bookings/${bookingId}`, origin), {
        method: 'GET',
        headers: { Authorization: `Bearer ${assertion}`, 'X-WKND-Delegation': 'commerce' },
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
    } catch {
      throw new AeroBundleError('Flight booking verification is temporarily unavailable.');
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new AeroBundleError('Flight booking verification is temporarily unavailable.');
    let booking;
    try {
      booking = await response.json();
    } catch {
      throw new AeroBundleError('Flight booking verification returned an invalid response.');
    }
    const created = Date.parse(booking?.createdAt);
    if (booking?.id !== bookingId || booking.status !== 'confirmed' || booking.demo !== true
      || !Number.isFinite(created) || created > clock() || clock() >= created + 7 * DAY) return null;
    return { createdAt: booking.createdAt, expiresAtMs: created + 7 * DAY };
  }

  async function inspect(customer, bookingId) {
    if (!enabled(params)) return { dto: invalid(bookingId, 'OFFER_DISABLED') };
    const booking = await bookingFor(customer, bookingId);
    if (!booking) return { dto: invalid(bookingId) };
    const key = keyFor(customer, bookingId);
    const [entitlement, redeemed] = await Promise.all([
      entitlements().findOne({ _id: key }),
      redemptions().findOne({ _id: key }),
    ]);
    if (entitlement && (entitlement.bookingCreatedAt !== booking.createdAt || entitlement.expiresAtMs !== booking.expiresAtMs)) {
      throw new AeroBundleError('Flight booking changed; the existing offer cannot be reused.');
    }
    return {
      key, booking, entitlement,
      dto: {
        status: redeemed ? 'REDEEMED' : (entitlement ? 'CLAIMED' : 'ELIGIBLE'),
        reason: null, booking_id: bookingId, promotion_id: promotionId(key),
        bundle_id: bundleId(COMPONENTS), name: NAME, percent_off: 50,
        expires_at: new Date(booking.expiresAtMs).toISOString(),
        components: COMPONENTS.map((c) => ({ ...c })),
      },
    };
  }

  async function offer(customer, bookingId, { claim = false } = {}) {
    const result = await inspect(customer, bookingId);
    if (claim && result.dto.status === 'ELIGIBLE') {
      try {
        await entitlements().insertOne({
          _id: result.key, key: result.key, customerSub: customer.sub, identityIssuer: params.AUTH0_ISSUER,
          bookingId, bookingCreatedAt: result.booking.createdAt, expiresAtMs: result.booking.expiresAtMs,
          issuedAt: new Date(clock()).toISOString(),
        });
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
      }
      return (await inspect(customer, bookingId)).dto;
    }
    return result.dto;
  }

  async function candidates(customer, cart) {
    if (!enabled(params) || !customer?.sub || cart?.customerSub !== customer.sub) return [];
    const grants = await entitlements().find({
      customerSub: customer.sub, identityIssuer: params.AUTH0_ISSUER, expiresAtMs: { $gt: clock() },
    }, { limit: 21 });
    if (grants.length > 20) throw new AeroBundleError('Too many active flight offers to verify safely.');
    const verified = await Promise.all(grants.map(async (grant) => {
      const current = await inspect(customer, grant.bookingId);
      if (current.dto.status !== 'CLAIMED' || current.key !== grant.key) return null;
      return {
        id: promotionId(grant.key), revision: 1, enabled: true, mode: 'automatic', code: null,
        name: NAME, managementClass: MANAGEMENT_CLASS,
        discount: { kind: 'percentage', basisPoints: 5000 }, maxDiscountMinor: null, minimumMerchandiseMinor: null,
        startsAt: grant.bookingCreatedAt, endsAt: new Date(grant.expiresAtMs).toISOString(), audienceRestriction: null,
        target: {
          kind: 'bundle', bundleId: bundleId(COMPONENTS), experimentId: null, currency: 'AUD',
          quoteExpiresAt: new Date(clock() + QUOTE_MS).toISOString(), safetyBuffer: 0,
          components: COMPONENTS.map(({ sku, quantity }) => ({ sku, quantity, unitPriceMinor: 1 })),
        },
        private: { aeroBookingId: grant.bookingId, aeroEntitlementKey: grant.key },
      };
    }));
    return verified.filter(Boolean);
  }

  async function reserveRedemption({ customer, promotion, cartId }) {
    const result = await inspect(customer, promotion.private?.aeroBookingId);
    if (result.dto.status !== 'CLAIMED' || promotion.id !== promotionId(result.key)) {
      throw new AeroBundleError('The flight offer is no longer available.', 'AERO_BUNDLE_NOT_ELIGIBLE');
    }
    try {
      await redemptions().insertOne({
        _id: result.key, key: result.key, cartId, state: 'reserved',
        reservedAt: new Date(clock()).toISOString(),
      });
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
      throw new AeroBundleError('The flight offer has already been used.', 'AERO_BUNDLE_ALREADY_REDEEMED');
    }
    return {
      release: () => redemptions().deleteOne({ _id: result.key, cartId, state: 'reserved' }),
      confirm: (orderNumber) => redemptions().updateOne({ _id: result.key, cartId, state: 'reserved' }, {
        $set: { state: 'redeemed', orderNumber, redeemedAt: new Date(clock()).toISOString() },
      }),
    };
  }

  return { offer, candidates, reserveRedemption };
}

module.exports = {
  createAeroBundle, MANAGEMENT_CLASS, COMPONENTS, AeroBundleError,
};
