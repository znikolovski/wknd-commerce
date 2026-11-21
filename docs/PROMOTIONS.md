# WKND promotions (wknd.promotions/v1)

One shared promotion engine for the storefront cart, both order paths, the protected cart-recovery
offer and thin management adapters (Commerce MCP). Frozen specification:
`wknd.promotions/v1-candidate.5`, sha256
`90260e5f65ccc929ac89f95fb7f9e98296b5330e310a8ca7fa5eb7579a01419d`.

## Modules

| File | Responsibility |
| --- | --- |
| `lib/promotion-schema.js` | Bounds, normalization, DTOs, canonical request hash, fixed error registry |
| `lib/promotions.js` | `createPromotionService` (list/get/create/update/disable, receipts, cursors, recovery worker), legacy migration, storefront runtime |
| `lib/promotion-evaluation.js` | Pure cart evaluation: sale prices first, eligible explicit coupon wins, otherwise best automatic; largest-remainder allocation; GST |
| `lib/promotion-effects.js` | Durable effect intent + global promotion invalidation (never product sale prices or PDP prerenders) |
| `lib/recovery-policy.js` | Protected recovery policy (10%, AUD 25 cap), 24h–7d cohort, entitlements, single-redemption reservation |
| `lib/shopper-audiences.js` | Fail-closed audience evidence resolver (no verified AAM provider) |
| `scripts/migrate-promotions.mjs` | Explicit idempotent migration, recovery bootstrap, storage capability check |

## Management service

```js
const { createPromotionService } = require('./lib/promotions');
const svc = createPromotionService({ store, loadCatalog: () => loadCatalog(store), cursorKey, params });
await svc.createPromotion(ctx, { idempotencyKey, promotion });
```

`ctx = { actor: { kind, subject, orgId }, correlationId }` must be built by the verified boundary
only. `kind` is `ims-operator` (individually verified IMS user/org) or `integration` (shared
server-configured credential such as the MCP shared-secret header; `subject`/`orgId` are
server-owned constants, never taken from the request). Integration actors can manage promotions
and request email runs, but cannot approve email runs (`HUMAN_APPROVAL_REQUIRED`). Results are transport-independent envelopes; adapters map `ok:false`
to tool errors without changing fields. Golden contract: `test/contract/promotions.contract.test.js`.

Storage has no multi-document transactions. Receipts, code reservations and recovery redemptions
use unique `_id` inserts; the `promotions` record is the commit point, updated by a
compare-and-swap on a private `slot`. `recoverRequests()` (scheduled worker, not an MCP tool)
resolves stale requests by rolling a proven commit forward or fencing the slot.

## Storefront

- Cart totals and coupon application use `loadPromotionRuntime` per request.
- Before `migrate-promotions` runs, the same evaluator uses built-in legacy definitions
  (`WKND10`, `TRAILREADY`). After migration only stored definitions apply.
- Migrated legacy coupons keep accepting a below-minimum cart with zero saving (TRAILREADY below
  AUD 200) and suppress automatics while retained. New coupons have no such exception.
- A stored coupon that later becomes invalid (disabled, expired, untargeted, ineligible) blocks
  both order paths with an explicit message until it is removed or replaced.
- Recovery offer GraphQL: `wkndRecoveryOffer(cart_id)` (read-only status) and
  `claimWkndRecoveryOffer(cart_id)` (issues the entitlement). The shopper then applies the
  returned code. Guests are not eligible.
- When available, the offer also returns `saving` (what the offer would take off the cart now) and
  `current_saving` (what the currently applied promotion takes off), both from the shared engine.
  They are display-only estimates; storefronts show the offer only when `saving > current_saving`.
- Coupon writes (`applyCouponToCart`, `applyCouponsToCart`, `removeCouponFromCart`,
  `removeCouponsFromCart`) save only against the cart revision they read. If another channel
  changed the cart in between, the write is refused with a GraphQL error whose
  `extensions.code` is `CART_CHANGED`. Nothing is overwritten. The client re-reads the cart and
  decides again; it must not retry blindly.
