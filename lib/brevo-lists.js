const { BrevoError } = require('./brevo');

function createBrevoListClient({ apiKey, fetchImpl = fetch, timeoutMs = 5000 }) {
  if (!apiKey) throw new BrevoError('Brevo list key is not configured.', { ambiguous: false });
  async function request(path, body) {
    let response;
    try {
      response = await fetchImpl(`https://api.brevo.com/v3/contacts/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BrevoError('Brevo list request failed.', { ambiguous: Boolean(body) });
    }
    if (!response.ok) throw new BrevoError('Brevo list request rejected.', {
      status: response.status, ambiguous: Boolean(body) && response.status >= 500,
    });
    try {
      return await response.json();
    } catch {
      throw new BrevoError('Brevo list response is invalid.', { ambiguous: Boolean(body) });
    }
  }
  const validId = (id) => Number.isSafeInteger(id) && id > 0;
  function validateContact(contact, contactId) {
    if (!validId(contact.id) || (contactId !== undefined && contact.id !== contactId)
      || typeof contact.email !== 'string' || typeof contact.emailBlacklisted !== 'boolean'
      || !Array.isArray(contact.listIds) || contact.listIds.some((id) => !validId(id))) {
      throw new BrevoError('Brevo contact response is invalid.', { ambiguous: false });
    }
    return contact;
  }
  return {
    async contact(contactId) {
      if (!validId(contactId)) throw new BrevoError('Invalid contact ID.', { ambiguous: false });
      const contact = await request(`${contactId}?identifierType=contact_id`);
      return validateContact(contact, contactId);
    },
    async contactByEmail(email) {
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BrevoError('Invalid verified email.', { ambiguous: false });
      }
      return validateContact(await request(`${encodeURIComponent(email)}?identifierType=email_id`));
    },
    async change(listId, contactId, add) {
      if (!validId(listId) || !validId(contactId) || typeof add !== 'boolean') {
        throw new BrevoError('Invalid list operation.', { ambiguous: false });
      }
      const body = await request(`lists/${listId}/contacts/${add ? 'add' : 'remove'}`, { ids: [contactId] });
      // Brevo documents nested contacts; its examples also show top-level result arrays.
      const result = Array.isArray(body.success) || Array.isArray(body.failure) ? body : body.contacts;
      if (!Array.isArray(result?.success) || (result.failure !== undefined && !Array.isArray(result.failure))
        || result.failure?.length || !result.success.includes(contactId)) {
        throw new BrevoError('Brevo did not confirm the list operation.', { ambiguous: true });
      }
      return true;
    },
  };
}

module.exports = { createBrevoListClient };
