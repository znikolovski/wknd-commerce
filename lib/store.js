/**
 * Data store abstraction.
 *
 * Production uses App Builder Database Storage (aio-lib-db). Tests and local scripts use an
 * in-memory implementation with the same (deliberately small) surface so business logic
 * never depends on driver specifics:
 *   findOne(filter) · find(filter, { sort, limit, batchSize }) · insertOne(doc) · insertMany(docs)
 *   updateOne(filter, update, { upsert }) · replaceOne(filter, doc, { upsert })
 *   deleteOne(filter) · deleteMany(filter) · countDocuments(filter)
 * Filters support equality, $in, $ne, $lt/$lte/$gt/$gte, $exists and dotted paths.
 * Updates support $set, $unset, $inc and $push.
 */

const COLLECTIONS = [
  'products', 'categories', 'prices', 'inventory', 'asset_links',
  'carts', 'orders', 'customers', 'counters', 'events',
  'promotions', 'promotion_requests', 'promotion_codes', 'promotion_effects', 'promotion_audit',
  'promotion_meta', 'recovery_policies', 'recovery_entitlements', 'recovery_redemptions',
];

/**
 * Unique-key insert failure. Promotion receipts, code reservations and recovery redemptions rely
 * on the database's unique `_id` constraint (no multi-document transactions are available).
 */
class DuplicateKeyError extends Error {
  constructor() {
    super('Duplicate key');
    this.code = 11000;
  }
}

const isDuplicateKeyError = (e) => e instanceof DuplicateKeyError || e?.code === 11000
  || e?.code === 'E11000' || /E11000|duplicate key/i.test(e?.message || '');

function getPath(doc, path) {
  return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc);
}

function setPath(doc, path, value) {
  const keys = path.split('.');
  let cur = doc;
  keys.slice(0, -1).forEach((k) => {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  });
  cur[keys[keys.length - 1]] = value;
}

function unsetPath(doc, path) {
  const keys = path.split('.');
  const parent = keys.slice(0, -1).reduce((v, k) => (v == null ? undefined : v[k]), doc);
  if (parent) delete parent[keys[keys.length - 1]];
}

function matchesCondition(value, cond) {
  if (cond && typeof cond === 'object' && !Array.isArray(cond)
    && Object.keys(cond).some((k) => k.startsWith('$'))) {
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case '$in': return Array.isArray(value) ? value.some((v) => arg.includes(v)) : arg.includes(value);
        case '$nin': return !arg.includes(value);
        case '$ne': return value !== arg;
        case '$lt': return value < arg;
        case '$lte': return value <= arg;
        case '$gt': return value > arg;
        case '$gte': return value >= arg;
        case '$exists': return arg ? value !== undefined : value === undefined;
        default: throw new Error(`Unsupported filter operator ${op}`);
      }
    });
  }
  if (Array.isArray(value) && !Array.isArray(cond)) return value.includes(cond);
  return value === cond;
}

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([path, cond]) => matchesCondition(getPath(doc, path), cond));
}

function applyUpdate(doc, update) {
  const next = structuredClone(doc);
  Object.entries(update).forEach(([op, fields]) => {
    Object.entries(fields).forEach(([path, value]) => {
      if (op === '$set') setPath(next, path, value);
      else if (op === '$unset') unsetPath(next, path);
      else if (op === '$inc') setPath(next, path, (getPath(next, path) || 0) + value);
      else if (op === '$push') setPath(next, path, [...(getPath(next, path) || []), value]);
      else if (op === '$setOnInsert') { /* handled by upsert */ } else throw new Error(`Unsupported update operator ${op}`);
    });
  });
  return next;
}

function sortDocs(docs, sort) {
  if (!sort) return docs;
  const keys = Object.entries(sort);
  return [...docs].sort((a, b) => {
    for (let i = 0; i < keys.length; i += 1) {
      const [path, dir] = keys[i];
      const av = getPath(a, path);
      const bv = getPath(b, path);
      if (av < bv) return -dir;
      if (av > bv) return dir;
    }
    return 0;
  });
}

function strip(doc) {
  if (!doc) return null;
  const { _id: _ignored, ...rest } = doc;
  return structuredClone(rest);
}

class MemoryCollection {
  constructor() {
    this.docs = [];
  }

  async findOne(filter) {
    return strip(this.docs.find((d) => matches(d, filter)));
  }

  async find(filter = {}, { sort, limit } = {}) {
    const found = sortDocs(this.docs.filter((d) => matches(d, filter)), sort);
    return (limit ? found.slice(0, limit) : found).map(strip);
  }

  hasId(id) {
    return id !== undefined && this.docs.some((d) => d._id === id);
  }

  async insertOne(doc) {
    if (this.hasId(doc._id)) throw new DuplicateKeyError();
    this.docs.push(structuredClone(doc));
    return { acknowledged: true };
  }

  async insertMany(docs) {
    const ids = docs.map((d) => d._id).filter((id) => id !== undefined);
    if (new Set(ids).size !== ids.length || ids.some((id) => this.hasId(id))) throw new DuplicateKeyError();
    docs.forEach((d) => this.docs.push(structuredClone(d)));
    return { acknowledged: true, insertedCount: docs.length };
  }