- To withdraw only the protected recovery coupon, call
  `removeCouponsFromCart(coupon_codes: [<that code>])`. If an ordinary coupon has replaced it, the
  call is a no-op. Never use `removeCouponFromCart`, which clears every coupon. Removing the
  coupon does not touch the shopper's entitlement or redemption records.
- Reviewed-version offer writes (required for delegated agents; available to every signed-in
  shopper):
  - `Cart.wknd_cart_version` is an opaque token that changes on every cart write.
  - `applyWkndRecoveryOffer(cart_id, expected_cart_version)` applies the offer only to that exact
    reviewed cart, and only if the engine says it saves strictly more than the current promotion.
    Errors: `OFFER_NOT_BETTER`, `CART_CHANGED`, `RECOVERY_OFFER_UNAVAILABLE`. It claims an
    ELIGIBLE entitlement first, which is idempotent and is not a redemption.
  - `removeWkndRecoveryOffer(cart_id, expected_cart_version)` removes only the protected coupon.
    If another coupon is applied it returns `NOT_APPLIED` and writes nothing.
  - Outcomes: `APPLIED`, `ALREADY_APPLIED`, `REMOVED`, `NOT_APPLIED`. Each returns the cart with
    its new version.
  - A delegated (LLM) caller applying a protected code through `applyCouponToCart` or
    `applyCouponsToCart` is refused with `REVIEWED_VERSION_REQUIRED`. Ordinary coupons are
    unaffected.

## Configuration

| Param | Used by | Notes |
| --- | --- | --- |
| `PROMOTION_CURSOR_KEY` | management adapter | base64 of 32 random bytes; rotating invalidates cursors |
| `RECOVERY_REDEMPTION_VERIFIED` | storefront + management | `true` only after `--verify-storage` passes against the real database |
| `PROMOTION_SELECTION` | storefront + management | `best-saving` opts into the `wknd.promotions/v2` selection gate (highest actual saving of the eligible coupon and best automatic; ties keep the coupon; a beaten coupon stays stored as `superseded`). Anything else keeps v1 explicit-coupon precedence. Set the same value on every action that prices carts or orders. |
| `AUTH0_ISSUER` | storefront | existing; binds shopper identity for recovery |
| `PROMOTIONS_DB_CLIENT_ID`, `PROMOTIONS_DB_CLIENT_SECRET`, `PROMOTIONS_DB_ORG_ID`, `DB_REGION` | migration script (local `.env`) | workspace OAuth S2S credential |

## Activation order

1. `node scripts/migrate-promotions.mjs --verify-storage` (prove unique `_id` + conditional update).
2. `node scripts/migrate-promotions.mjs --bootstrap-recovery` (legacy coupons + disabled recovery promotion).
3. Set `RECOVERY_REDEMPTION_VERIFIED=true`, deploy, then enable the recovery promotion through the
   management service with its full approved definition.
4. Schedule `recoverRequests()` (e.g. every 5 minutes).

AAM segment `27504716` (Cart Abandoners) is a content-targeting reference only. It is never
discount authorization.

## Recovery email pilot (Brevo)

`lib/recovery-email.js` sends **one** cart-reminder email per inactivity episode to signed-in
customers who explicitly opted in (`setWkndRecoveryEmailOptIn`, `Customer.wknd_recovery_email_opt_in`;
default off, never inferred from sign-in or checkout). Safety defaults:

- **Paused** until `resume()`; **test-recipient allowlist** on (`RECOVERY_EMAIL_ALLOWLIST`) until
  `RECOVERY_EMAIL_ALLOWLIST_DISABLED=true`.
- Runs: `requestRun(ctx, { maxRecipients ≤ 50 })` → `approveRun` by a **different** IMS subject,
  bound to the same template id and size, valid 24h → `executeRun({ runId })`.
- Every recipient is rechecked (consent, suppression, allowlist, 24h–7d window, no purchase since,
  offer enabled/verified, daily budget `RECOVERY_EMAIL_DAILY_BUDGET`, default 50).
