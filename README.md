# wknd-commerce

This is a mock **Adobe Commerce** backend for the WKND Adventures shop, built on Adobe App Builder.
It provides:
- GraphQL for the Commerce drop-ins, fronted by **API Mesh**;
- an **ExC Shell admin UI** for products, inventory, pricing and orders;
- **AEM Assets → product image linking** (Commerce custom asset matcher);
- a **Content AI** search proxy;
- a **CX Coworker operator MCP** with privacy-safe reads and discount-only writes;
- **BYOM PDP markup** for Edge Delivery Services.

The storefront lives in the sibling repo `../masterclass-demo`. See its `docs/SHOP.md` for the end-to-end
architecture and `docs/SHOP-ANALYTICS-PLAN.md` for analytics.

## Layout

| Path | Purpose |
|------|---------|
| `actions/storefront-graphql` | Mesh source: merged Core + Catalog Service schema (`lib/schema-sdl.js`), resolvers in `lib/` |
| `actions/pdp-markup`, `actions/prerender` | EDS content overlay for `/shop/products/*`; preview/publish of changed PDPs |
| `actions/content-ai` | CORS proxy to AEM Content AI (`/adobe/contentAI`); compact hits + `grounded` flag (`lib/content-ai.js`) |
| `actions/asset-events`, `asset-to-product`, `product-to-asset`, `reconcile` | AEM image linking (I/O Events + nightly alarm) |
| `actions/auth-config` | Public Auth0 SPA settings (shared with WKND Aero) |
| `actions/commerce-mcp` | Shared-key operator MCP (not shopper delegation or IMS passthrough) |
| `src/dx-excshell-1` | Admin SPA (React Spectrum) and the IMS-protected `commerce-admin/admin` RPC |
| `src/aem-assets-assetsview-1` | Assets View **WKND Commerce** product-linking panel and IMS-protected `commerce-assets/manage` RPC |
| `aem-config/commerce-metadata-form.spec.json` | Native Assets View Commerce metadata field mappings (manual form blueprint) |
| `events/aem-assets-registration.json` | I/O Events registration (AEM Assets provider → `commerce/asset-events`) |
| `aem-config/config/api.yaml` | AEM author API client allowlist (deploy via the Cloud Manager config pipeline) |
| `data/` | Catalog source and generated catalog (99 products / 584 sellable SKUs) |
| `test/` | Drop-in GraphQL contract, linking, PDP, admin and Content AI tests |

Data lives in App Builder Database Storage (`aio-lib-db`). Prices are AUD and GST-inclusive.
Payment is **WKND Demo Pay**, which takes no real payment.

## Setup

1. `aio app use` (Console project `wkndcommerce`, Stage workspace). Then copy `.env.example` to `.env`
   and fill in the `WKND_*` values. Secrets stay in `.env` only.
2. `npm install`
3. `aio app deploy`
4. `npm run catalog:seed` to load the catalog (`npm run catalog:generate` regenerates it from `data/catalog-source.mjs`).
5. `npm run mesh:build && aio api-mesh update mesh.json`. The Mesh uses a static SDL source because the
   schema is too large for introspection through Runtime.
6. `aio event registration create events/aem-assets-registration.json` (once per workspace).

**Admin UI (Stage):**
`https://experience.adobe.com/?devMode=true#/custom-apps/?localDevUrl=https://28538-wkndcommerce-stage.adobeio-static.net/index.html`

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | All Jest tests (incl. the drop-in operation contract) |
| `npm run lint` | ESLint for actions, lib, scripts and tests |
| `npm run schema:refresh` | Re-introspect reference Commerce schemas and rebuild `lib/schema-sdl.js` |
| `npm run dropins:extract` | Re-extract GraphQL operations from the storefront's pinned drop-ins |
| `node scripts/smoke-live.mjs` | Live smoke test through the Mesh (catalog → cart → order) |
| `node scripts/smoke-mcp.mjs` | Official MCP SDK smoke over local HTTP and in-memory commerce; no deployment |

## CX Coworker commerce MCP

The remote Streamable HTTP endpoint is the `commerce/mcp` raw App Builder action.
This intentionally uses a **shared integration key**, not IMS passthrough. Every key holder
has the same permissions and server-owned audit identity `integration:cx-coworker`.
`WKND_COMMERCE_MCP_ORG` is a stable deployment namespace, **not** verified membership in
an Adobe organization. Existing IMS admin and shopper Auth0/delegation routes are unchanged.

After an **explicitly approved deployment**, configure Coworker's custom remote MCP with:

- Transport: **Streamable HTTP**; URL: the deployed `commerce/mcp` web action URL.
- Custom header: **`X-WKND-MCP-Key`**, value matching `WKND_COMMERCE_MCP_SECRET`.
- Do not put credentials in the URL or chat. No OAuth/IMS header is required for this endpoint.

