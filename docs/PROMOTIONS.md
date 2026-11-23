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

### C01 restricted draft authoring (`wknd.promotion-drafts/v2`)

The additive draft service in `lib/promotion-drafts.js` stores metadata in
`promotion_drafts_v2`, **not** `promotions`. It does not call the audience resolver,
evaluation engine, promotion effects, email or recovery runtime. Frozen `wknd.promotions/v1`
remains null-only for audience restrictions. Draft IDs use `pdr_`, not live `prm_` IDs.
There is no enable/apply operation or automatic promotion of a draft into the live engine.
All results report `financialAuthorization: false` and
`activation: { blocked: true, reason: "PROVIDER_NOT_VERIFIED" }`.

Exact draft DTO:

```json
{
  "apiVersion": "wknd.promotion-drafts/v2",
  "ok": true,
  "persisted": true,
  "financialAuthorization": false,
  "activation": { "blocked": true, "reason": "PROVIDER_NOT_VERIFIED" },
  "draft": {
    "id": "pdr_0123456789abcdef0123456789abcdef",
    "revision": 1,
    "state": "draft",
    "promotion": {
      "name": "Climbing Planner draft",
      "enabled": false,
      "mode": "automatic",
      "code": null,
      "discount": { "kind": "percentage", "basisPoints": 1000 },
      "maxDiscountMinor": 2500,
      "minimumMerchandiseMinor": null,
      "target": { "kind": "all" },
      "startsAt": null,
      "endsAt": null,
      "audienceRestriction": { "environment": "stage", "key": "climbing-planner", "version": 1 }
    },
    "createdAt": "2026-11-23T00:00:00.000Z",
    "updatedAt": "2026-11-23T00:00:00.000Z"
  }
}
```

The example ID/timestamps illustrate the shape, not a live saved record. The restriction is
a required, non-null reference to configured Stage `climbing-interest` or `climbing-planner`,
version 1; raw AAM IDs, other environments/versions, caller evidence and unknown fields are
rejected. Draft validation reuses v1 term normalization; no behavior rules or membership evaluator
are copied. `enabled: true` returns `RESTRICTED_ACTIVATION_BLOCKED` before storage.

| Admin operation | MCP tool | Arguments |
| --- | --- | --- |
| `promotions.drafts.validate` | `validate_audience_promotion_draft` | `{ promotion }` |
| `promotions.drafts.create` | `create_audience_promotion_draft` | `{ idempotencyKey, promotion }` |
| `promotions.drafts.get` | `get_audience_promotion_draft` | `{ id }` |
| `promotions.drafts.list` | `list_audience_promotion_drafts` | `{ limit?, after? }` |
| `promotions.drafts.update` | `update_audience_promotion_draft` | `{ id, expectedRevision, promotion }` |
| `promotions.drafts.delete` | `delete_audience_promotion_draft` | `{ id, expectedRevision }` |

Existing IMS/integration authentication is unchanged. Drafts are organisation-scoped; actor
audit metadata stays private. Draft CRUD is separate from the MCP financial-promotion write gate,
which remains off. Create permits v1 optional term defaults plus the required restriction;
update requires every mutable definition field. List is ID-ordered, capped at 50, and returns
`nextAfter` (pass it as `after`). Update and delete use single-document revision compare-and-swap.
Delete leaves a tombstone; it does not touch a live offer or allow the create key to resurrect it.

Reuse the original UUIDv4 create key on uncertain outcomes. The deterministic actor-scoped ID
prevents duplicate drafts; a changed definition with the same key returns `IDEMPOTENCY_CONFLICT`.
Create replay returns the current draft, including any subsequent updates, without resetting it.
For update/delete conflicts or uncertain outcomes, read the draft before deciding on another write.
`REVISION_CONFLICT`, `DRAFT_NOT_FOUND`, `DRAFT_DELETED` and `INVALID_DRAFT` are explicit errors.
Database failures propagate to the existing transport's logged error path, never a simulated success.

