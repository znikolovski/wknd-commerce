const crypto = require('node:crypto');
const { createServerCartFacts, FACT_SCHEMA, CartFactsError } = require('./server-cart-facts');
const { createBindingStore } = require('./target-binding-store');
const { createIdLinkageConsentSource } = require('./id-linkage-consent');
const { shopperKey } = require('./recovery-policy');
const { sha256, canonicalJson } = require('./promotion-schema');
const { serverConfig, baseGate, decideGate } = require('./target-diagnostic-action');
const { PARTNER } = require('./target-id-retirement');
const { STAGE_NAMESPACE } = require('./stage-planner-release');

const TIMEOUT_MS = 2000;
const LEASE_MS = 8000;
const MAX_AGE_MS = 30000;
const MAX_TERMINAL_EPISODES = 128;
const FIELD_MAP = Object.freeze({
  environment: 'environment',
  observed_at: 'observedAt',
  cart_state: 'cart.state',
  cart_version: 'cart.version',
  cart_last_activity_at: 'cart.lastActivityAt',
  cart_activity_source: 'cart.activitySource',
  cart_item_count: 'cart.itemCount',
  cart_total_quantity: 'cart.totalQuantity',
  purchase_since_last_activity: 'purchase.sinceLastActivity',
  purchase_last_order_at: 'purchase.lastOrderAt',
  purchase_order_state: 'purchase.orderState',
  episode_key: 'episode.key',
  episode_started_at: 'episode.startedAt',
});

function mapStageCartFacts(packet) {
  if (packet?.schema !== FACT_SCHEMA || packet.environment !== 'stage') {
    throw new CartFactsError('FACT_SCOPE', 'Server fact scope is unavailable.');
  }
  return Object.fromEntries(Object.entries(FIELD_MAP).flatMap(([name, field]) => {
    const value = field.split('.').reduce((current, key) => current?.[key], packet);
    return value === null || value === undefined ? [] : [[`c_wknd_stage_${name}`, String(value)]];
  }));
}

/**
 * Facts-only Stage collection. Reuses a fresh existing binding; never issues an ID, grants consent,
 * evaluates membership or constructs a Target marker. Caller data cannot supply packets/identities.
 */