Configure `.env` using `.env.example`. The shared secret must be a securely generated
base64url value containing at least 32 random bytes (43–128 characters). Missing/invalid
key or namespace configuration fails closed. Keep secrets in deployment configuration,
never Git, logs or MCP arguments. Rotate by replacing the server secret, redeploying with
approval and updating Coworker's header; the old secret immediately stops working on the
updated deployment. Use a separate environment/secret for each integration trust boundary.
An optional exact browser-Origin allowlist is available; leave it empty for server-to-server
Coworker requests without `Origin`. Wildcards are not supported. Query parameters are rejected.

### Permissions and outcomes

| Tools | Scope |
| --- | --- |
| `commerce_stats`, `list_categories`, `list_products`, `get_product`, `list_inventory` | Read-only catalog, AUD prices, inventory and honestly capped recent-order aggregates |
| `list_orders`, `get_order` | Order numbers, totals and line items; no customer identity, email, address, payment or access tokens; exact-number search only |
| `set_product_sale`, `clear_product_sale`, `bulk_product_sale`, `bulk_clear_product_sale` | Only special prices/windows; no base-price, inventory, product, order or customer mutations |
| `list_promotions`, `get_promotion`, `create_promotion`, `update_promotion`, `disable_promotion` | Thin adapters to frozen `wknd.promotions/v1`; no independent engine or caller-supplied actor/org |

Product sales use integer AUD cents or percentages from 1 to below 90, strict millisecond
UTC windows and explicit SKU/category selections. Parent selection includes variants;
bulk scope is at most 100 parents/1,000 price records. Category matching is exact or
slash-descendant, never a raw string prefix. Sales are **not atomic or idempotent**:
inspect per-SKU partial/unknown results before retrying. Audit/invalidation/prerender warnings
do not undo a saved price; rendering submission is not proof of completed publication.

Promotion writes require UUIDv4 idempotency keys and update/disable require expected revisions.
Full updates require every mutable field. Preserve returned envelopes and inspect `committed`,
not just tool success. For unknown outcomes use
`get_promotion({request:{operation,idempotencyKey}})` with the **original key**; a missing
or expired receipt never authorizes reissuing a write. Cursors expire after 15 minutes,
bind limit/filters and represent live traversal rather than a snapshot.
Promotion discounts do not change public catalog prices or trigger PDP prerenders.
Read-only `managementClass` identifies protected recovery, which generic tools cannot
create or weaken. Audience-restricted writes remain unsupported.

No unrestricted admin RPC, GraphQL, migration, recovery worker, shopper evidence,
customer lookup or email approval/send tools are exposed. A shared key is not human approval.

### Activation, validation and rollback

`WKND_MCP_PROMOTION_WRITES_ENABLED=false` is the default. Promotion management reads require
the explicit migration; writes additionally require approved real-database unique-key/CAS
verification. Follow [the shared promotion runbook](docs/PROMOTIONS.md), then explicitly enable
the MCP write flag and deploy only with authorization. Never treat passing memory tests as
production storage proof. Keep `WKND_RECOVERY_REDEMPTION_VERIFIED=false` until protected
redemption guarantees are verified separately. `WKND_PROMOTION_CURSOR_KEY` is base64 for
exactly 32 random bytes (rotation invalidates cursors).

Before migration the storefront retains its built-in legacy coupons; migration preserves
TRAILREADY's below-AUD200 acceptance with zero saving. A retained explicit legacy coupon
suppresses automatic promotions; exactly AUD200 saves AUD20. New coupons do not inherit
this exception. The five-minute non-web promotion worker settles durable requests/effects.
The optional Brevo webhook only records suppression, requires its separate bearer secret,
and does not send emails. Recovery email sends remain separately approval-gated and are
not part of this MCP.

Run `node scripts/smoke-mcp.mjs` for a local official-SDK HTTP handshake/list/read check.
After approved deployment, `node scripts/smoke-mcp.mjs https://YOUR-DEPLOYED-MCP-URL` uses
`WKND_COMMERCE_MCP_SECRET` from the process environment and performs **reads only**.
Actual Coworker connectivity still needs verification in the deployed environment.

To revoke MCP access, remove/rotate its secret or remove the action at the next approved
deployment. To stop only promotion management writes set the write flag false; existing
promotion definitions and their durable reconciliation state remain intact. Disable individual
active promotions with revision-aware `disable_promotion` before withdrawing management access
if their pricing effects must stop. Do not delete receipts, policies or worker recovery state.

## OF1 product-first discovery

`of1Discovery(query: String!, history: [String!])` is a read-only storefront query for
the WKND OF1 gateway. It returns `experience` (`product`, `adventure`, `clarification`),
at most three `ProductView` records, catalog-backed comparison context, concrete
adventure slugs, optional inclusive AUD `maxPrice`, and complete-query suggestions.

