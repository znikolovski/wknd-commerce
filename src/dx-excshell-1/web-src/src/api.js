/*
 * Client for the IMS-protected `commerce-admin/admin` RPC action.
 * Every call sends the shell's current IMS token and org (require-adobe-auth: true).
 */
import config from './config.json'

const ADMIN_URL = config['commerce-admin/admin'] || config.admin
const ENDPOINTS = {
  admin: ADMIN_URL,
  // shared promotion engine + recovery-email approvals, called as the signed-in IMS user
  promotions: config['commerce-admin/promotions'] || config.promotions
}

export class AdminApiError extends Error {
  constructor (message, status) {
    super(message)
    this.status = status
  }
}

export async function callAdmin (ims, op, args = {}, { signal, endpoint = 'admin' } = {}) {
  if (!ims?.token) throw new AdminApiError('You are not signed in to Adobe Experience Cloud.', 401)
  const res = await fetch(ENDPOINTS[endpoint], {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ims.token}`,
      'x-gw-ims-org-id': ims.org
    },
    body: JSON.stringify({ op, ...args })
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch (e) {
    body = { error: text }
  }
  if (!res.ok) throw new AdminApiError(body.error || `Request failed (${res.status})`, res.status)
  return body
}

export const DM_WIDTHS = { thumb: 160, card: 480 }

/** Dynamic Media OpenAPI rendition for a linked asset ({url} is the DM asset base). */
export function dmRendition (link, width = DM_WIDTHS.thumb) {
  if (!link?.url) return null
  const alias = String(link.alias || link.sku || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product'
  return `${link.url}/as/${alias}.webp?width=${width}&quality=80`
}

export const formatMoney = (value, currency = 'AUD') => (
  Number.isFinite(Number(value))
    ? new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(Number(value))
    : '—'
)

export const formatDate = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '—')
