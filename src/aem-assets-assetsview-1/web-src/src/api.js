import config from '../../../dx-excshell-1/web-src/src/config.json'

export async function callAssets (guest, op, args = {}, { signal } = {}) {
  const url = config['commerce-assets/manage'] || config.manage
  if (!url) throw new Error('The Commerce Assets action is not configured. Rebuild the extension.')
  const [auth, authorUrl, apiKey, resource] = await Promise.all([
    guest.host.auth.getIMSInfo(), guest.host.discovery.getAemHost(),
    guest.host.auth.getApiKey(), guest.host.details.getCurrentResourceInfo()
  ])
  if (!auth.accessToken || !auth.imsOrg) throw new Error('Your AEM Assets identity is unavailable. Reopen this panel.')
  if (args.assetPath && resource.path !== args.assetPath) throw new Error('The selected asset changed. Reload the panel before continuing.')
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 50000)
  try {
    const response = await fetch(url.replace('.adobeio-static.net/', '.adobeioruntime.net/'), {
      method: 'POST', signal: controller.signal,
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken}`,
        'x-gw-ims-org-id': auth.imsOrg
      },
      body: JSON.stringify({ ...args, op, authorUrl: new URL(authorUrl).origin, apiKey })
    })
    let body
    try { body = await response.json() } catch {
      throw new Error(`Commerce returned an unreadable response (HTTP ${response.status}).`)
    }
    if (!response.ok || body?.error) throw new Error(body?.error || `Commerce request failed (HTTP ${response.status}).`)
    if (op === 'products.search' ? !Array.isArray(body?.items) : !body?.revision || !Array.isArray(body?.skus)) {
      throw new Error('Commerce returned an invalid result.')
    }
    if (args.assetPath) {
      const current = await guest.host.details.getCurrentResourceInfo()
      if (current.path !== args.assetPath) throw new Error('The selected asset changed. Reload the panel to see the current links.')
    }
    return body
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('The commerce request timed out. Reload before retrying a save.')
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