  async updateOne(filter, update, { upsert } = {}) {
    const idx = this.docs.findIndex((d) => matches(d, filter));
    if (idx >= 0) {
      this.docs[idx] = applyUpdate(this.docs[idx], update);
      return { matchedCount: 1, modifiedCount: 1 };
    }
    if (upsert) {
      const base = Object.fromEntries(Object.entries(filter).filter(([, v]) => typeof v !== 'object'));
      this.docs.push(applyUpdate({ ...base, ...(update.$setOnInsert || {}) }, update));
      return { matchedCount: 0, upsertedCount: 1 };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async replaceOne(filter, doc, { upsert } = {}) {
    const idx = this.docs.findIndex((d) => matches(d, filter));
    if (idx >= 0) {
      if (doc._id !== undefined && doc._id !== this.docs[idx]._id) throw new Error('Cannot change _id');
      this.docs[idx] = structuredClone({ ...doc, _id: this.docs[idx]._id });
    } else if (upsert) {
      if (this.hasId(doc._id)) throw new DuplicateKeyError();
      this.docs.push(structuredClone(doc));
    }
    return { matchedCount: idx >= 0 ? 1 : 0 };
  }

  async deleteOne(filter) {
    const idx = this.docs.findIndex((d) => matches(d, filter));
    if (idx >= 0) this.docs.splice(idx, 1);
    return { deletedCount: idx >= 0 ? 1 : 0 };
  }

  async deleteMany(filter = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matches(d, filter));
    return { deletedCount: before - this.docs.length };
  }

  async countDocuments(filter = {}) {
    return this.docs.filter((d) => matches(d, filter)).length;
  }
}

function createMemoryStore() {
  const collections = new Map(COLLECTIONS.map((n) => [n, new MemoryCollection()]));
  return {
    kind: 'memory',
    collection(name) {
      if (!collections.has(name)) collections.set(name, new MemoryCollection());
      return collections.get(name);
    },
    async close() {},
  };
}

const isNotFound = (e) => e?.httpStatusCode === 404 || /not found/i.test(e?.message || '');

class DbCollection {
  constructor(coll) {
    this.coll = coll;
  }

  // aio-lib-db raises "Document not found" (404) where the MongoDB driver returns null.
  async findOne(filter) {
    try {
      return strip(await this.coll.findOne(filter));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async find(filter = {}, { sort, limit, batchSize } = {}) {
    let cursor = this.coll.find(filter);
    if (sort) cursor = cursor.sort(sort);
    if (limit) cursor = cursor.limit(limit);
    // Each batch is a DB API round trip; large reads (the catalog snapshot) ask for big batches.
    if (batchSize) cursor = cursor.batchSize(batchSize);
    try {
      return (await cursor.toArray()).map(strip);
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
  }

  insertOne(doc) { return this.coll.insertOne(doc); }

  insertMany(docs) { return this.coll.insertMany(docs); }

  // Conditional writes: a filter that matches nothing is { matchedCount: 0 }, not an error.
  async updateOne(filter, update, options) {
    try {
      return await this.coll.updateOne(filter, update, options);
    } catch (e) {
      if (isNotFound(e)) return { matchedCount: 0, modifiedCount: 0 };
      throw e;
    }
  }

  async replaceOne(filter, doc, options) {
    try {
      return await this.coll.replaceOne(filter, doc, options);
    } catch (e) {
      if (isNotFound(e)) return { matchedCount: 0, modifiedCount: 0 };
      throw e;
    }
  }

  deleteOne(filter) { return this.coll.deleteOne(filter); }

  deleteMany(filter = {}) { return this.coll.deleteMany(filter); }

  async countDocuments(filter = {}) {
    try {
      return await this.coll.countDocuments(filter);
    } catch (e) {
      if (isNotFound(e)) return 0;
      throw e;
    }
  }
}

let dbClientCache = null;
const DB_CLIENT_TTL_MS = 20 * 60 * 1000;

async function createDbStore(params) {
  // Reuse the connection across warm invocations; tokens are refreshed well before expiry.
  if (!dbClientCache || Date.now() > dbClientCache.exp) {
    // Required lazily so tests never load the SDK.
    // eslint-disable-next-line global-require
    const { generateAccessToken } = require('@adobe/aio-lib-core-auth');
    // eslint-disable-next-line global-require
    const libDb = require('@adobe/aio-lib-db');
    const token = await generateAccessToken(params);
    const db = await libDb.init({ token: token.access_token, region: params.DB_REGION || 'amer' });
    const client = await db.connect();
    if (dbClientCache) dbClientCache.client.close().catch(() => {});
    dbClientCache = { client, exp: Date.now() + DB_CLIENT_TTL_MS, wrapped: new Map() };
  }
  const { client, wrapped } = dbClientCache;
  return {
    kind: 'db',
    collection(name) {
      if (!wrapped.has(name)) wrapped.set(name, new DbCollection(client.collection(name)));
      return wrapped.get(name);
    },
    // connection is pooled per container; call resetDbClient() on auth/connection errors
    close: async () => {},
  };
}

function resetDbClient() {
  if (dbClientCache) dbClientCache.client.close().catch(() => {});
  dbClientCache = null;
}

let memorySingleton;

/**
 * @param {object} params action params
 * @returns {Promise<object>} store
 */
async function getStore(params = {}) {
  if (params.STORE === 'memory' || process.env.WKND_COMMERCE_STORE === 'memory') {
    if (!memorySingleton) memorySingleton = createMemoryStore();
    return memorySingleton;
  }
  return createDbStore(params);
}

module.exports = {
  COLLECTIONS,
  getStore,
  createMemoryStore,
  matches,
  applyUpdate,
  resetDbClient,
  DuplicateKeyError,
  isDuplicateKeyError,
};
