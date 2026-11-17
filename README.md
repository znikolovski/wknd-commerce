# wknd-commerce

This is a mock **Adobe Commerce** backend for the WKND Adventures shop, built on Adobe App Builder.
It provides:
- GraphQL for the Commerce drop-ins, fronted by **API Mesh**;
- an **ExC Shell admin UI** for products, inventory, pricing and orders;
- **AEM Assets → product image linking** (Commerce custom asset matcher);
- a **Content AI** search proxy;
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
| `src/dx-excshell-1` | Admin SPA (React Spectrum) and the IMS-protected `commerce-admin/admin` RPC |
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

## Notes

- **CORS.** `ALLOWED_ORIGINS` accepts one wildcard host label, e.g.
  `https://*--masterclass-demo--znikolovski.aem.page` for branch previews.
- **Content AI.** The experimental `/adobe/experimental/aemcontentai-*` path rejects S2S tokens, so the
  stable `/adobe/contentAI` API is used instead. `gensearch` answers are shown only when `grounded`.
- **PDP prerendering.** This needs `WKND_HLX_ADMIN_API_KEY`. Without it, PDPs are still served through the
  overlay once previewed.