- Ledger `recovery_email_ledger` is unique per campaign/customer/episode. Ambiguous provider
  outcomes become `unknown` and are never resent; HTTP 429 releases the claim for a later run.
- `status()` returns aggregate counts only — no emails or customer ids leave the service.
- Email params: `FIRSTNAME`, `CART_URL` (campaign UTM only, shopper signs in), `PERCENT_OFF`,
  `MAX_DISCOUNT`. The Brevo template must state that the store and payment are a demo and include
  Brevo's unsubscribe link.

Actions (manifest entries to add):

| Action | Type | Params |
| --- | --- | --- |
| `promotions-worker` | scheduled (~5 min), not web | DB credentials, `RECOVERY_REDEMPTION_VERIFIED` |
| `brevo-webhook` | raw web action, no IMS (optional) | `BREVO_WEBHOOK_TOKEN` (Brevo webhook `Authorization: Bearer …`) |

Suppression does not depend on the webhook: before every run `executeRun` pulls Brevo's
transactional blocked/unsubscribed contacts (`GET /v3/smtp/blockedContacts`) into
`email_suppressions` and turns off the opt-in for unsubscribes. If that call fails the run sends
nothing (`SUPPRESSION_SYNC_FAILED`) and stays approved. The webhook only shortens the delay.

### Marketing consent purposes

Consent is per purpose and never bundled or inferred (Spam Act 2003 express consent; APP 5/7):

| Purpose | Profile field | GraphQL |
| --- | --- | --- |
| `recovery` — cart reminders | `marketing.recoveryEmail` | `wknd_recovery_email_opt_in`, `setWkndRecoveryEmailOptIn` |
| `audience` — WKND news & offers | `marketing.audienceEmail` | `wknd_marketing_email_opt_in`, `setWkndMarketingEmailOptIn` |

- Mutations take `wording_version` (required to opt into `audience`) and `source` (`WEB`/`IOS`).
- Every change appends to `marketing_consent_events` (`purpose`, `optIn`, `source`,
  `wordingVersion`, `at`, hashed `subject` + `subjectKind`) as consent evidence.
- Delegated agents (the ChatGPT/LLM app) cannot change consent (`DIRECT_SIGN_IN_REQUIRED`).
- A Brevo unsubscribe (webhook or blocked-contact sync) withdraws **every** purpose; hard bounces,
  complaints and blocks suppress the address for all sends.

### Admin Promotions screen (human operators)

The ExC Shell admin has a **Promotions** screen backed by the IMS-protected
`commerce-admin/promotions` action (`lib/promotions-admin.js`). Each call runs as the signed-in
individual IMS user (`ims-operator`, subject = IMS `user_id`, org must equal `ADMIN_IMS_ORG`;
technical accounts are refused), so the shared service audits who changed what.

- Promotions: list, create (draft/disabled by default), edit with `expectedRevision`, enable/disable.
  Protected recovery terms are locked (only name/status); the service enforces it.
- Reminder emails: aggregate status, recent runs (metadata only), request a run, pause/resume and
  **approve** a run. Approval must come from a different individual than the requester — this is the
  human-verified approval path for runs requested by CX Coworker (an integration actor cannot
  approve). Execution (sending) is deliberately not exposed here.
- Params: `PROMOTION_CURSOR_KEY`, `PROMOTION_SELECTION`, `RECOVERY_REDEMPTION_VERIFIED`,
  `BREVO_RECOVERY_TEMPLATE_ID`, `RECOVERY_EMAIL_ALLOWLIST` (empty = nobody), `RECOVERY_EMAIL_DAILY_BUDGET`.

Operator tools (CX Coworker via the Commerce MCP) call `createRecoveryEmail({ store, params, brevo })`
with `brevo = createBrevoClient({ apiKey: params.BREVO_API_KEY })`: status, pause, resume,
requestRun, approveRun, executeRun. Brevo's own MCP in CX Coworker is for template/campaign drafts
and reporting; recovery sends go only through `executeRun`.