The existing **Audience promotion drafts** picker validates/saves/opens/updates/deletes through
this same service. It edits name, canonical audience, discount and cap while preserving other
terms from opened drafts. The legacy live Promotions editor and engine are unchanged.

Run `npm run preview:promotion-authoring` and open `http://127.0.0.1:4178` for a
**local memory demonstration** of the same service. Saved metadata survives requests, but clears
on process restart; every response is labelled `localSimulation: true`,
`storage: "memory-cleared-on-restart"`. This is not a live API or proof of deployed database
persistence. Admin/MCP persistent-store integration is source-only until separately approved deployment.
No deploy, financial gate changes or live business writes are part of C01.

### C02 audience draft fixture (not a live promotion API)

Run `npm run preview:promotion-authoring`, then open `http://127.0.0.1:4178`.
The preview now demonstrates C01 draft CRUD in explicitly simulated memory. The preserved
C02 `POST /preview` fixture endpoint and MCP preview tool still return non-persisting fixture JSON.
They reuse the C01 restriction/term validator and need no credentials, live database, provider or deploy.
Stop the local server with Ctrl-C. `PORT` can select another local port.

The Stage metadata catalogue maps `climbing-interest` to AAM `27507403` and `climbing-planner`
to AAM `27507404`, both version 1. These bindings mirror the existing draft canonical registry
in `origin/feat/audience-evidence-dto` at `f9c9181` (`lib/shopper-audiences.js`, `DRAFT_STAGE_ENTRIES`).
Entries retain `status: "draft"` and `transport: "unverified"`; their source DPID and merge rule
are administrative metadata, not proof of a working identity mapping.
The catalogue has no evaluator, behavior rules, membership evidence or activation attestations.

Read-only adapters (existing IMS/MCP authentication unchanged):

- Admin `promotions.authoringAudiences`; MCP `list_promotion_authoring_audiences`.
- Admin `promotions.previewAudienceDraft`; MCP `preview_audience_promotion_draft`.

Example input to the preview operation/tool:

```json
{
  "environment": "stage",
  "audienceKey": "climbing-planner",
  "promotion": {
    "name": "Climbing planner demo",
    "enabled": false,
    "mode": "automatic",
    "discount": { "kind": "percentage", "basisPoints": 1000 },
    "maxDiscountMinor": 2500,
    "target": { "kind": "all" },
    "audienceRestriction": null
  }
}
```

Output is `schema: "wknd.promotion-authoring/fixture-v1"`, `mode: "fixture"`,
`persisted: false`, `financialAuthorization: false`, and
`activation: { blocked: true, reason: "PROVIDER_NOT_VERIFIED" }`.
`fixturePreview` contains separate `audience` metadata and the normalized, disabled `promotion`.
It is **not** a live non-null restriction DTO and must not be submitted to `create_promotion`.
Validation reuses the frozen definition validator for syntax, bounds, normalization and date order;
it does not verify current catalogue references, coupon uniqueness, membership or financial eligibility.
Unknown fields, raw audience IDs, other environments and `enabled: true` are explicitly rejected.
Invalid preview arguments return `ok: false`, `error.code: "INVALID_DRAFT"` and field errors.

**Handoff:** C01 above supplies the versioned, persisted **disabled draft** contract, shared by
admin/MCP. Frozen v1 remains null-only. Draft authoring does not depend on a financial provider;
financial activation stays blocked and future runtime integration is outside this slice.

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
  - A delegated (LLM) caller that tries to apply or remove a protected code through the generic
    coupon mutations is refused with `REVIEWED_VERSION_REQUIRED`. Removing a discount can raise
    what the shopper pays, so both directions need the reviewed version. Ordinary coupons and
    website callers are unaffected.
  - Every cart write uses the revision compare-and-set:
    - Coupon writes surface `CART_CHANGED`.
    - Item, address, shipping, payment, merge and reorder writes re-apply their own change to a
      fresh read (up to 3 attempts). They never set coupons, so they cannot overwrite a guarded
      coupon change.
    - Each write bumps `wknd_cart_version`.
  - `mergeCarts` runs exactly once, without multi-document transactions:
    1. Claim the source with a revision compare-and-set. Its status becomes `merging`, which makes
       it inactive and unchangeable.
    2. Add that snapshot to the destination once. The merge is recorded in `mergedSources`.
    3. Retire the source to `merged`.

    Every failure is an explicit error, and a claimed source is never reactivated. After a failed
    or uncertain step 2 or 3 the claim stays in place, and a repeated request completes the merge
    exactly once. A claim left on a destination that is no longer active is reclaimed by the
    shopper's next cart.

