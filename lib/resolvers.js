/**
 * GraphQL resolvers for the merged storefront schema (Core + Catalog Service).
 * Object shapes are produced by lib/* mappers; graphql-js resolves interface/union types
 * from each object's `__typename`, and default field resolvers handle plain properties.
 */
const {
  isNonNullType, isScalarType, isEnumType, getNamedType,
} = require('graphql');
const config = require('./config');
const catalog = require('./catalog');
const search = require('./search');
const recs = require('./recommendations');
const { triggerPrerender } = require('./invoke');
const cartLib = require('./cart');
const orders = require('./orders');
const customers = require('./customers');
const { requireCustomer } = require('./auth');
const { loadPromotionRuntime } = require('./promotions');
const { normalizeCode } = require('./promotion-schema');
const { createRecovery, POLICY_V1 } = require('./recovery-policy');
const recoveryEmail = require('./recovery-email');
const { discoverProducts } = require('./of1-discovery');

const { CartError } = cartLib;

class NotSupportedError extends Error {
  constructor(feature) {
    super(`${feature} is not available in the WKND demo store.`);
    this.extensions = { category: 'graphql-input' };
  }
}

const unsupported = (feature) => () => {
  throw new NotSupportedError(feature);
};

/** Defaults for non-null scalar fields we don't explicitly model (keeps StoreConfig valid). */
function withScalarDefaults(schema, typeName, obj) {
  const type = schema.getType(typeName);
  const out = { ...obj };
  Object.values(type.getFields()).forEach((f) => {
    if (out[f.name] !== undefined || !isNonNullType(f.type)) return;
    const named = getNamedType(f.type);
    if (isEnumType(named)) out[f.name] = named.getValues()[0].value;
    else if (isScalarType(named)) {
      out[f.name] = ({
        Boolean: false, Int: 0, Float: 0, String: '', ID: '',
      })[named.name] ?? null;
    }
  });
  return out;
}

const imagesResolver = (obj, { roles }) => catalog.filterImages(obj.allImages || [], roles);
const attributesResolver = (obj, { roles, names }) => (obj.attributeList || [])
  .filter((a) => !roles?.length || a.roles?.some((r) => roles.includes(r)))
  .filter((a) => !names?.length || names.includes(a.name));

/** Products an order sold out get their PDP re-rendered (stock line + JSON-LD availability). */
async function rerenderSoldOut(ctx, items) {
  const skus = orders.soldOutBy(ctx.cat, items || []);
  if (skus.length) await triggerPrerender(ctx.params, skus).catch(() => {});
}

async function cartFor(ctx, cartId, opts) {
  const cart = await cartLib.loadCart(ctx.store, cartId, ctx.customer, opts);
  return cart;
}

/** Current promotion definitions and server-side trust decisions for one cart. */
const runtimeFor = (ctx, cart, codes) => loadPromotionRuntime(ctx.store, {
  params: ctx.params, customer: ctx.customer, cart, codes,
});

async function shapeCart(ctx, cart) {
  return cartLib.cartShape(ctx.cat, cart, await runtimeFor(ctx, cart));
}

/** Coupon writes apply only to the cart revision they were evaluated against (no lost updates). */
const COUPON_WRITE = { expectRevision: true };

async function respondCart(ctx, cart, saveOptions) {
  const saved = await cartLib.saveCart(ctx.store, cart, saveOptions);
  return shapeCart(ctx, saved);
}

function recoveryOfferShape(result, comparison = null) {
  const p = result.promotion;
  const available = ['ELIGIBLE', 'CLAIMED'].includes(result.status);
  const money = (minor) => (available && comparison ? config.money(minor / 100) : null);
  return {
    status: result.status,
    reason: result.reason || null,
    coupon_code: available && p ? p.code : null,
    percent_off: available ? POLICY_V1.basisPoints / 100 : null,
    max_discount: available ? config.money(POLICY_V1.capMinor / 100) : null,
    expires_at: available ? result.expiresAt || null : null,
    saving: money(comparison?.candidateMinor),
    current_saving: money(comparison?.currentMinor),
  };
}

