const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { isDuplicateKeyError } = require('./store');

const INBOX = 'aam_outbound_inbox_v1';
const MAX_BYTES = 64 * 1024;
const MAX_USERS = 10;
const MAX_SEGMENTS = 50;
const NAMESPACES = { production: '28538-wkndcommerce', stage: '28538-wkndcommerce-stage' };

class AamError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function integer(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new AamError('INVALID_INTEGER');
}

function sourceConfig(params, namespace) {
  const environment = params.AAM_ENVIRONMENT;
  const destinationId = integer(params.AAM_DESTINATION_ID);
  const dpid = integer(params.AAM_USER_DPID);
  const ttlMs = integer(params.AAM_MEMBERSHIP_TTL_MS);
  const segments = String(params.AAM_SEGMENT_ALLOWLIST || '').split(',').map((id) => String(integer(id)));
  if (namespace !== NAMESPACES[environment] || !destinationId || !dpid
    || typeof params.AAM_CLIENT_ID !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(params.AAM_CLIENT_ID)
    || ttlMs < 60000 || ttlMs > 86400000 || !segments.length || segments.length > MAX_SEGMENTS
    || new Set(segments).size !== segments.length) throw new AamError('CONFIG_INVALID', 503);
  const scope = { environment, namespace, destinationId, dpid, clientId: params.AAM_CLIENT_ID };
  return { scope, scopeKey: hash(JSON.stringify(scope)), ttlMs, segments };
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function dateTime(value) {
  if (typeof value !== 'string') throw new AamError('INVALID_DATETIME');
  // Adobe's sample uses this Java-style UTC representation, not an epoch or ordering token.
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) UTC ([0-9]{4})$/.exec(value);
  if (!match) throw new AamError('INVALID_DATETIME');
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  const ms = Date.UTC(Number(match[7]), months.indexOf(match[2]), Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]));
  const date = new Date(ms);
  const canonical = `${'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')} ${date.toISOString().slice(11, 19)} UTC ${date.getUTCFullYear()}`;
  if (canonical !== value) throw new AamError('INVALID_DATETIME');
  return ms;
}

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new AamError('INVALID_PAYLOAD');
}

function rawBody(params) {
  const encoded = params.__ow_body;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_BYTES / 3) * 4) {
    throw new AamError('PAYLOAD_LIMIT', 413);
  }
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new AamError('RAW_BODY_REQUIRED');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new AamError('RAW_BODY_REQUIRED');
  if (bytes.length > MAX_BYTES) throw new AamError('PAYLOAD_LIMIT', 413);
  return bytes;
}

function authenticate(bytes, params, headers) {
  const header = params.AAM_SIGNATURE_HEADER;
  if (params.AAM_SIGNATURE_ALGORITHM !== 'sha256'
    || typeof header !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(header)
    || ['content-type', 'content-length', 'authorization', 'host'].includes(header)
    || typeof params.AAM_SIGNATURE_SECRET !== 'string'
    || Buffer.byteLength(params.AAM_SIGNATURE_SECRET) < 32) throw new AamError('SIGNATURE_CONFIG_INVALID', 503);
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === header);
  const signature = matches.length === 1 ? matches[0][1] : null;
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) {
    throw new AamError('SIGNATURE_INVALID', 401);
  }
  const supplied = Buffer.from(signature, 'base64');
  const expected = crypto.createHmac('sha256', params.AAM_SIGNATURE_SECRET).update(bytes).digest();
  if (supplied.toString('base64') !== signature || !crypto.timingSafeEqual(expected, supplied)) {
    throw new AamError('SIGNATURE_INVALID', 401);
  }
}

