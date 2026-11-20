/**
 * Minimal Brevo transactional-email client (server-side only; the API key never reaches the
 * browser or MCP results). https://developers.brevo.com/reference/sendtransacemail
 */
const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_BLOCKED_URL = 'https://api.brevo.com/v3/smtp/blockedContacts';

class BrevoError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, ambiguous: boolean }} info ambiguous=true when the provider may
   *   have accepted the message (timeouts, network errors, 5xx) — never blindly resend.
   */
  constructor(message, { status = null, ambiguous }) {
    super(message);
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

function createBrevoClient({ apiKey, fetchImpl = fetch, timeoutMs = 10000 }) {
  if (!apiKey) throw new Error('BREVO_API_KEY is not configured.');
  return {
    /** Sends one template email; returns { messageId }. */
    async sendTemplate({
      to, templateId, params = {}, tags = [],
    }) {
      let res;
      try {
        res = await fetchImpl(BREVO_SEND_URL, {
          method: 'POST',
          headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            to: [{ email: to.email, ...(to.name ? { name: to.name } : {}) }], templateId: Number(templateId), params, tags,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new BrevoError('Brevo request failed.', { ambiguous: true });
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.messageId) return { messageId: String(body.messageId) };
      if (res.ok) throw new BrevoError('Brevo response had no message id.', { status: res.status, ambiguous: true });
      throw new BrevoError(`Brevo rejected the email (${res.status}).`, { status: res.status, ambiguous: res.status >= 500 });
    },

    /**
     * Transactional blocked/unsubscribed contacts (hard bounces, spam complaints,
     * unsubscribes). Polling alternative to webhooks, which some plans don't include.
     * @returns {Promise<{ contacts: Array<{ email: string, reason?: { code?: string } }>, count: number }>}
     */
    async listBlockedContacts({ limit = 100, offset = 0 } = {}) {
      let res;
      try {
        res = await fetchImpl(`${BREVO_BLOCKED_URL}?limit=${limit}&offset=${offset}&sort=desc`, {
          headers: { 'api-key': apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new BrevoError('Brevo request failed.', { ambiguous: false });
      }
      if (!res.ok) throw new BrevoError(`Brevo blocked-contacts request failed (${res.status}).`, { status: res.status, ambiguous: false });
      const body = await res.json().catch(() => ({}));
      return { contacts: Array.isArray(body.contacts) ? body.contacts : [], count: Number(body.count) || 0 };
    },
  };
}

module.exports = {
  createBrevoClient, BrevoError, BREVO_SEND_URL, BREVO_BLOCKED_URL,
};