## Configuration

| Param | Used by | Notes |
| --- | --- | --- |
| `PROMOTION_CURSOR_KEY` | management adapter | base64 of 32 random bytes; rotating invalidates cursors |
| `RECOVERY_REDEMPTION_VERIFIED` | storefront + management | `true` only after `--verify-storage` passes against the real database |
| `PROMOTION_SELECTION` | storefront + management | `best-saving` opts into the `wknd.promotions/v2` selection gate (highest actual saving of the eligible coupon and best automatic; ties keep the coupon; a beaten coupon stays stored as `superseded`). Anything else keeps v1 explicit-coupon precedence. Set the same value on every action that prices carts or orders. |
| `AUTH0_ISSUER` | storefront | existing; binds shopper identity for recovery |
| `PROMOTIONS_DB_CLIENT_ID`, `PROMOTIONS_DB_CLIENT_SECRET`, `PROMOTIONS_DB_ORG_ID`, `DB_REGION` | migration script (local `.env`) | workspace OAuth S2S credential |

## Deploy input check

`aio app deploy` takes `$WKND_*` action inputs from the deploying checkout's `.env`. If a gate is
missing there, it would silently deploy in its default state. The `pre-app-deploy` hook
(`npm run deploy:check`, `scripts/check-deploy-env.mjs`) therefore refuses to deploy unless:

- `WKND_RECOVERY_REDEMPTION_VERIFIED` is explicitly set to `true` or `false`;
- `WKND_PROMOTION_SELECTION` is explicitly set to `best-saving` or `explicit-first`;
- `WKND_AUTH0_ISSUER` and `WKND_AUTH0_AUDIENCE` are set.

It prints only the namespace, variable names and the allowed gate values, never secrets.
Variables the manifest references but `.env` doesn't declare are listed as warnings. To deploy a
gate off, set it to its off value explicitly. Use `--env=<path>` to check another checkout.

## Delegation secret per environment

Stage and Production must use **different** `WKND_MCP_DELEGATION_SECRET` values. They share the
Auth0 tenant, MCP issuer and audience, so with one shared secret a Stage-signed assertion would
also be accepted by Production. `test/delegation.test.js` proves cross-environment rejection with
independent synthetic keys.

Rotation is prepared, then activated in one coordinated step:

1. **Prepare.** Put the new Stage value in `WKND_MCP_DELEGATION_SECRET_NEXT` in the Stage deploy
   `.env`. No manifest maps it, so no deploy picks it up. Hand it to the LLM signer through a
   mode-600 local file, never chat, logs or Git.
2. **Activate (separately approved).**
   - Move NEXT into `WKND_MCP_DELEGATION_SECRET` (Stage only) and deploy Stage actions.
   - At the same time, set the LLM Apps **Stage** server-side secret
     `WKND_COMMERCE_ASSERTION_SECRET` to the same value, set `WKND_COMMERCE_GRAPHQL_URL` to the Stage
     `storefront-graphql` URL, and redeploy LLM Stage.
3. **Verify.** A Production-signed assertion is refused by Stage. Production is never called with
   a Stage assertion.

### Rotating a live key without a gap (rotation overlap)