The service lives in `lib/of1-discovery.js`. Explicit shopping/category requests lead
with products; trip preparation remains adventure-first. Budgets use real priced,
available variants. Exact named sold-out products may still be compared, with purchase
disabled. Missing facts/prices are not invented. Unsupported/ambiguous inputs get a
clarification; a genuine empty shortlist remains a product no-match, not an adventure.

Inputs are bounded to 500 characters and five recent queries. The SDK includes the
current query in history; it is removed before resolving refinements. History has query
strings, not prior results, so ordinal references require a product name.
No customer identity, cart mutation or model call is involved. Discovery responses are
not HTTP-cacheable and do not change the existing `productSearch` semantics.

Project-owned SDL is in `schema/of1.graphql`; `scripts/build-schema.mjs` incorporates it
without changing the reference Commerce schemas. Regenerate both schema outputs and
the Mesh source when deploying:

```sh
npm run schema:build
./node_modules/.bin/jest test/of1-discovery.test.js test/contract/dropins.contract.test.js --runInBand
npm run mesh:build
```

The storefront/gateway currently use the **Production** Mesh. This checkout may be
configured for **Stage**. Verify `aio console where`, the Runtime namespace and generated
Mesh endpoint before any deployment; do not enable product-first routing against a Mesh
that has not received the query. Use targeted `commerce/storefront-graphql` deployment
and the intended workspace's Mesh update, not a broad app deployment.

After Commerce and storefront code are ready, enable the existing gateway's
`OF1_PRODUCT_FIRST_ENABLED` input. Its manifest defaults to false for safe rollout.
The storefront's `tools/scripts/test-of1-products.mjs` exercises the real SDK/gateway/
drop-ins against an isolated in-memory backend without touching live carts.

## Delegated shoppers (WKND LLM app / ChatGPT)

The WKND LLM app (`../masterclass-demo-llmapp`) lets signed-in shoppers use their cart and check out
with WKND Demo Pay inside ChatGPT. It calls `storefront-graphql` directly with
`X-WKND-Delegation: mcp` and a short-lived HS256 assertion instead of an Auth0 access token
(`lib/auth.js`, `verifyDelegation`):

- `iss` must equal `MCP_DELEGATION_ISSUER`, `aud` must be `urn:wknd-commerce:storefront`,
  `identity_issuer` must equal `AUTH0_ISSUER`, `scope` must include `shop:cart`, the lifetime is at
  most 120 s and each `jti` is accepted once (`delegation_jti` collection).
- The customer is resolved by the Auth0 `sub`, so ChatGPT and the website share one customer and one
  active cart. A shopper first seen in ChatGPT is created with `profileFetchedAt: 0`; the website
  refreshes their profile on the next sign-in.