function parsePayload(bytes, config, now) {
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AamError('INVALID_JSON');
  }
  object(payload, ['ProcessTime', 'User_DPID', 'Client_ID', 'AAM_Destination_ID', 'AAM_Destination_Id', 'User_count', 'Users']);
  const destination = payload.AAM_Destination_ID ?? payload.AAM_Destination_Id;
  if (payload.AAM_Destination_ID !== undefined && payload.AAM_Destination_Id !== undefined
    && integer(payload.AAM_Destination_ID) !== integer(payload.AAM_Destination_Id)) {
    throw new AamError('DESTINATION_CONFLICT');
  }
  if (integer(destination) !== config.scope.destinationId || integer(payload.User_DPID) !== config.scope.dpid
    || payload.Client_ID !== config.scope.clientId) throw new AamError('SOURCE_SCOPE_MISMATCH', 403);
  const processAt = dateTime(payload.ProcessTime);
  if (processAt > now) throw new AamError('TRANSFER_FROM_FUTURE');
  if (!Array.isArray(payload.Users) || !payload.Users.length || payload.Users.length > MAX_USERS
    || integer(payload.User_count) !== payload.Users.length) throw new AamError('USER_COUNT_INVALID');
  const seen = new Set();
  const events = [];
  payload.Users.forEach((user) => {
    object(user, ['AAM_UUID', 'DataPartner_UUID', 'AAM_Regions', 'Segments']);
    if (typeof user.AAM_UUID !== 'string' || !/^[0-9]{1,64}$/.test(user.AAM_UUID)
      || typeof user.DataPartner_UUID !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(user.DataPartner_UUID)
      || (user.AAM_Regions !== undefined && (!Array.isArray(user.AAM_Regions) || user.AAM_Regions.length > 20))
      || !Array.isArray(user.Segments) || user.Segments.length > MAX_SEGMENTS) throw new AamError('USER_INVALID');
    (user.AAM_Regions || []).forEach(integer);
    const identityKey = hash(JSON.stringify([config.scopeKey, user.DataPartner_UUID]));
    user.Segments.forEach((segment) => {
      object(segment, ['Segment_ID', 'Status', 'DateTime']);
      const segmentId = String(integer(segment.Segment_ID));
      const status = integer(segment.Status);
      const qualifiedAt = dateTime(segment.DateTime);
      if (status > 1 || qualifiedAt > processAt) throw new AamError('SEGMENT_INVALID');
      if (!config.segments.includes(segmentId)) throw new AamError('SEGMENT_NOT_ALLOWED', 403);
      const key = hash(JSON.stringify([identityKey, segmentId]));
      if (seen.has(key)) throw new AamError('DUPLICATE_SEGMENT');
      seen.add(key);
      events.push({ key, identityKey, segmentId, active: status === 1, qualifiedAt, processAt });
    });
  });
  return events;
}

async function persistInbox(store, config, bytes, events, now) {
  const key = hash(JSON.stringify([config.scopeKey, hash(bytes)]));
  const inbox = store.collection(INBOX);
  try {
    await inbox.insertOne({
      _id: key, key, scopeKey: config.scopeKey, digest: hash(bytes), events,
      complete: true, state: 'queued', receivedAt: now, leaseUntil: 0,
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
  const saved = await inbox.findOne({ _id: key });
  if (!saved || saved.complete !== true || saved.scopeKey !== config.scopeKey
    || saved.digest !== hash(bytes) || JSON.stringify(saved.events) !== JSON.stringify(events)) {
    throw new AamError('PERSISTENCE_UNCONFIRMED', 503);
  }
}

function createReceiver({ getStore, report = () => {}, now = Date.now, namespace = () => process.env.__OW_NAMESPACE }) {
  return async (params) => {
    const response = (statusCode, code) => ({
      statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: { ok: statusCode === 200, code },
    });
    if (params.AAM_RECEIVER_ENABLED !== 'true') return response(404, 'RECEIVER_DISABLED');
    if (params.AAM_CONFIG_VERIFIED !== 'true') return response(503, 'CONFIG_NOT_VERIFIED');
    let store;
    let timer;
    try {
      if (params.__ow_method !== 'post') throw new AamError('POST_REQUIRED', 405);
      if (params.__ow_query) throw new AamError('QUERY_NOT_ALLOWED');
      const headers = params.__ow_headers || {};
      if (headers['content-type'] !== 'application/json'
        && headers['content-type'] !== 'application/json; charset=utf-8') throw new AamError('JSON_REQUIRED', 415);
      const config = sourceConfig(params, namespace());
      const bytes = rawBody(params);
      authenticate(bytes, params, headers);
      const receivedAt = now();
      const events = parsePayload(bytes, config, receivedAt);
      const persist = async () => {
        store = await getStore(params);
        await persistInbox(store, config, bytes, events, receivedAt);
      };
      await Promise.race([
        persist(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new AamError('PERSISTENCE_TIMEOUT', 503)), 2500);
        }),
      ]);
      return response(200, 'DURABLY_RECEIVED');
    } catch (error) {
      const known = error instanceof AamError;
      report({ code: known ? error.code : 'PERSISTENCE_FAILED' });
      return response(known ? error.status : 503, known ? error.code : 'PERSISTENCE_FAILED');
    } finally {
      clearTimeout(timer);
      if (store) await store.close();
    }
  };
}

module.exports = {
  INBOX, MAX_BYTES, AamError, hash, integer, sourceConfig, dateTime, parsePayload, createReceiver,
};