`MCP_DELEGATION_SECRET_PREVIOUS` (`$WKND_MCP_DELEGATION_SECRET_PREVIOUS`) is an optional second key,
accepted only while set. Empty or undeclared means single-key behaviour. The deploy check refuses a
previous key that equals the current one, is shorter than 32 bytes, or has no current key, and it
prints only `delegationOverlap=true|false`. Claim, scope, lifetime and `jti` replay checks are the same
for both keys, so a `jti` is accepted once across both.

1. **Prepare.** Generate the new value into a mode-600 file and stage it as the unmapped
   `WKND_MCP_DELEGATION_SECRET_NEXT` in that environment's deploy `.env`. Edit `.env` files with a
   parser (never `source` them in a shell; error output can print values).
2. **Commerce: accept both.** Set `WKND_MCP_DELEGATION_SECRET` to the new value and
   `WKND_MCP_DELEGATION_SECRET_PREVIOUS` to the old one, deploy actions only. Verify both keys
   are accepted and the other environment's key is refused.
3. **Signer: switch.** The LLM app sets `WKND_COMMERCE_ASSERTION_SECRET` to the new value (without
   reading it back) and redeploys that environment.
4. **Commerce: drop the old key.** Clear `WKND_MCP_DELEGATION_SECRET_PREVIOUS`, deploy actions only.
   Verify the old key is refused and the new key is accepted. Remove the old value from every other
   checkout that could deploy to that namespace.

Rollback. While the overlap is deployed, both keys are accepted, so a signer on either key keeps
working. Never remove the overlap until the signer runs on the new key and a signed-in read with it
is verified.

- **Before the signer switches** (it still signs with the old key): restore the old value as
  `WKND_MCP_DELEGATION_SECRET` and clear `WKND_MCP_DELEGATION_SECRET_PREVIOUS`, then deploy actions
  only. Only after that, if needed, revert the verifier code to the previous action versions. Do not
  redeploy previous action versions while the current key is still the new one: the old signer
  would be refused.
- **After the signer switches**: roll the signer back to the old value while the overlap still
  accepts both keys, verify, then restore the old current key as above.
- **After step 4**: set the previous key again only if the signer still uses it.

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
  Entries are exact addresses (`name@example.com`) or whole domains (`@example.com`). A domain
  entry matches only that exact domain, not subdomains. The demo uses
  `@adobe.com,jaggah@gmail.com,znikolovski24@gmail.com` in both environments.
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

Actions:

| Action | Type | Params |
| --- | --- | --- |
| `promotions-worker` | scheduled (~5 min), not web | DB credentials, `RECOVERY_REDEMPTION_VERIFIED`, `BREVO_API_KEY`, `BREVO_RECOVERY_TEMPLATE_ID`, `RECOVERY_EMAIL_ALLOWLIST`, `RECOVERY_EMAIL_DAILY_BUDGET` |
| `brevo-webhook` | raw web action, no IMS (optional) | `BREVO_WEBHOOK_TOKEN` (Brevo webhook `Authorization: Bearer …`) |

Suppression does not depend on the webhook: before every run `executeRun` pulls Brevo's
transactional blocked/unsubscribed contacts (`GET /v3/smtp/blockedContacts`) into
`email_suppressions` and turns off the opt-in for unsubscribes. If that call fails the run sends
nothing (`SUPPRESSION_SYNC_FAILED`) and stays approved. The webhook only shortens the delay.

Sending is done by `promotions-worker` via `executeNextApprovedRun`:

- Each tick (~5 min) it executes at most the **oldest approved** run, using every guard above.
- Without `BREVO_API_KEY` it does nothing (`not-configured`).
- While paused it returns `skipped/PAUSED` and the run stays approved until it expires.
- The worker never receives `RECOVERY_EMAIL_ALLOWLIST_DISABLED`, so deployed sends are always
  limited to the allowlist. With an empty allowlist a run completes with zero sends.
- Set `WKND_BREVO_API_KEY` in the deploy `.env` (git-ignored); never commit or paste it.

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
