/**
 * Minimal Brevo transactional-email client (server-side only; the API key never reaches the
 * browser or MCP results). https://developers.brevo.com/reference/sendtransacemail
 */
const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';

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
  };
}

module.exports = { createBrevoClient, BrevoError, BREVO_SEND_URL };