- Delegation is disabled unless both `WKND_MCP_DELEGATION_ISSUER` and `WKND_MCP_DELEGATION_SECRET`
  (≥ 32 bytes, equal to the LLM app's `WKND_COMMERCE_ASSERTION_SECRET`) are set.
  During a key rotation, `WKND_MCP_DELEGATION_SECRET_PREVIOUS` is also accepted until cleared
  (see `docs/PROMOTIONS.md`, rotation overlap).

`placeOrder` claims the cart (`active` → `ordering`, matching the cart `revision` it validated) before
reserving stock, and `saveCart` only writes carts still in their expected status. Concurrent or
replayed placements and edits racing an order therefore create at most one order, of the cart that
was validated. A delegated `placeOrder` assertion also carries `order_expect`
(`{ grand_total, items: [[sku, qty]] }`, the cart the shopper reviewed in ChatGPT); the order is
refused with `UNABLE_TO_PLACE_ORDER` if the cart no longer matches it.

## Notes

### Link product assets from AEM Assets View

The **WKND Commerce** panel is registered separately from the Commerce admin SPA,
using `aem/assets/assetsview/1`. It is not the Workfront Asset Suitability extension.
Assets View extensibility requires Assets Ultimate and Adobe enablement.
Its web entry is `/assets.html`; the existing admin keeps `/index.html`.
Both extension descriptors share the web source and `src/commerce-runtime.yaml`
so deploying either includes both pages and action URLs. App Builder's CDN is
workspace-scoped; separate web bundles would replace one another.

1. Select the intended workspace with `aio app use -w Stage --no-input` or
   `aio app use -w Production --no-input`. Each workspace has its own catalog and links;
   the live storefront uses Production.
2. `aio app deploy -e aem/assets/assetsview/1` builds/deploys the Assets descriptor
   and shared web/runtime bundle, preserving the admin entry.
   Keep `WKND_ADMIN_IMS_ORG`, `WKND_AEM_AUTHOR_URL` and `WKND_AEM_PRODUCTS_ROOT`
   configured. Enable the published extension for the AEM environment through
   Extension Manager; deployment alone does not enable it for every environment.
3. In **Assets View**, open a product image under `/content/dam/wknd-adventures/products`,
   then select **WKND Commerce** in the Details side rail.
4. Search by product name or SKU and press Enter, then use **Add** beside a result.
   The first product enables commerce automatically. Existing links appear as compact
   rows; use a row's **Edit** action to change its gallery position or unlink it.
   Expand **Image settings** only when changing shared roles or **Use in commerce**.
   Use **Save** to apply changes or **Cancel** to restore the saved values.
   Unlinking the last product disables commerce automatically. Alternatively, turn
   off **Use in commerce** and save to exclude all existing mappings without deleting
   the asset. Approval is separate.

The panel saves only `commerce:isCommerce`, `commerce:skus`, `commerce:roles`, and
`commerce:positions`, reads them back, then applies the existing matcher immediately
to `asset_links` and schedules affected PDPs for refresh. I/O Events and nightly
reconcile use the same metadata, so they do not undo a panel save. It preserves
editorial metadata and never approves assets. The matcher applies its existing
approval rules. Native metadata form edits still follow the normal event/reconcile path.

The action requires Adobe authentication and the configured IMS organisation.
Database access uses injected server credentials, but AEM reads/writes always use
the current Assets user's token and permissions, not the privileged integration
identity. The author origin and product-root path are checked. Metadata changes
detected since loading produce a conflict; **Reload asset** before retrying.
Sling POST is used because this program does not expose metadata PATCH. Its
read-before-write revision check is not an atomic repository compare-and-swap;
avoid editing the same asset's commerce fields simultaneously.

For native Details fields, use **Settings > Metadata Forms**, copy the existing
product folder form (preserving editorial tabs), add **Commerce**, map the blueprint's
exact properties, and assign it to the product root. Use **Multi value text** for
SKU/role/position arrays; a comma-separated scalar is not the stored contract.
Keep association fields read-only in the native form and edit them through the panel
for catalog validation and immediate sync. Metadata properties use bare names
such as `commerce:skus`, not `./jcr:content/metadata/commerce:skus`.
The existing product ingestion already uses the `commerce` namespace; a fresh AEM
program must register that namespace through its Cloud Service code/configuration.

#### Enable the deployed panel

The deployed Production entry is
`https://28538-wkndcommerce.adobeio-static.net/assets.html`
(Stage uses `https://28538-wkndcommerce-stage.adobeio-static.net/assets.html`).
Opening this page by itself is not a functional preview: it needs the Assets host
to supply the selected asset and signed-in user's credentials.

In [Extension Manager](https://experience.adobe.com/aem/extension-manager), select
the target program/environment and find **WKND Commerce Product Links**. It is
registered as a **BYO extension** for **AEM Assets View**
(`aem/assets/assetsview/1`), using the Production `/assets.html` URL above.
Do not create a duplicate registration. Preview it, then enable it for that environment.
Production enablement requires a system administrator; developers can enable it
for non-production environments. See
[Adobe's Extension Manager guide](https://developer.adobe.com/uix/docs/extension-manager/feature-highlights/).

The existing Production app is already published in Exchange. Normal deployment
is skipped; `--force-deploy` updates its code but deliberately skips registration/
publication. Do not use `--force-publish` or retract the existing app merely to
add this panel. The Console API also rejects endpoint updates while the app is
published (error 942); re-approving the app in Exchange does not add a missing
extension point. The separate BYO registration avoids disrupting the published
Commerce admin. Its persisted Extension Manager ID is
`31f01f29-cbe9-463e-9fe6-8d840e2fb491`.
Stage deployment registers both extension descriptors normally.

Deployment is not environment activation or metadata-form assignment. Those steps
still need an authenticated Assets/Extension Manager session. CLI authentication
can search the catalog, but currently receives HTTP 403 reading AEM metadata, so
an end-to-end live save must be verified with an authorized Assets user. No asset
associations were changed during that blocked check.

Run focused regression checks with:
`npm test -- --runInBand test/assets-panel.test.js test/assets-panel-ui.test.js test/assets-panel-api.test.js test/linking-pdp.test.js test/variant-gallery.test.js`.

### Integration notes

- **CORS.** `ALLOWED_ORIGINS` accepts one wildcard host label, e.g.
  `https://*--masterclass-demo--znikolovski.aem.page` for branch previews.
- **Content AI.** The experimental `/adobe/experimental/aemcontentai-*` path rejects S2S tokens, so the
  stable `/adobe/contentAI` API is used instead. `gensearch` answers are shown only when `grounded`.
- **PDP prerendering.** This needs `WKND_HLX_ADMIN_API_KEY`. Without it, PDPs are still served through the
  overlay once previewed.