/** Engine-computed savings of the offer versus the cart's current promotion (display only). */
async function recoveryComparison(ctx, cart, code) {
  const runtime = await runtimeFor(ctx, cart, [...(cart.coupons || []), code]);
  return cartLib.compareCoupon(ctx.cat, cart, runtime, code, () => ({ ok: true, capMinor: POLICY_V1.capMinor }));
}

async function recoveryOffer(ctx, cartId, { claim = false } = {}) {
  const customer = requireCustomer(ctx);
  const cart = await cartFor(ctx, cartId);
  const rec = createRecovery({ store: ctx.store, params: ctx.params });
  const result = claim ? await rec.claim({ customer, cart }) : await rec.offerStatus({ customer, cart });
  const available = ['ELIGIBLE', 'CLAIMED'].includes(result.status) && result.promotion?.code;
  const comparison = available ? await recoveryComparison(ctx, cart, result.promotion.code).catch(() => null) : null;
  return recoveryOfferShape(result, comparison);
}

const PROTECTED = 'protected-recovery';
const isProtectedCode = (runtime, code) => !!code && runtime.definitions
  .some((p) => p.managementClass === PROTECTED && p.mode === 'coupon' && p.code === code);

/**
 * Applies the signed-in shopper's recovery offer to exactly the cart state they reviewed
 * (expected_cart_version), and only when the shared engine says it saves strictly more than the
 * cart's current promotion. The write is conditioned on that same revision, so a better coupon
 * applied by another channel after the review is never replaced.
 */
async function applyRecoveryOffer(ctx, { cart_id: cartId, expected_cart_version: expected }) {
  const customer = requireCustomer(ctx);
  const cart = await cartFor(ctx, cartId);
  cartLib.assertCartVersion(cart, expected);
  const rec = createRecovery({ store: ctx.store, params: ctx.params });
  let result = await rec.offerStatus({ customer, cart });
  const code = ['ELIGIBLE', 'CLAIMED'].includes(result.status) ? result.promotion?.code : null;
  if (!code) throw new CartError('This offer isn\'t available for this cart.', 'RECOVERY_OFFER_UNAVAILABLE');
  if (cart.coupons?.[0] === code) return { outcome: 'ALREADY_APPLIED', cart: await shapeCart(ctx, cart) };
  const comparison = await recoveryComparison(ctx, cart, code).catch(() => null);
  if (!comparison) throw new CartError('This offer isn\'t available for this cart.', 'RECOVERY_OFFER_UNAVAILABLE');
  if (comparison.candidateMinor <= comparison.currentMinor) {
    throw new CartError('Your cart already has an equal or better saving.', 'OFFER_NOT_BETTER');
  }
  if (result.status === 'ELIGIBLE') result = await rec.claim({ customer, cart });
  if (result.status !== 'CLAIMED') throw new CartError('This offer isn\'t available for this cart.', 'RECOVERY_OFFER_UNAVAILABLE');
  cartLib.applyCoupons(cart, [code], ctx.cat, await runtimeFor(ctx, cart, [code]));
  return { outcome: 'APPLIED', cart: await respondCart(ctx, cart, COUPON_WRITE) };
}

/**
 * Removes the protected recovery coupon from exactly the reviewed cart state. Any other applied
 * coupon is left alone (NOT_APPLIED, no write). Entitlements and redemptions are not touched.
 */
async function removeRecoveryOffer(ctx, { cart_id: cartId, expected_cart_version: expected }) {
  requireCustomer(ctx);
  const cart = await cartFor(ctx, cartId);
  cartLib.assertCartVersion(cart, expected);
  const current = cart.coupons?.[0];
  if (!isProtectedCode(await runtimeFor(ctx, cart), current)) {
    return { outcome: 'NOT_APPLIED', cart: await shapeCart(ctx, cart) };
  }
  cart.coupons = [];
  return { outcome: 'REMOVED', cart: await respondCart(ctx, cart, COUPON_WRITE) };
}

/** Delegated agents may apply a protected offer only through the reviewed-version mutation. */
async function assertNotDelegatedProtected(ctx, cart, codes) {
  if (!ctx.customer?.delegated) return;
  const runtime = await runtimeFor(ctx, cart, codes);
  const wanted = codes.map((c) => normalizeCode(String(c)));
  if (wanted.some((c) => isProtectedCode(runtime, c))) {
    throw new CartError('Apply this offer with applyWkndRecoveryOffer and the reviewed cart version.', 'REVIEWED_VERSION_REQUIRED');
  }
}

