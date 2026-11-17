/**
 * Customer profile + address book (Core `Customer` / `CustomerAddress` shapes).
 * Identity comes from Auth0; there is no password/token management in the mock.
 */
const crypto = require('node:crypto');
const { findRegion } = require('./config');
const { CartError } = require('./cart');

function addressRecord(input, existing = {}) {
  const country = (input.country_code || input.country_id || existing.country_code || 'AU').toUpperCase();
  const region = findRegion(country, {
    regionId: input.region?.region_id ?? existing.region?.region_id,
    regionCode: input.region?.region_code ?? existing.region?.region_code,
    region: input.region?.region ?? existing.region?.region,
  });
  return {
    ...existing,
    uid: existing.uid || Buffer.from(`address/${crypto.randomUUID()}`).toString('base64'),
    id: existing.id || Math.floor(Math.random() * 1e9),
    firstname: input.firstname ?? existing.firstname ?? '',
    lastname: input.lastname ?? existing.lastname ?? '',
    company: input.company ?? existing.company ?? null,
    street: input.street ?? existing.street ?? [],
    city: input.city ?? existing.city ?? '',
    postcode: input.postcode ?? existing.postcode ?? '',
    telephone: input.telephone ?? existing.telephone ?? '',
    vat_id: input.vat_id ?? existing.vat_id ?? null,
    country_code: country,
    region: { region_id: region.region_id, region_code: region.code, region: region.label },
    default_billing: input.default_billing ?? existing.default_billing ?? false,
    default_shipping: input.default_shipping ?? existing.default_shipping ?? false,
  };
}

function addressShape(a) {
  return {
    ...a,
    country_id: a.country_code,
    region_id: a.region?.region_id,
    middlename: null,
    prefix: null,
    suffix: null,
    fax: null,
    custom_attributes: [],
    custom_attributesV2: [],
    extension_attributes: [],
  };
}

function customerShape(customer) {
  const addresses = (customer.addresses || []).map(addressShape);
  return {
    id: customer.sub,
    firstname: customer.firstname || '',
    lastname: customer.lastname || '',
    middlename: null,
    prefix: null,
    suffix: null,
    email: customer.email,
    gender: null,
    date_of_birth: null,
    dob: null,
    taxvat: null,
    is_subscribed: false,
    allow_remote_shopping_assistance: false,
    created_at: customer.createdAt,
    confirmation_status: 'ACCOUNT_CONFIRMED',
    default_billing: addresses.find((a) => a.default_billing)?.uid || null,
    default_shipping: addresses.find((a) => a.default_shipping)?.uid || null,
    addresses,
    addressesV2: { items: addresses, total_count: addresses.length, page_info: { current_page: 1, page_size: addresses.length || 1, total_pages: 1 } },
    custom_attributes: [],
    group: { uid: Buffer.from('customer-group/1').toString('base64'), name: 'General' },
    group_id: 1,
    role: null,
    status: 'ACTIVE',
    job_title: null,
    telephone: addresses[0]?.telephone || null,
    companies: { items: [], total_count: 0, page_info: { current_page: 1, page_size: 1, total_pages: 0 } },
    purchase_orders_enabled: false,
    structure_id: null,
    _record: customer,
  };
}

function normaliseDefaults(addresses, changed) {
  return addresses.map((a) => ({
    ...a,
    default_billing: changed.default_billing && a.uid !== changed.uid ? false : a.default_billing,
    default_shipping: changed.default_shipping && a.uid !== changed.uid ? false : a.default_shipping,
  }));
}

async function saveAddresses(store, customer, addresses) {
  await store.collection('customers').updateOne({ sub: customer.sub }, { $set: { addresses, updatedAt: new Date().toISOString() } });
  return { ...customer, addresses };
}

async function createAddress(store, customer, input) {
  const record = addressRecord(input);
  if (!(customer.addresses || []).length) {
    record.default_billing = true;
    record.default_shipping = true;
  }
  const addresses = normaliseDefaults([...(customer.addresses || []), record], record);
  await saveAddresses(store, customer, addresses);
  return addressShape(record);
}

async function updateAddress(store, customer, uid, input) {
  const existing = (customer.addresses || []).find((a) => a.uid === uid || String(a.id) === String(uid));
  if (!existing) throw new CartError('Could not find a address with the specified ID', 'UNDEFINED', 'graphql-no-such-entity');
  const record = addressRecord(input, existing);
  const addresses = normaliseDefaults(customer.addresses.map((a) => (a.uid === existing.uid ? record : a)), record);
  await saveAddresses(store, customer, addresses);
  return addressShape(record);
}

async function deleteAddress(store, customer, uid) {
  const addresses = (customer.addresses || []).filter((a) => a.uid !== uid && String(a.id) !== String(uid));
  await saveAddresses(store, customer, addresses);
  return true;
}

async function updateProfile(store, customer, input = {}) {
  const set = {};
  ['firstname', 'lastname'].forEach((k) => {
    if (input[k] != null) set[k] = String(input[k]).slice(0, 255);
  });
  if (Object.keys(set).length) await store.collection('customers').updateOne({ sub: customer.sub }, { $set: set });
  return { ...customer, ...set };
}

module.exports = {
  customerShape, createAddress, updateAddress, deleteAddress, updateProfile, addressShape,
};
