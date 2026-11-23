# Target AAM diagnostic (Stage only) — inert runtime integration

Status: **implemented, inert, OFF by default. Not deployed.**
- `actions/target-diagnostic` (manifest entry, deploy gate), `lib/target-diagnostic-action.js`,
  `lib/target-diagnostic.js`, `lib/target-id-binding.js`, `lib/target-binding-store.js` and
  `lib/id-linkage-consent.js` exist, with offline tests.
- With the manifest defaults (every `WKND_TARGET_*` empty), the action answers 404 and touches
  nothing.
- Nothing calls Target, Audience Manager or the ID Service until the live acceptance gates below are
  approved and their flags are set for a Stage deploy.
- Production is refused at deploy time and at runtime (environment and namespace).

## What it asks and what the answer means

- Isolated diagnostic activity (Form-based / API, Default Workspace), mbox
  `wknd-aam-stage-eligibility-v1`, remote decisioning only (no on-device rules, no prefetch).
- Experiences, in this order: AAM `27507404` → `climbing-planner`, AAM `27507403` →
  `climbing-interest`, All Visitors → `control`.
- Each experience returns exactly one JSON offer, with no other keys:
  `{schema:'wknd.target-aam-diagnostic/v1', environment:'stage', marker, financialAuthorization:false}`.
- Result: `wknd.target-aam-diagnostic-result/v1` `{status:'decided', marker}` or
  `{status:'unavailable', reason}`, plus `evidence:false`, `financialAuthorization:false`,
  `requestId` and `latencyMs`. It carries no identifiers.

A decision is **not** audience evidence:

- no `complete:true`, evaluated/fetched/expiry times, merge rule, segment version or TTL;
- `control`, no decision, an unexpected offer, an error or a timeout never mean "not qualified";
- the module does not import promotions, cart, orders, the store or `shopper-audiences`;
- PR #8 and its eight activation gates are unchanged.

## Trust rules (enforced in code and tests)

- Customer ID: always the Auth0-**verified** `sub`, sent as `customerIds:[{id, integrationCode:
  'wkndCustomerId', authenticatedState:'authenticated'}]`. This matches the storefront's
  `identityMap.wkndCustomerId` (raw Auth0 `sub`, `scripts/customer-identity.js`) and AAM source 1547309.
- ECID, DCS `locationHint` and AAM `blob` come only from a server-side binding provider, marked
  `source:'server-issued'`. The binding is validated: ECID is 38 digits, the hint is an integer ≥ 1,
  the blob is non-empty and at most 1024 bytes.
- Caller-supplied ECID, customer IDs, location hint, blob, property, mbox or offer values are never read.
- Pilot allowlist: `TARGET_DIAG_SHOPPER_KEYS` holds server-derived `shopperKey(AUTH0_ISSUER, sub)`
  values.
- The default provider is `unavailableBindingProvider`, so the result is `unavailable` /
  `no-trusted-binding` until a supported issuance path is verified.

## Trusted ECID binding: feasibility (implemented inert; not live-verified)

