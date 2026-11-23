/**
 * The durable order insert is the receipt outbox boundary. Never reprice or require marketing
 * consent. A crashed/ambiguous send is quarantined, not blindly retried.
 */
const { createBrevoClient } = require('./brevo');

const STALE_MS = 10 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

function receiptMessage(order, params) {
  const amount = (n) => `AUD ${Number(n).toFixed(2)}`;
  const t = order.totals;
  return {
    sender: { email: params.ORDER_CONFIRMATION_SENDER_EMAIL, name: params.ORDER_CONFIRMATION_SENDER_NAME },
    to: [{ email: order.email }],
    subject: `WKND demo order confirmation — ${order.number}`,
    textContent: [
      `Thanks for your order ${order.number}.`,
      'Demo order only: no payment was taken and nothing will ship.',
      ...order.items.map((i) => `${i.name} (${i.sku}) × ${i.quantity}: ${amount(i.rowTotal)}`),
      `Subtotal (incl. GST): ${amount(t.subtotalIncl)}`,
      `Discount: ${amount(t.discountTotal)}`,
      `Shipping: ${amount(t.shipping)}`,
      `GST (included): ${amount(t.tax)}`,
      `Total: ${amount(t.grandTotal)}`,
    ].join('\n'),
    tags: ['wknd-order-confirmation'],
  };
}

function receiptConfigured(params) {
  return params.ORDER_CONFIRMATION_ENABLED === 'true'
    && Boolean(params.BREVO_API_KEY)
    && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(params.ORDER_CONFIRMATION_SENDER_EMAIL || '')
    && Boolean(params.ORDER_CONFIRMATION_SENDER_NAME);
}

async function sendOrderConfirmations({
  store, params = {}, clock = Date.now, createClient = createBrevoClient,
}) {
  if (!receiptConfigured(params)) return { state: 'not-configured' };
  const orders = store.collection('orders');
  const stale = await orders.find({
    'emailConfirmation.state': 'sending',
    'emailConfirmation.claimedAtMs': { $lt: clock() - STALE_MS },
  }, { limit: 50 });
  await Promise.all(stale.map((o) => orders.updateOne(
    { id: o.id, 'emailConfirmation.state': 'sending' },
    { $set: { 'emailConfirmation.state': 'unknown' } },
  )));
  const pending = await orders.find({ 'emailConfirmation.state': 'pending' }, { sort: { createdAt: 1 }, limit: 50 });
  const brevo = createClient({ apiKey: params.BREVO_API_KEY });
  const result = { state: 'completed', sent: 0, deferred: 0, failed: 0, unknown: stale.length };
  for (const order of pending) {
    /* eslint-disable no-await-in-loop */
    if (order.emailConfirmation.retryAtMs > clock()) continue;
    const claimed = await orders.updateOne(
      {
        id: order.id,
        'emailConfirmation.state': 'pending',
        'emailConfirmation.retryAtMs': order.emailConfirmation.retryAtMs ?? { $exists: false },
      },
      { $set: { 'emailConfirmation.state': 'sending', 'emailConfirmation.claimedAtMs': clock() } },
    );
    if (claimed?.matchedCount !== 1) continue;
    let update;
    try {
      const { messageId } = await brevo.sendEmail(receiptMessage(order, params));
      update = { state: 'sent', messageId, sentAt: new Date(clock()).toISOString() };
      result.sent += 1;
    } catch (e) {
      if (e.ambiguous) {
        update = { state: 'unknown' };
        result.unknown += 1;
      } else if (e.status === 429) {
        update = { state: 'pending', retryAtMs: clock() + RETRY_MS };
        result.deferred += 1;
      } else {
        update = { state: 'failed', status: e.status || null };
        result.failed += 1;
      }
    }
    // Keep persistence outside the provider catch: accepted mail + failed DB write must never
    // become a retryable provider rejection.
    await orders.updateOne(
      { id: order.id, 'emailConfirmation.state': 'sending' },
      { $set: { emailConfirmation: update } },
    );
    /* eslint-enable no-await-in-loop */
  }
  return result;
}

module.exports = { sendOrderConfirmations, receiptConfigured, receiptMessage };