function createStageCartFactService({
  enabled = false, params = {}, store, claims, namespace = process.env.__OW_NAMESPACE,
  fetchImpl = fetch, now = Date.now, report = () => {},
} = {}) {
  const config = serverConfig(params, namespace);
  const key = claims?.sub ? shopperKey(config.AUTH0_ISSUER, claims.sub) : null;
  const configured = enabled === true && namespace === STAGE_NAMESPACE
    && config.TARGET_DIAG_ENVIRONMENT === 'stage' && config.TARGET_DIAG_STAGE_NAMESPACE === namespace
    && config.TARGET_ID_ORG_ID === PARTNER.orgId && config.TARGET_ID_DPID === '1547309'
    && !baseGate(config) && !decideGate(config)
    && Boolean(key) && String(config.TARGET_DIAG_SHOPPER_KEYS).split(',').map((s) => s.trim()).includes(key);
  const fail = (code) => { throw new CartFactsError(code, 'Server fact handoff is unavailable.'); };
  const bindingStore = configured ? createBindingStore(store) : null;
  const consent = configured ? createIdLinkageConsentSource(store, { issuer: config.AUTH0_ISSUER }) : null;
  const reader = () => createServerCartFacts({ store, claims, environment: 'stage', clock: now });

  async function binding(expected) {
    const purpose = await consent.lookup({ shopperKey: key, sub: claims.sub });
    const current = await bindingStore.get(key);
    const record = current?.record;
    if (purpose?.state !== 'granted' || record?.state !== 'bound'
      || record.consentGrantId !== purpose.grantId || record.subject !== sha256(claims.sub)
      || record.shopperKey !== key || record.orgId !== PARTNER.orgId || record.dpid !== '1547309'
      || record.ecidSource !== 'server-issued' || !/^\d{38}$/.test(record.ecid || '')
      || !Number.isInteger(record.locationHint) || record.locationHint < 1
      || typeof record.blob !== 'string' || !record.blob || Buffer.byteLength(record.blob) > 1024
      || !Number.isFinite(record.resyncAt) || record.resyncAt - now() <= LEASE_MS
      || (expected && (current.etag !== expected.etag || record.ecid !== expected.record.ecid
        || record.consentGrantId !== expected.record.consentGrantId
        || record.factHandoff?.state !== 'sending' || record.factHandoff.leaseUntil <= now()))) fail('BINDING_CHANGED');
    return current;
  }

  async function fresh(packet, cartId) {
    const observed = Date.parse(packet.observedAt);
    if (!Number.isFinite(observed) || observed > now() || now() - observed > MAX_AGE_MS) fail('FACT_STALE');
    if (['merging', 'merged'].includes(packet.cart.state)) fail('EPISODE_TERMINAL');
    const actual = await reader().read(cartId);
    const withoutTime = ({ observedAt: _time, ...facts }) => facts;
    if (canonicalJson(withoutTime(actual)) !== canonicalJson(withoutTime(packet))) fail('FACT_CHANGED');
  }

  async function send(packet, cartId) {
    await fresh(packet, cartId);
    const current = await binding();
    const previous = current.record.factHandoff;
    if (current.record.factTerminalEpisodes?.includes(packet.episode.key)) fail('EPISODE_TERMINAL');
    if (previous?.state === 'sending' && previous.leaseUntil > now()) fail('HANDOFF_BUSY');
    if (previous && Date.parse(previous.observedAt) > Date.parse(packet.observedAt)) fail('FACT_STALE');
    const handoff = {
      state: 'sending', attemptId: crypto.randomUUID(), observedAt: packet.observedAt,
      episodeKey: packet.episode.key, cartVersion: packet.cart.version, leaseUntil: now() + LEASE_MS,
    };
    const etag = await bindingStore.put(key, { ...current.record, factHandoff: handoff }, { ifMatch: current.etag });
    if (!etag) fail('HANDOFF_BUSY');
    const owner = { etag, record: current.record };
    let acknowledged = false;
    try {
      await fresh(packet, cartId);
      await binding(owner);
      if (handoff.leaseUntil - now() <= TIMEOUT_MS) fail('FACT_STALE');
      const url = new URL(`https://${PARTNER.host}/event`);
      url.searchParams.set('d_mid', current.record.ecid);
      url.searchParams.set('d_orgid', PARTNER.orgId);
      url.searchParams.set('d_rtbd', 'json');
      url.searchParams.set('d_jsonv', '0');
      Object.entries(mapStageCartFacts(packet)).forEach(([name, value]) => url.searchParams.set(name, value));
      // Declared identity is reserved transport data, never a customer-defined fact attribute.
      const endpoint = claims.delegated ? url.href
        : `${url.href}&d_cid=1547309%01${encodeURIComponent(claims.sub)}%011`;
      const response = await fetchImpl(endpoint, {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = response.ok ? await response.json() : null;
      if (!body || Array.isArray(body) || !/^\d{38}$/.test(body.uuid || '')
        || response.headers?.get?.('x-error')
        || (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length))) fail('DCS_NOT_ACKNOWLEDGED');
      await fresh(packet, cartId);
      await binding(owner);
      acknowledged = true;
      return true;
    } finally {
      const latest = await bindingStore.get(key);
      if (latest?.etag === etag && latest.record.state === 'bound') {
        const released = await bindingStore.put(key, {
          ...latest.record, factHandoff: { ...handoff, state: acknowledged ? 'acknowledged' : 'unknown' },
        }, { ifMatch: etag });
        if (acknowledged && !released) fail('BINDING_CHANGED');
      } else if (acknowledged) {
        fail('BINDING_CHANGED');
      }
    }
  }

  async function safely(operation) {
    if (!configured) return { status: 'disabled' };
    try {
      await operation();
      return { status: 'acknowledged' };
    } catch (error) {
      const reason = error instanceof CartFactsError ? error.code : 'HANDOFF_UNAVAILABLE';
      try { report({ status: 'unavailable', reason }); } catch { /* reporting cannot undo a business write */ }
      return { status: 'unavailable', reason };
    }
  }

  async function handoff(cartId) {
    const facts = createServerCartFacts({
      store, claims, environment: 'stage', clock: now, publisher: (packet) => send(packet, cartId),
    });
    return facts.handoff(cartId);
  }

  async function closeSource(sourceId, destinationId) {
    const source = await store.collection('carts').findOne({ id: sourceId, customerSub: claims.sub });
    const destination = await store.collection('carts').findOne({ id: destinationId, customerSub: claims.sub });
    if (!source || source.status !== 'merged' || source.mergedInto !== destinationId
      || !destination?.mergedSources?.includes(sourceId)) return;
    const packet = await reader().read(sourceId);
    if (!packet.episode.key) return;
    const current = await binding();
    const terminal = current.record.factTerminalEpisodes || [];
    if (terminal.includes(packet.episode.key)) return;
    if (terminal.length >= MAX_TERMINAL_EPISODES) fail('TERMINAL_LEDGER_FULL');
    const next = { ...current.record, factTerminalEpisodes: [...terminal, packet.episode.key] };
    if (next.factHandoff?.episodeKey === packet.episode.key) {
      next.factHandoff = { ...next.factHandoff, state: 'suppressed' };
    }
    if (!await bindingStore.put(key, next, { ifMatch: current.etag })) fail('BINDING_CHANGED');
  }

  return {
    configured,
    handoff: (cartId) => safely(() => handoff(cartId)),
    afterMerge: async (sourceId, destinationId) => {
      const terminal = await safely(() => closeSource(sourceId, destinationId));
      const destination = await safely(() => handoff(destinationId));
      return { terminal, destination };
    },
    afterOrder: async (cartId) => {
      const receipts = [await safely(() => handoff(cartId))];
      if (!configured) return { status: 'disabled' };
      await safely(async () => {
        const active = await store.collection('carts').find({ customerSub: claims.sub, status: 'active' });
        // Each handoff performs its own fresh owner/cart/order/grant/binding checks.
        /* eslint-disable no-await-in-loop */
        for (const cart of active) {
          if (cart.id !== cartId) receipts.push(await safely(() => handoff(cart.id)));
        }
        /* eslint-enable no-await-in-loop */
      }).then((receipt) => {
        if (receipt.status !== 'acknowledged') receipts.push(receipt);
      });
      return { status: receipts.every((receipt) => receipt.status === 'acknowledged') ? 'acknowledged' : 'unavailable', receipts };
    },
  };
}

module.exports = { FIELD_MAP, mapStageCartFacts, createStageCartFactService };