Target's server-side Audience Manager integration requires **all three** of these
([Target: AAM segments](https://experienceleague.adobe.com/en/docs/target-dev/developer/server-side/integration/aam-segments)):

- `marketingCloudVisitorId`;
- `experienceCloud.audienceManager.locationHint` (≥ 1);
- a non-blank `blob` (≤ 1024 bytes).

| Candidate | Supplies | Assessment |
|---|---|---|
| **A. Server-side direct ID-service call** ([direct integration](https://experienceleague.adobe.com/en/docs/id-service/using/implementation/direct-integration)): `dpm.demdex.net/id?d_orgid=…&d_ver=2` plus optional `d_cid=1547309%01<verified sub>%011` | `d_mid` (ECID), `dcs_region` (location hint), `d_blob`, `id_sync_ttl` (7 days by default) | **Leading candidate.** Documented for devices that cannot run VisitorAPI. See the open points below. |
| B. Edge first-party device ID (FPID): a server-derived UUIDv4 in `identityMap.FPID` seeds a deterministic ECID ([FPID](https://experienceleague.adobe.com/en/docs/experience-platform/collection/identity/fpid)) | ECID only | Gives a stable, server-controlled ECID, but **no AAM blob or location hint**, so it does not meet the Delivery API integration requirements on its own. Each call is also an Edge event with datastream side effects. |
| C. Browser-relayed ECID / AMCV / Web SDK identity | — | **Rejected.** This is caller authority. |
| D. Server-only `customerIds` without an ECID | — | **Rejected.** Target documents ECID, hint and blob as required. |

Open points for candidate A (each one blocks a Stage call):

1. **Side effects.** Is a `d_cid` call with an authenticated declared ID a DCS event that links a new
   device to the CRM profile or triggers real-time evaluation? Is a call without `d_cid` acceptable?
2. **Stability.** `d_mid` is minted by Adobe and cannot be derived. A stable binding needs a
   server-stored `{shopperKey → ecid, locationHint, blob, issuedAt}` record in a diagnostic-only
   collection, refreshed per `id_sync_ttl` and blob lifetime.
   - That is a new persistent write and needs separate approval.
   - The alternative, minting a fresh ECID on every call, creates device-profile churn linked to the
     shopper.
3. **Merge rule.** Which AAM merge rule do Target's shared audiences evaluate? The pilot rule is
   CURRENT/NONE `1547344`, the authenticated profile only. A newly minted ECID has no device traits,
   so qualification must come from the authenticated profile. This is unproved.
4. **Regional and IP effects** of server-originated calls: the server IP sets `dcs_region` and the
   geography.
5. **Isolation.** The ECID binding must be per environment and per shopper. Logout, account switch
   and withdrawal must invalidate the stored binding.

## Runtime integration (inert): `actions/target-diagnostic`

A raw web action in the `commerce` package (`app.config.yaml`, `final` inputs). Logic lives in
`lib/target-diagnostic-action.js`. Every gate is server configuration from the manifest; callers cannot
set or override any of it (raw body, no query merge, `final`). The Runtime namespace comes from the
platform environment, never from a parameter. **Every `WKND_TARGET_*` input is optional and deploys
empty, which means OFF.**

| Request (POST, `Authorization: Bearer <Auth0 access token>`) | Result |
|---|---|
| `{ op:'consent-status' }` | `{ status:'ok', consent: granted\|withdrawn\|absent\|unknown }` |
| `{ op:'consent', optIn:true, wordingVersion, source? }` | Explicit first-party grant: `{ status:'ok', consent, changed }` |
| `{ op:'consent', optIn:false, source? }` | Withdrawal, always allowed once the base gate passes |
| `{ op:'decide' }` | The inert diagnostic result: a marker or `unavailable` with a category. `evidence:false`, `financialAuthorization:false` |

**Gate order.** Each gate fails closed, and a refusal touches nothing.

| # | Gate | Refusal | Never called on refusal |
|---|---|---|---|
| 1 | `TARGET_DIAG_ENABLED=true`, `TARGET_DIAG_ENVIRONMENT=stage`, a `-stage` namespace, Auth0 issuer/audience, a non-empty allowlist | 404 `disabled` / `not-stage` / `not-configured`, with no CORS headers | Auth0, store, ID Service, Target |
| 2 | No `X-WKND-Delegation` header. Delegated agents never grant. | 403 `delegated-not-allowed` | Auth0, store |
| 3 | A valid Auth0 RS256 token (`lib/auth.js` `verifyToken`) | 401 `unauthenticated` | store |
| 4 | `shopperKey(AUTH0_ISSUER, sub)` is allowlisted | 403 `not-allowlisted` | store |
| 5 | A strict JSON body with a string op owned by the operation allowlist (no inherited names), containing only that op's fields | 400 `invalid-request` | store |
| 6 | Grant: `TARGET_ID_LINKAGE_ENABLED=true` and the wording in `TARGET_ID_LINKAGE_WORDING_VERSIONS` | 403 `linkage-disabled` / `wording-not-approved` | store |
| 7 | Decide: linkage enabled, `TARGET_ID_BINDING_STORE_APPROVED=true`, `TARGET_ID_SERVICE_ENABLED=true`, org, DPID, bounded `TARGET_ID_TIMEOUT_MS` / `TARGET_ID_LEASE_MS` / `TARGET_DIAG_TIMEOUT_MS`, Target client and property | 503 `not-approved` with the gate's **name** | store, ID Service, Target |

- **Deploy gate** (`lib/deploy-env.js`, the pre-app-deploy hook):
  - every `WKND_TARGET_*` input is optional;
  - each flag must be `true`, `false` or empty;
  - any flag set to `true` outside a `-stage` namespace, or the diagnostic enabled without
    `WKND_TARGET_DIAG_ENVIRONMENT=stage`, refuses the deploy.
- **Package inputs.** Like every action in the `commerce` package, this one inherits the package-level
  inputs (`HLX_*`, `AEM_*` and so on). It never reads them: `CONFIG_KEYS` is an explicit allowlist.
- **Responses and logs** carry fixed categories only: op, HTTP status, status, reason,
  `bindingReason`, gate name, and the error name/code for unexpected failures. They never carry
  tokens, `sub`, shopper keys, ECIDs or blobs. There is no silent success fallback: an unexpected
  error is a 500 `internal`.
- **Isolation.** Promotions, cart, orders, `shopper-audiences` and the GraphQL schema are untouched,
  and no Mesh change is needed.

### ID-linkage consent purpose (`lib/id-linkage-consent.js`)

- **Separate and optional.**
  - It is not one of the email `CONSENT_PURPOSES`, and email opt-ins never imply it.
  - It is stored with generation-conditional `updateOne` operations on the customer document:
    `idLinkage: { state, grantId, source, wordingVersion, updatedAt }`.
  - `grantId` is a server-issued UUID per grant and serves as the **generation token**.
- **Granting** needs all of the following:
  - a verified Auth0 `sub` that is not delegated;
  - source `account-settings` or `ios`;
  - an approved wording version (none is approved by default);
  - an existing customer record, created by a website sign-in.

  A grant first reserves a non-authorizing `pending` generation. Only after its
  `marketing_consent_events` evidence succeeds can that same pending generation become `granted`.
  Pending consent maps to `unknown`: no binding issuance, reuse, ID Service call or Target decision.
  Concurrent grants while pending return `CONFLICT`. Evidence failure withdraws only that pending
  generation; activation after withdrawal or reconsent returns `CONFLICT`, never resurrecting or
  overwriting newer consent. No failed-generation binding can issue while evidence is pending.
  Granting again while granted keeps the same grant, so there is no ECID churn.
  Interrupted grants recover without touching newer generations:
  - Evidence recorded but the activation write failed: the request fails with `ACTIVATION_PENDING`
    (503 `activation-pending`, never success) and stays `pending`. The next grant finds that
    generation's evidence and, if its wording is still approved, activates exactly that `grantId`.
  - A reservation with no evidence (for example the evidence-failure revert also failed) is
    superseded by a new grant only after `PENDING_LEASE_MS` (60s, bounded, not an SLA) has passed
    since it was reserved. Within the lease it may still be in flight, so the result is `CONFLICT`.
  - Every recovery write is conditional on the pending generation's `grantId`, so it can never
    overwrite a later withdrawal or regrant.
- **Withdrawal** is always allowed.
  - It conditionally withdraws the current pending or granted generation first, then removes bindings
    matching both `sha256(sub)` and that generation, then appends evidence. Delayed cleanup cannot
    delete a newer grant's binding. Evidence failure is explicit and sanitized; withdrawal stays effective.
  - A Brevo unsubscribe (`recordSuppression`, which withdraws every purpose) attempts every
    authoritative state change (linkage for each matching customer, then both email purposes)
    regardless of the others' failures, and only then reports errors: state failures first, then
    linkage `EVIDENCE_FAILED`, then email `EVIDENCE_FAILED`. Email evidence is written only when the
    email state change succeeded. It withdraws an existing pending or granted generation the same
    way and **can never grant**. With no grant it is a read-only query; it writes nothing
    and never touches the binding collection.
  - Withdrawing an email purpose (`setMarketingConsent(false)`) does **not** withdraw linkage, because
    the purposes are separate.
- **Consent source.** `createIdLinkageConsentSource(store, { issuer })` maps the customer document to
  granted / withdrawn / absent / unknown. A shopper key that does not derive from the verified `sub`
  is unknown.

### Timing windows (consent generation)

| Window | Guard | Test |
|---|---|---|
| Withdrawal before the issuance claim | Pre-claim consent check | provider: consent withdrawn |
| Between the first check and the claim | Post-claim authoritative check | provider: post-claim check |
| During the ID Service call | Withdrawal removes the claim (it carries `subject`); the final `put(ifMatch: claim)` fails with `cas-conflict` | id-linkage: in-flight withdrawal |
| After `resolve`, before the Target request | `confirm()` (same `grantId`) immediately before sending. If it fails, nothing is sent. | diagnostic: before the Target request |
| During the Target request | `confirm()` again before returning. A withdrawal or reconsent gives `consent-changed` with no marker. | diagnostic and action: during the Target request |

A request that has already reached Adobe (ID Service or Target) **cannot be recalled**. The ECID ↔
declared-ID link that was already transmitted is not deleted by local withdrawal (see the live gates
below).

## Binding provider lifecycle: `lib/target-id-binding.js`

`createIdServiceBindingProvider({ orgId, dpid, consent, store })` implements candidate A. It is wired
only by `actions/target-diagnostic` for `op:'decide'` after every decide gate passes. The adapter's
default provider is still `unavailableBindingProvider`.
- `resolve` returns a binding with its `consentGrantId`, or `{ source:'unavailable', reason }`, where
  the reason comes from `BINDING_REASONS` and never carries identifiers.
- `confirm()` re-checks the same grant.

- **Request:** `GET https://dpm.demdex.net/id?d_orgid=…&d_ver=2[&d_mid=<stored ECID>]&d_cid=<DPID>%01<verified sub>%011`.
  - No traits, `d_cb`, headers, cookies, browser identifiers or caller input.
  - `redirect:'error'`, `credentials:'omit'`, with a timeout.
- **Response:** documented wire types only. `d_mid` must be a 38-digit string. `dcs_region` and `id_sync_ttl`
  must be JSON integers or decimal digit strings; booleans, arrays, floats, signs and exponents are
  rejected. `dcs_region` must be ≥ 1, and `d_blob` non-empty and at
  most **512 bytes**. 512 is the ID Service's own documented limit; the Target adapter keeps the
  Delivery API's 1024-byte limit.
- **`id_sync_ttl`** is the documented re-synchronization interval, **not** membership expiry. It sets
  only `resyncAt`. A missing or implausible value (over 30 days) means "do not reuse".
- **Unconfigured unless all are present:** a valid org, a DPID, `consent.lookup`, a CAS store
  (`get`/`put`/`remove`), and a lease of at least two ID Service timeouts. The legacy boolean
  `consent.allowed()` is not accepted.

### Consent provider interface (implemented by `lib/id-linkage-consent.js`)

`consent.lookup({ shopperKey, sub })` must return one of:

| Answer | Meaning | Provider action |
|---|---|---|
| `{ state:'granted', grantId }` | Current opt-in. `grantId` (1–128 chars `[A-Za-z0-9._:-]`) identifies that specific grant, e.g. the opt-in event ID. | Issue or reuse, only within the same `grantId`. |
| `{ state:'withdrawn' }` | Explicit opt-out. | Remove the binding; issue nothing. |
| `{ state:'absent' }` | No consent record, e.g. never asked or erased. | Remove the binding if one exists; write nothing otherwise. |
| A throw, or anything else (bare `true`, a missing or malformed `grantId`, unknown states) | Unknown. | Deny, and change **nothing**: no store write, removal or ID Service call. |

Unknown never removes, because an outage is not a withdrawal and removal would cause ECID churn.
Unknown never issues either, so a withdrawal during an outage is still honoured.

Only the separate ID-linkage purpose backs this interface. `marketing.recoveryEmail` and
`marketing.audienceEmail` are email purposes, and consent is never bundled or inferred
(docs/PROMOTIONS.md).

### Lifecycle paths (each is pinned by a test in `test/target-id-binding.test.js`)

| Path | Behaviour |
|---|---|
| Cold start (no record) | Claim with create-if-absent, re-check consent, then make one ID Service call **without** `d_mid`. Bind `{shopperKey, consentGrantId, ecid, locationHint, blob, issuedAt, resyncAt}`. |
| Reuse before `resyncAt` | No ID Service call. Consent is still looked up on every resolve. |
| Resync / concurrent refresh | One lease holder sends the stored ECID as `d_mid`. A different returned ECID is refused, and the prior ECID is kept in the lease for the next attempt. Concurrent callers get unavailable rather than making a second call. |
| ID Service failure | Unavailable. The lease lapses; nothing is bound. |
| Consent missing / withdrawn | The binding is removed (conditional on the etag that was read) and nothing is issued. |
| Consent failure / malformed | Deny, no mutation. |
| Withdrawal while issuance is in flight | Claim **before** the authoritative consent check. A withdrawal that lands later removes the claim, so the final `put(ifMatch: claim)` fails and nothing is resurrected. |
| Reconsent (new `grantId`) | A new ECID is minted without `d_mid`, even if no resolve observed the withdrawal. The old ECID is never sent again. |
| Account switch | Bindings are keyed by `shopperKey(AUTH0_ISSUER, sub)`. A first issuance never sends `d_mid`; there is no cookie jar; another shopper's ECID is never reused. A record whose `shopperKey` differs from its key is never reused, sent or overwritten; it fails closed. |
| Logout | No provider action, by design. See the proof below. |
| Withdrawal / erasure push | `invalidate(shopperKey)` is an unconditional, idempotent removal for the consent owner to call **after** flipping consent. |

**Logout proof (tests).**
- Without verified claims, the adapter returns `unauthenticated` and never calls `resolve`, so the
  binding is not read, issued or changed.
- The binding is never sent to the browser: the adapter result contains no ECID, blob, `sub` or
  shopper key.
- After a same-device account switch, only the new shopper's own binding is sent. Logging back in
  reuses the original binding without minting a new one.
- Invalidating on logout would mint a new ECID linked to the same `sub` at every sign-in, which is
  device-profile churn.
- Residual risk, at the auth layer and not specific to the binding: an Auth0 access token stays valid
  until its `exp`. `lib/auth.js` requires `exp`, and logout does not revoke the token. A leftover
  token reveals only an inert marker.

### Store CAS contract and cold start (`lib/target-binding-store.js`; live collection not approved)

- `get(key)` returns `{ etag, record }` or `null`.
- `put(key, record, { ifMatch })` returns the new etag, or `null` if the precondition fails.
  `ifMatch: null` means create-if-absent.
- `remove(key, { ifMatch? })` removes conditionally; without `ifMatch` it is unconditional.
- **Etags are opaque and never reused for a key, even after a removal.** Random UUIDs qualify; a
  counter that restarts after a delete does not, because a stale holder's write could then match.
- Implemented on the existing store pattern (the same primitives as the `lib/cart.js` CAS):
  - create-if-absent: `insertOne`, with a duplicate-key error meaning `null`;
  - conditional update: `updateOne({_id, etag}, {$set})` succeeding only when `matchedCount === 1`;
  - removal: `deleteOne({_id[, etag]})`.
- Records have three states: `issuing` (a lease with `leaseUntil` and `priorEcid`), `bound`, and
  removed.
  - A live lease is never pre-empted.
  - A lapsed lease (from a crashed holder) is taken over, keeping `priorEcid`.
  - A holder that has been taken over cannot overwrite the newer binding.
- **Cold start:** the provider keeps no in-memory state, so a new action instance behaves exactly like
  a warm one. An empty or lost store is indistinguishable from a first issuance and mints a new ECID.
  Data loss therefore causes churn but is never reused across shoppers.

### Code done vs. live acceptance gates

**Implemented and tested offline (this PR):**

- the consent purpose;
- the authoritative consent source;
- the CAS binding-store adapter;
- withdrawal call sites (shopper withdrawal and Brevo unsubscribe), with binding removal;
- the Stage-only action and manifest entry;
- the deploy gate;
- strict wire parsing;
- categorized errors;
- the consent re-checks before sending and before exposing a result.

**Live acceptance gates.** These need approval or evidence, not code; each blocks enabling a flag.

1. **Wording / legal.** Approve the ID-linkage consent wording and add its version to
   `WKND_TARGET_ID_LINKAGE_WORDING_VERSIONS`. The storefront UI for the grant is not built; it would
   call `op:'consent'` with the shopper's Auth0 token.
2. **Backend CAS.** Approve the `target_id_bindings` collection, then verify on Stage App Builder
   Database Storage that:
   - a duplicate `_id` insert fails;
   - `updateOne({_id, etag})` reports `matchedCount` 0 or 1;
   - `deleteOne` / `deleteMany` behave as expected;
   - a missing collection is a not-found error.

   Then set `WKND_TARGET_ID_BINDING_STORE_APPROVED`.
3. **Adobe ID Service call** (`WKND_TARGET_ID_SERVICE_ENABLED`):
   - `d_cid` with authenticated state 1 **transmits the authenticated DPUID to DCS**. Its side effects
     (DCS event, device-to-profile linking) must be accepted.
   - The effect of the server IP on `dcs_region` is unknown.
   - `d_blob` freshness between resyncs is unknown (the blob is not membership).
4. **Merge rule.** The pilot rule 1547344 is Current Authenticated + No Device, which is evaluated **in
   real time only**. There is no assurance that a server-minted ECID is ever evaluated under it. This
   must be proven by a live experiment, not inferred from daily reports or API permissions.
5. **Upstream deletion.** Removing a binding locally does not delete the link Audience Manager already
   holds. A Privacy Service or AAM deletion path is needed before personal data is linked.
6. **Live qualification acceptance.** Activating activity 689010 and reading a real decision are
   separate approvals. A decision is never evidence, and report absence is never negative.
7. **Tuning.** The lease (default 10s) and timeouts (default 2s) are bounded configuration, not SLAs;
   measure them on Stage.

There is no account erasure flow in the repository, and this PR does not invent one.

## Reading Audience Manager reports (latency, not evidence)

Reports are a coarse, delayed confirmation of whether the AAM setup works for the pilot. They are not
qualification evidence for any shopper, and they never authorize money. Sources:
[qualification reference](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/features/traits/trait-and-segment-qualification-reference)
and [reporting timeframes](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/reference/reporting-file-transfer-timeframe).
These are Adobe's general guidelines, not SLAs.

**Latency**

| Event | Earliest visibility |
|---|---|
| A rule-based trait is created | Users start qualifying about 4h later. Activity before that is not expected to qualify. |
| A qualification on UTC day D | Real-time Segment Population / Unique Trait Realizations on day D+1. Today's real-time figure covers yesterday, 00:00–23:59:59 UTC. |
| The same qualification | Total Segment / Trait Population is a further 24h behind the real-time figure, so D+2 at the earliest. |
| General Reports | Usually updated by 18:00 UTC daily, not guaranteed. |
| Onboarded (file-ingested) data | Up to 48h from upload to reporting and activation. |

**Interpretation rules**

- An empty or zero report is **inconclusive**, never negative. This applies:
  - on the qualification day;
  - for a Total population before D+2;
  - before that day's General Reports have updated;
  - within 48h of an inbound file.
- A non-zero population confirms that *some* device or profile qualified. It does not confirm that
  any particular shopper qualified, it is not `complete:true`, and it is not a merge-rule result. It
  cannot feed `shopper-audiences`, promotions or the diagnostic result.
- Reports are read only, by the coordinator. Nothing in this repository reads, stores or acts on them.

## Activation prerequisites

- Target configuration is confirmed read-only.
  - Activity 689010 is saved and **inactive**: Default Workspace, mbox
    `wknd-aam-stage-eligibility-v1`, property 1832 "AGS API". The activity's property dialog shows
    the same `at_property` token.
  - Offers 2377794 / 2377795 / 2377796 have exactly the contract keys.
  - Analytics reporting goes to `ags050wkndaamstage`, for both the activity and its goal.
  - Client code `adobeinternalags050`.
  - The numeric workspace IDs differ (property 864785625, activity 26132544), which may be legacy or
    product-profile IDs. The token association itself is verified.
  - Activation is not approved.
- Every live acceptance gate above is approved, and its flag is set only in the Stage `.env`.
- A Stage deploy of the existing manifest entry is explicitly approved.
- No Production deployment, customer/cart/order writes, emails or financial coupling.