const CONSENT_SOURCE = { WEB: 'account-settings', IOS: 'ios' };

function setConsent(ctx, purpose, { opt_in: optIn, wording_version: wordingVersion = null, source = 'WEB' }) {
  return recoveryEmail.setMarketingConsent(ctx.store, requireCustomer(ctx), purpose, optIn, {
    source: CONSENT_SOURCE[source] || 'account-settings', wordingVersion,
  });
}

function buildResolvers(schema) {
  const storeConfig = withScalarDefaults(schema, 'StoreConfig', config.storeConfig());

  return {
    SimpleProductView: { images: imagesResolver, attributes: attributesResolver },
    ComplexProductView: { images: imagesResolver, attributes: attributesResolver },

    Customer: {
      orders: (obj, args, ctx) => orders.customerOrders(ctx.store, ctx.cat, obj._record, {
        pageSize: args.pageSize, currentPage: args.currentPage, filter: args.filter, sort: args.sort,
      }),
      addressesV2: (obj) => obj.addressesV2,
      wknd_recovery_email_opt_in: (obj) => recoveryEmail.isOptedIn(obj._record),
      wknd_marketing_email_opt_in: (obj) => recoveryEmail.hasConsent(obj._record, 'audience'),
    },

    Query: {
      of1Discovery: (_, args, ctx) => discoverProducts(ctx.cat, args),
      /* ---- Catalog Service ---- */
      products: (_, { skus = [] }, ctx) => (skus || []).map((sku) => catalog.viewForSku(ctx.cat, sku)).filter(Boolean),
      refineProduct: (_, { sku, optionIds }, ctx) => catalog.refine(ctx.cat, sku, optionIds),
      variants: (_, args, ctx) => search.variants(ctx.cat, args),
      categories: (_, args, ctx) => search.categoryViews(ctx.cat, args),
      productSearch: (_, args, ctx) => search.productSearch(ctx.cat, args),
      attributeMetadata: () => search.attributeMetadata(),
      recommendations: (_, args, ctx) => recs.recommendations(ctx.cat, ctx.store, args),
      recommendationsByUnitIds: (_, args, ctx) => recs.recommendationsByUnitIds(ctx.cat, ctx.store, args),

      /* ---- Core: config & reference data ---- */
      storeConfig: () => storeConfig,
      availableStores: () => [storeConfig],
      countries: () => config.getCountries(),
      country: (_, { id }) => config.getCountries().find((c) => c.id === id) || null,
      attributesForm: (_, { formCode }) => ({
        items: formCode.startsWith('customer_account') ? config.customerFormItems() : config.addressFormItems(),
        errors: [],
      }),
      attributesList: (_, { entityType }) => ({
        items: entityType === 'CUSTOMER' ? config.customerFormItems()
          : entityType === 'CUSTOMER_ADDRESS' ? config.addressFormItems() : [],
        errors: [],
      }),
      checkoutAgreements: () => [],
      isEmailAvailable: () => ({ is_email_available: true }),
      customerPaymentTokens: () => ({ items: [] }),
      dynamicBlocks: () => ({ items: [], page_info: { current_page: 1, page_size: 0, total_pages: 0 }, total_count: 0 }),

      /* ---- Core: carts ---- */
      cart: async (_, { cart_id: cartId }, ctx) => shapeCart(ctx, await cartFor(ctx, cartId)),
      customerCart: async (_, __, ctx) => shapeCart(ctx, await cartLib.getCustomerCart(ctx.store, requireCustomer(ctx))),
      wkndRecoveryOffer: (_, { cart_id: cartId }, ctx) => recoveryOffer(ctx, cartId),

      /* ---- Core: customer & orders ---- */
      customer: (_, __, ctx) => customers.customerShape(requireCustomer(ctx)),
      customerOrders: (_, __, ctx) => orders.customerOrders(ctx.store, ctx.cat, requireCustomer(ctx)),
      guestOrder: async (_, { input }, ctx) => orders.orderShape(ctx.cat, await orders.findGuestOrder(ctx.store, input)),
      guestOrderByToken: async (_, { input }, ctx) => orders.orderShape(ctx.cat, await orders.findOrderByToken(ctx.store, input.token, ctx.customer)),

      /* ---- B2B / not modelled ---- */
      company: () => null,
      negotiableQuote: unsupported('Negotiable quotes'),
    },

    Mutation: {
      createGuestCart: async (_, { input }, ctx) => {
        const cart = await cartLib.createCart(ctx.store, { id: input?.cart_uid });
        return { cart: await shapeCart(ctx, cart) };
      },
      createEmptyCart: async (_, __, ctx) => (ctx.customer
        ? (await cartLib.getCustomerCart(ctx.store, ctx.customer)).id
        : (await cartLib.createCart(ctx.store)).id),

      addProductsToCart: async (_, { cartId, cartItems }, ctx) => {
        const cart = await cartFor(ctx, cartId);
        const userErrors = [];
        cartItems.forEach((input) => {
          const res = cartLib.addItem(ctx.cat, cart, input);
          if (res.error) userErrors.push({ __typename: 'CartUserInputError', ...res.error });
        });
        return { cart: await respondCart(ctx, cart), user_errors: userErrors };
      },
      updateCartItems: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        const errors = cartLib.updateItems(ctx.cat, cart, input.cart_items);
        return { cart: await respondCart(ctx, cart), errors };
      },
      removeItemFromCart: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        cartLib.removeItem(cart, input.cart_item_uid || String(input.cart_item_id));
        return { cart: await respondCart(ctx, cart) };
      },
      mergeCarts: async (_, { source_cart_id: sourceId, destination_cart_id: destId }, ctx) => {
        const customer = requireCustomer(ctx);
        const destination = destId ? await cartFor(ctx, destId) : await cartLib.getCustomerCart(ctx.store, customer);
        const source = await ctx.store.collection('carts').findOne({ id: sourceId });
        if (source && source.status === 'active' && source.id !== destination.id
          && (!source.customerSub || source.customerSub === customer.sub)) {
          cartLib.mergeInto(ctx.cat, source, destination);
          await cartLib.saveCart(ctx.store, { ...source, status: 'merged', mergedInto: destination.id });
        }
        return respondCart(ctx, destination);
      },
      reorderItems: async (_, { orderNumber }, ctx) => {
        const customer = requireCustomer(ctx);
        const order = await ctx.store.collection('orders').findOne({ number: orderNumber, customerSub: customer.sub });
        if (!order) throw new CartError('Order not found', 'UNDEFINED', 'graphql-no-such-entity');
        const cart = await cartLib.getCustomerCart(ctx.store, customer);
        const userInputErrors = [];
        order.items.forEach((i) => {
          const res = cartLib.addItem(ctx.cat, cart, { sku: i.sku, quantity: i.quantity });
          if (res.error) userInputErrors.push({ code: res.error.code === 'INSUFFICIENT_STOCK' ? 'INSUFFICIENT_STOCK' : 'NOT_SALABLE', message: res.error.message, path: ['orderNumber'] });
        });
        return { cart: await respondCart(ctx, cart), userInputErrors };
      },

      setGuestEmailOnCart: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email || '')) throw new CartError('Invalid email format', 'UNDEFINED');
        cart.email = input.email.trim();
        return { cart: await respondCart(ctx, cart) };
      },
      setShippingAddressesOnCart: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        const [entry] = input.shipping_addresses || [];
        if (!entry) throw new CartError('Required parameter "shipping_addresses" is missing', 'UNDEFINED');
        cart.shippingAddress = entry.customer_address_uid || entry.customer_address_id
          ? cartLib.addressFromCustomer(ctx.customer, entry.customer_address_uid || entry.customer_address_id)
          : cartLib.normalizeAddress(entry.address);
        if (ctx.customer && !cart.email) cart.email = ctx.customer.email;
        const methods = cartLib.availableShippingMethods(ctx.cat, cart, cart.shippingAddress.country_code);
        if (!cart.shippingMethod || !methods.some((m) => m.method_code === cart.shippingMethod.method_code)) {
          cart.shippingMethod = methods[0] ? { carrier_code: methods[0].carrier_code, method_code: methods[0].method_code } : null;
        }
        if (cart.billingSameAsShipping) cart.billingAddress = { ...cart.shippingAddress };
        return { cart: await respondCart(ctx, cart) };
      },
      setBillingAddressOnCart: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        const b = input.billing_address || {};
        let address;
        if (b.same_as_shipping) {
          if (!cart.shippingAddress) throw new CartError('Could not use the "same_as_shipping" option, because the shipping address has not been set.', 'UNDEFINED');
          address = { ...cart.shippingAddress };
        } else if (b.customer_address_uid || b.customer_address_id) {
          address = cartLib.addressFromCustomer(ctx.customer, b.customer_address_uid || b.customer_address_id);
        } else {
          address = cartLib.normalizeAddress(b.address);
        }
        cart.billingAddress = address;
        cart.billingSameAsShipping = Boolean(b.same_as_shipping || b.use_for_shipping);
        if (b.use_for_shipping) cart.shippingAddress = { ...address };
        if (ctx.customer && !cart.email) cart.email = ctx.customer.email;
        return { cart: await respondCart(ctx, cart) };
      },
      setShippingMethodsOnCart: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        const [method] = input.shipping_methods || [];
        if (!cart.shippingAddress) throw new CartError('The shipping address is missing. Set the address and try again.', 'UNDEFINED');
        const valid = cartLib.availableShippingMethods(ctx.cat, cart, cart.shippingAddress.country_code)
          .find((m) => m.carrier_code === method?.carrier_code && m.method_code === method?.method_code);
        if (!valid) throw new CartError('Carrier with such method not found', 'UNDEFINED');
        cart.shippingMethod = { carrier_code: valid.carrier_code, method_code: valid.method_code };
        return { cart: await respondCart(ctx, cart) };
      },
      setPaymentMethodOnCart: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        if (input.payment_method?.code !== config.PAYMENT_METHOD.code) throw new CartError('The requested Payment Method is not available.', 'UNDEFINED');
        cart.paymentMethod = config.PAYMENT_METHOD.code;
        return { cart: await respondCart(ctx, cart) };
      },
      applyCouponsToCart: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        const requested = input.type === 'REPLACE' || !input.type ? input.coupon_codes : [...(cart.coupons || []), ...input.coupon_codes];
        await assertNotDelegatedProtected(ctx, cart, requested);
        cartLib.applyCoupons(cart, requested, ctx.cat, await runtimeFor(ctx, cart, requested));
        return { cart: await respondCart(ctx, cart, COUPON_WRITE) };
      },
      applyCouponToCart: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        await assertNotDelegatedProtected(ctx, cart, [input.coupon_code]);
        cartLib.applyCoupons(cart, [input.coupon_code], ctx.cat, await runtimeFor(ctx, cart, [input.coupon_code]));
        return { cart: await respondCart(ctx, cart, COUPON_WRITE) };
      },
      removeCouponFromCart: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        cart.coupons = [];
        return { cart: await respondCart(ctx, cart, COUPON_WRITE) };
      },
      removeCouponsFromCart: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        const remove = (input.coupon_codes || []).map((c) => c.toUpperCase());
        cart.coupons = remove.length ? (cart.coupons || []).filter((c) => !remove.includes(c)) : [];
        return { cart: await respondCart(ctx, cart, COUPON_WRITE) };
      },
      estimateShippingMethods: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        return cartLib.availableShippingMethods(ctx.cat, cart, input.address?.country_code);
      },
      estimateTotals: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        const preview = {
          ...cart,
          shippingAddress: cart.shippingAddress || cartLib.normalizeAddress({
            country_code: input.address?.country_code,
            region_id: input.address?.region?.region_id,
            region_code: input.address?.region?.region_code,
            postcode: input.address?.postcode,
            street: [],
          }),
          shippingMethod: input.shipping_method || cart.shippingMethod,
        };
        return { cart: await shapeCart(ctx, preview) };
      },

      placeOrder: async (_, { input }, ctx) => {
        try {
          const cart = await cartFor(ctx, input?.cart_id);
          const order = await orders.placeOrder(ctx.store, ctx.cat, cart, ctx.customer, await runtimeFor(ctx, cart));
          await rerenderSoldOut(ctx, cart.items);
          return {
            errors: [],
            order: { order_number: order.number, order_id: order.id },
            orderV2: orders.orderShape(ctx.cat, order),
          };
        } catch (e) {
          if (!(e instanceof CartError)) throw e;
          const allowed = ['CART_NOT_FOUND', 'CART_NOT_ACTIVE', 'GUEST_EMAIL_MISSING', 'UNABLE_TO_PLACE_ORDER'];
          return { errors: [{ code: allowed.includes(e.code) ? e.code : 'UNDEFINED', message: e.message }], order: null, orderV2: null };
        }
      },
      setPaymentMethodAndPlaceOrder: async (_, { input }, ctx) => {
        const cart = await cartFor(ctx, input.cart_id);
        if (input.payment_method?.code !== config.PAYMENT_METHOD.code) throw new CartError('The requested Payment Method is not available.', 'UNDEFINED');
        cart.paymentMethod = config.PAYMENT_METHOD.code;
        const saved = await cartLib.saveCart(ctx.store, cart);
        const order = await orders.placeOrder(ctx.store, ctx.cat, saved, ctx.customer, await runtimeFor(ctx, saved));
        await rerenderSoldOut(ctx, cart.items);
        return { errors: [], order: { order_number: order.number, order_id: order.id }, orderV2: orders.orderShape(ctx.cat, order) };
      },

      claimWkndRecoveryOffer: (_, { cart_id: cartId }, ctx) => recoveryOffer(ctx, cartId, { claim: true }),
      applyWkndRecoveryOffer: (_, args, ctx) => applyRecoveryOffer(ctx, args),
      removeWkndRecoveryOffer: (_, args, ctx) => removeRecoveryOffer(ctx, args),
      setWkndRecoveryEmailOptIn: (_, args, ctx) => setConsent(ctx, 'recovery', args),
      setWkndMarketingEmailOptIn: (_, args, ctx) => setConsent(ctx, 'audience', args),

      createCustomerAddress: (_, { input }, ctx) => customers.createAddress(ctx.store, requireCustomer(ctx), input),
      updateCustomerAddress: (_, { id, input }, ctx) => customers.updateAddress(ctx.store, requireCustomer(ctx), id, input || {}),
      deleteCustomerAddress: (_, { id }, ctx) => customers.deleteAddress(ctx.store, requireCustomer(ctx), id),
      updateCustomerV2: async (_, { input }, ctx) => ({
        customer: customers.customerShape(await customers.updateProfile(ctx.store, requireCustomer(ctx), input)),
      }),
      revokeCustomerToken: () => ({ result: true }),
      deletePaymentToken: () => ({ result: false, customerPaymentTokens: { items: [] } }),

      generateCustomerToken: unsupported('Password sign-in (use “Sign in with WKND”)'),
      createCustomerV2: unsupported('Account creation (use “Sign in with WKND”)'),
      createCustomer: unsupported('Account creation (use “Sign in with WKND”)'),
      updateCustomerEmail: unsupported('Changing email (managed by WKND sign-in)'),
      changeCustomerPassword: unsupported('Password changes (managed by WKND sign-in)'),
      requestPasswordResetEmail: unsupported('Password reset (managed by WKND sign-in)'),
      resetPassword: unsupported('Password reset (managed by WKND sign-in)'),
      applyGiftCardToCart: unsupported('Gift cards'),
      removeGiftCardFromCart: unsupported('Gift cards'),
      setGiftOptionsOnCart: unsupported('Gift options'),
      selectFreeGiftForCart: unsupported('Free gifts'),
      cancelOrder: unsupported('Order cancellation'),
      requestGuestOrderCancel: unsupported('Order cancellation'),
      confirmCancelOrder: unsupported('Order cancellation'),
      requestReturn: unsupported('Returns'),
      requestGuestReturn: unsupported('Returns'),
      confirmReturn: unsupported('Returns'),
    },
  };
}

module.exports = { buildResolvers, NotSupportedError, withScalarDefaults };
