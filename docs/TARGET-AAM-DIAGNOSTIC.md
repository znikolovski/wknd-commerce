#  Target AAM diagnostic (Stage / Production) — OFF by default

Status: **implemented, inert, OFF by default. Not deployed.**
- `actions/target-diagnostic` (manifest entry, deploy gate), `lib/target-diagnostic-action.js`,
  `lib/target-diagnostic.js`, `lib/target-id-binding.js`, `lib/target-binding-store.js` and
  `lib/id-linkage-consent.js` exist, with offline tests.
- With the manifest defaults (every `WKND_TARGET_*` empty), the action answers 404 and touches
  nothing.
- Nothing calls Target, Audience Manager or the ID Service until the live acceptance gates below are
  verified and their flags are deliberately configured in the selected workspace.
- Stage and Production are supported; neither is enabled by this change. Production approval is in
  scope, not a blanket prohibition. No deployment, live calls or flag activation occurred.
- Legal review is not a project prerequisite. Wording-version configuration requires operational-owner
  approval, not an assertion of legal approval.

## What it asks and what the answer means

### Public person-binding source contract (not live approval)

The raw web action `commerce/target-diagnostic` accepts authenticated POSTs with
`{op:"person-binding"}`, `{op:"person-status"}` or `{op:"person-withdrawal"}`.
The existing verified Auth0 bearer, exact Runtime environment, shopper allowlist
and direct-shopper-only checks apply. No caller alias or grant is accepted.
`person-status` reads only; `person-binding` atomically creates a stable random
`wpa_` plus 32 lowercase hex person alias in `person_aliases_v1`, scoped by
verified issuer/shopper and environment. It never substitutes an ECID or exposes
the Auth0 subject. Source approval additionally requires
`WKND_TARGET_PERSON_ALIAS_APPROVED=true`; it defaults OFF.

Responses use `apiVersion:"wknd.person-binding/v1"`, `purpose:"idLinkage"`, `status`, `consent`,
`binding` and `semanticAllowlist:[]`, plus the existing environment/evidence/
financialAuthorization envelope. A granted binding contains `source:"server-issued"`,
`purpose:"idLinkage"`, `personAlias`, `environment`, `runtimeNamespace`, `orgId`, `dpid`,
`namespace:"wkndCustomerId"`, `issuer` (this action's HTTPS URL),
`consentGeneration`, `issuedAt`, `expiresAt` and `freshnessMs:300000`.
Expiry is exclusive, five minutes after issuance, and is NOT membership expiry.
Refresh before use; the server checks the authoritative consent generation and
stored mapping, not a client-provided DTO. Repeated issuance uses the same mapping;
withdrawal is naturally idempotent and never grants consent. Withdrawal returns
`binding:null`, `revoked:true`, `upstreamDeletionConfirmed:false`; no AAM deletion,
membership migration or device reset is claimed.

When explicitly approved, Target binding uses this same mapping as its declared
ID. Existing raw-sub bindings are retained as retirement-pending, never silently
relinked or claimed migrated. The AAM collection adapter and canonical semantic
rule mappings are **missing**: `person-event` returns 503
`canonical-rule-unavailable`; no semantic names or args are approved.
Neither navigation nor quiz completion is rewritten as a page view.

- Existing **Stage** isolated diagnostic activity (Form-based / API, Default Workspace), mbox
  `wknd-aam-stage-eligibility-v1`, remote decisioning only (no on-device rules, no prefetch).
- Experiences, in this order: AAM `27507404` → `climbing-planner`, AAM `27507403` →
  `climbing-interest`, All Visitors → `control`.
- Each experience returns exactly one JSON offer, with no other keys:
  `{schema:'wknd.target-aam-diagnostic/v1', environment:'stage', marker, financialAuthorization:false}`.
- Result: `wknd.target-aam-diagnostic-result/v1` `{status:'decided', marker}` or
  `{status:'unavailable', reason}`, plus `evidence:false`, `financialAuthorization:false`,
  `requestId` and `latencyMs`. It carries no identifiers.
- Production uses only `wknd-aam-production-eligibility-v1` and offers with `environment:'production'`.
  Stage activity **689010 must never be repurposed**. No Production activity has been created; its
  future property, client, reporting configuration and separate activity need actual platform
  verification before `WKND_TARGET_DIAG_TARGET_CONFIG_APPROVED=true`. A syntactically valid token or
  copied Stage property/client is not verification. A Stage mbox or Stage offer cannot become a
  Production result. Every response (including consent/errors) carries the configured environment
  (`null` if unconfigured), `evidence:false` and `financialAuthorization:false`.

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
| `{ op:'retirement', step:'submit' }` / `{ op:'retirement', step:'observe' }` | Separately gated, owned device retirement; HTTP submission and code-171 observation remain incomplete, never release the retained MID |

**Gate order.** Each gate fails closed, and a refusal touches nothing.

| # | Gate | Refusal | Never called on refusal |
|---|---|---|---|
| 1 | `TARGET_DIAG_ENABLED=true`, environment `stage` or `production`, exact namespace map match, Auth0 issuer/audience, a non-empty allowlist | 404 `disabled` / `invalid-environment` / `namespace-not-configured` / `namespace-mismatch` / `namespace-overlap` / `not-configured`, no CORS headers | Auth0, store, ID Service, Target |
| 2 | No `X-WKND-Delegation` header. Delegated agents never grant. | 403 `delegated-not-allowed` | Auth0, store |
| 3 | A valid Auth0 RS256 token (`lib/auth.js` `verifyToken`) | 401 `unauthenticated` | store |
| 4 | `shopperKey(AUTH0_ISSUER, sub)` is allowlisted | 403 `not-allowlisted` | store |
| 5 | A strict JSON body with a string op owned by the operation allowlist (no inherited names), containing only that op's fields | 400 `invalid-request` | store |
| 6 | Grant: `TARGET_ID_LINKAGE_ENABLED=true` and the wording in `TARGET_ID_LINKAGE_WORDING_VERSIONS` | 403 `linkage-disabled` / `wording-not-approved` | store |
| 7 | Decide: linkage enabled, nonempty approved wording versions, `TARGET_ID_BINDING_STORE_APPROVED=true`, `TARGET_ID_SERVICE_ENABLED=true`, org, DPID, bounded timeouts/lease, Target client/property; Production also `TARGET_DIAG_TARGET_CONFIG_APPROVED=true` | 503 `not-approved` with the gate's **name** | store, ID Service, Target |

- **Deploy gate** (`lib/deploy-env.js`, the pre-app-deploy hook):
  - every `WKND_TARGET_*` input is optional;
  - each flag must be `true`, `false` or empty;
  - any enabled flag requires the selected environment's exact configured namespace;
  - linkage enabled requires nonempty sanctioned wording versions;
  - Production live decide inputs must pass the runtime decide gates, including verified Target config.
  - This preflight is not platform verification. Runtime checks `process.env.__OW_NAMESPACE`
    independently; body, query, caller namespace parameters and inferred suffixes are not authority.
- **Package inputs.** Like every action in the `commerce` package, this one inherits the package-level
  inputs (`HLX_*`, `AEM_*` and so on). It never reads them: `CONFIG_KEYS` is an explicit allowlist.
- **Responses and logs** carry fixed categories only: op, HTTP status, status, reason,
  `bindingReason`, gate name, and the error name/code for unexpected failures. They never carry
  tokens, `sub`, shopper keys, ECIDs or blobs. There is no silent success fallback: an unexpected
  error is a 500 `internal`.
- **Isolation.** Promotions, cart, orders, `shopper-audiences` and the GraphQL schema are untouched,
  and no Mesh change is needed.

### Server and public frontend configuration contract

New final manifest inputs (all `$WKND_*` references resolve empty when absent):

| Input | Meaning |
|---|---|
| `WKND_TARGET_DIAG_STAGE_NAMESPACE` | Exact Stage namespace verified from the Adobe workspace/platform |
| `WKND_TARGET_DIAG_PRODUCTION_NAMESPACE` | Exact Production namespace verified separately; must differ from Stage |
| `WKND_TARGET_DIAG_TARGET_CONFIG_APPROVED` | Empty/false by default; Production decide requires `true` after actual Target configuration verification |

`WKND_TARGET_DIAG_ENVIRONMENT` selects the server-owned map entry, never an inferred namespace suffix.
Both map entries may be configured; only the selected entry is required, and overlapping entries are
refused. Before enabling either environment, the operator must verify both workspace identities and
that each workspace's injected IMS credentials resolve to its **own** Database Storage instance.
Do not point either workspace at the other's store or copy consent/customer/binding records.
The collection names stay unchanged: their isolation boundary is the platform workspace and its
injected DB credentials. Namespace-label configuration alone cannot prove backend isolation.
Existing Stage behavior is unchanged **after adding its exact namespace input**; suffix-only Stage
configurations deliberately fail closed until migrated.

Frontend needs only an owner-configured endpoint URL, expected environment (`stage`/`production`),
UI enabled flag (default false), sanctioned wording text/version and normal Auth0 audience/issuer.
These are frontend settings, not new backend inputs. Never expose shopper allowlists, property tokens,
org/DPID, credentials or namespace mappings as UI authority. No frontend files are changed here.
Use POST + JSON + the signed-in shopper's Auth0 access token; no delegation header. Send only:
`{op:'consent-status'}`, `{op:'consent',optIn:true,wordingVersion,source:'account-settings'}`,
`{op:'consent',optIn:false,source:'account-settings'}` or `{op:'decide'}`.
Never send environment/namespace/identity overrides. Reject results whose environment differs from
the UI's expected environment; do not relabel them. Obtain a new token/status after account switch,
clear displayed diagnostics on withdrawal/logout, and never use a marker to authorize money.
Opt-in is separate and unchecked by default; display sanctioned wording, not bundled email consent.

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
  - It conditionally withdraws the current pending or granted generation first, then retires known
    ECIDs matching both `sha256(sub)` and that generation, then appends evidence. Only anonymous
    mint claims without a known ECID are removed. Retirement retains identifiers as non-authorizing
    `retiring` records with `retirement.state='pending'`; it is not an upstream opt-out acknowledgment.
    Delayed cleanup cannot overwrite a newer generation. Evidence failure is explicit and sanitized;
    withdrawal stays effective.
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
| During anonymous MID acquisition | Withdrawal removes the anonymous claim; persistence loses CAS ownership, so no declared ID can be sent | provider: anonymous mint withdrawal |
| During declared-ID transmission | The MID is already durable; withdrawal changes the claim into pending retirement. The late final write fails CAS, retaining the cleanup identifier | id-linkage: in-flight withdrawal |
| During the pre-link consent lookup | Re-read the stored claim after the lookup. Retirement, a different etag, or insufficient lease time prevents any CID request | provider: paused beforeLink / lease budget / replaced claim |
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
- `confirm()` re-checks the same grant and the still-bound stored ECID; pending retirement or store
  failure suppresses a previously issued binding even if consent remains granted.

- **Two-phase requests:** first acquire an anonymous MID with
  `GET https://dpm.demdex.net/id?d_orgid=…&d_ver=2` (no declared ID). Persist that MID as `priorEcid`
  under the issuing lease, with the org, DPID, subject hash and consent generation. Recheck consent,
  then link only the durable MID with
  `GET https://dpm.demdex.net/id?d_orgid=…&d_ver=2&d_mid=<stored ECID>&d_cid=<DPID>%01<verified sub>%011`.
  These two use cases are [documented by Adobe](https://experienceleague.adobe.com/en/docs/id-service/using/implementation/direct-integration-examples).
  A failed MID persistence never sends a declared ID. A lost anonymous response may leave an unknown
  anonymous MID upstream, but this implementation has not linked it to a declared ID.
  Stored MIDs acquired anonymously carry `ecidSource:'server-issued'`; `regionHints.anonymousMint`
  and `regionHints.lastBound` retain the available issuer/last-bound region hints through retirement.
  Old records without verified issuance provenance are not submitted by the retirement operation.
  Immediately before linking, re-read CAS ownership after the consent lookup: the same etag must
  still identify this shopper/grant/org/DPID/MID in `issuing`, `phase:'linking'`, with **more than one
  full configured request timeout remaining**. A retired/replaced claim sends no CID; insufficient
  lease returns `lease-insufficient` and retains pending retirement. No expired lease is renewed to
  force a send. This check does not make an external request atomic with subsequent withdrawal.
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
| `{ state:'withdrawn' }` | Local linkage withdrawal, not proof of Adobe opt-out. | Retire known IDs; remove anonymous claims; issue nothing. |
| `{ state:'absent' }` | No consent record, e.g. never asked or erased. | Retire known IDs if present; write nothing with no record. |
| A throw, or anything else (bare `true`, a missing or malformed `grantId`, unknown states) | Unknown. | Initial lookup: deny unchanged. If a later check fails after MID acquisition, retain that MID pending retirement rather than transmit a declared ID. |

An initial unknown lookup never removes or issues: an outage is not a withdrawal. A later lookup
failure cannot discard an already-retained MID or authorize linking; it fails closed.

Only the separate ID-linkage purpose backs this interface. `marketing.recoveryEmail` and
`marketing.audienceEmail` are email purposes, and consent is never bundled or inferred
(docs/PROMOTIONS.md).

### Lifecycle paths (each is pinned by a test in `test/target-id-binding.test.js`)

| Path | Behaviour |
|---|---|
| Cold start (no record) | Claim, re-check consent, acquire anonymously, persist the MID by CAS, re-check consent, then link the known MID. No declared-ID request precedes durable MID retention. |
| Reuse before `resyncAt` | No ID Service call. Consent is still looked up on every resolve. |
| Resync / concurrent refresh | One lease holder sends the stored ECID as `d_mid`. Concurrent callers get unavailable. A failed or ambiguous linking response retains the known MID as pending retirement rather than retrying linkage. |
| ID Service failure | Anonymous failure leaves a reclaimable anonymous lease. Linking timeout, lost/invalid response or HTTP failure retains pending retirement. If a store outage prevents retirement, the already-durable known-MID claim remains; its expired lease cannot mint another MID. |
| Consent missing / withdrawn | Known IDs are retained for retirement; anonymous claims are removed by CAS; nothing is issued. |
| Consent failure / malformed | Deny, no mutation. |
| Unknown stored state | `invalid-record-state`, no overwrite, removal or network request; existing known IDs remain intact. |
| Withdrawal while issuance is in flight | Removing an anonymous claim prevents later linking. Retiring a known-MID claim preserves its ID and changes the etag; a late response cannot restore a usable binding. |
| Reconsent (new `grantId`) | Consent may be granted again, but a known ID from the old generation becomes/stays pending retirement. `resolve` returns `retirement-pending`, never overwrites that work or mints another linked MID. No automatic retirement release is implemented. |
| Account switch | Bindings are keyed by `shopperKey(AUTH0_ISSUER, sub)`. Anonymous acquisition omits `d_mid`; linking uses only that shopper's persisted MID. Another shopper's binding, or a record carrying a different org/DPID, fails closed. |
| Logout | No provider action, by design. See the proof below. |
| Withdrawal push | `invalidate(shopperKey)` conditionally retires known IDs or removes anonymous claims after flipping consent. It does not perform erasure. |

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
- The fixed collection is `target_id_bindings_v2`. Old independently bundled v11/v12 callers touch
  only `target_id_bindings`, which remains untouched; no migration or runtime-selectable generation.
  Structural non-erasure replaces unavailable activation-drain proof, not consent verification.
- Records have three persisted states: `issuing` (a lease with `leaseUntil` and `priorEcid`), `bound`,
  and `retiring` (known ECID and `retirement.state='pending'`). Anonymous claims may be removed.
  - Issuing records explicitly distinguish `phase:'minting'` from `phase:'linking'`. Legacy ambiguous
    issuing records or bound records without a valid MID are quarantined as pending retirement;
    no missing MID is invented and no ambiguous old claim is reminted.
  - A live lease is never pre-empted.
  - Only an anonymous lapsed lease may be taken over. A lapsed lease carrying `priorEcid` is retired.
  - A holder that has been taken over cannot overwrite the newer binding.
- **Cold start:** the provider keeps no in-memory state, so a new action instance behaves exactly like
  a warm one. An empty or lost store is indistinguishable from a first issuance and mints a new ECID.
  Data loss therefore causes churn but is never reused across shoppers.

### Code done vs. live acceptance gates

**Implemented and tested offline (this PR):**

- the consent purpose;
- the authoritative consent source;
- the CAS binding-store adapter;
- withdrawal call sites (shopper withdrawal and Brevo unsubscribe), with durable known-ID retirement;
- the environment-bound action and final manifest entry;
- the deploy gate;
- strict wire parsing;
- categorized errors;
- the consent re-checks before sending and before exposing a result.

**Live acceptance gates.** These need approval, evidence or the remaining upstream lifecycle capability;
each blocks enabling a flag. An explicit authenticated retirement submission/observation operation
exists, but no automatic scanner, full regional verification or retirement-release worker exists.
Do not enable ID Service on the strength of this offline slice alone. See
[the upstream lifecycle runbook](TARGET-UPSTREAM-DELETION.md).

### Owned retirement operation (`lib/target-id-retirement.js`, OFF by default)

Final manifest input `TARGET_ID_RETIREMENT_ENABLED` references
`WKND_TARGET_ID_RETIREMENT_ENABLED`; missing/empty is OFF. It also requires binding-store approval,
the verified partner org, configured DPID and bounded ID timeout/lease. It does **not** require ID
issuance or Target to be ON. Existing authentication, exact namespace, allowlist, delegation refusal,
strict-body and identifier-free response gates apply. The caller supplies only `step`, never IDs.

Only that verified shopper's persisted `retiring` record, with server-issued provenance, subject hash,
matching org/DPID and a retained valid MID, is eligible. Absent-purpose status, withdrawal and retirement
remain read-only. No account/customer mutation or consent change is made by retirement.

- A legacy handler may withdraw the customer purpose while touching only the old collection.
  Under withdrawn consent, an owned server-issued v2 bound/linking record is reconciled to pending
  retirement by etag after a second consent check. This invocation returns `reconciled-pending`
  with **no remote request**, no new grant and no ID loss. Unknown/absent consent is read-only before
  binding access; reconsent or a newer binding prevents stale reconciliation. Reconsent never
  permits reuse of a retained old-grant MID.
- `submit`: persist a scoped CAS sending claim before a cookieless, redirect-refusing device-MID
  request to `ags050.demdex.net/demoptout.jpg`. HTTP success records `submitted`, not proven opt-out.
- `observe`: after a submitted **or unknown** scoped submission, request only `d_mid`, `d_orgid`,
  `d_rtbd=json` from the same partner's `/event`. Strict numeric code 171 from documented JSON
  `errors` or `X-Error` records `opt-out-observed`. An available response `dcs_region` scopes the
  observation region; an absent region is explicitly non-regional. Conflicting/invalid responses
  remain unknown. This sends no declared ID, traits, cookies or `d_cts`.
- Sending claims survive crashes. An expired claim becomes an unknown outcome; submission is not
  automatically repeated. A later explicit observation can inspect an unknown scoped submission.
  CAS failures never claim a durably saved successful result or discard IDs.
- Every response retains `coverage:'incomplete'`, `historicalDeletion:false`,
  `unsegmentationVerified:false`, `evidence:false` and `financialAuthorization:false`. No response,
  including code 171, clears retirement or permits binding reuse. Region hints are not exhaustive
  coverage; no speculative region routing or regulatory deletion is implemented.

1. **Operational wording.** The operational owner sanctions the ID-linkage wording and adds its
   nonempty version to `WKND_TARGET_ID_LINKAGE_WORDING_VERSIONS`. Legal review is not a project gate.
   The separately owned storefront UI calls `op:'consent'` with the shopper's Auth0 token.
2. **Backend CAS.** Approve the fixed `target_id_bindings_v2` collection, then verify on each selected workspace's App Builder
   Database Storage that:
   - a duplicate `_id` insert fails;
   - `updateOne({_id, etag})` reports `matchedCount` 0 or 1;
   - `deleteOne` / `deleteMany` behave as expected;
   - a missing collection is a not-found error.

   Then set that workspace's `WKND_TARGET_ID_BINDING_STORE_APPROVED`. Use the disposable probe below;
   a memory result is not Database Storage acceptance evidence.
3. **Adobe ID Service call** (`WKND_TARGET_ID_SERVICE_ENABLED`):
   - `d_cid` with authenticated state 1 **transmits the authenticated DPUID to DCS**. Its side effects
     (DCS event, device-to-profile linking) must be accepted.
   - The effect of the server IP on `dcs_region` is unknown.
   - `d_blob` freshness between resyncs is unknown (the blob is not membership).
4. **Merge rule.** The pilot rule 1547344 is Current Authenticated + No Device, which is evaluated **in
   real time only**. There is no assurance that a server-minted ECID is ever evaluated under it. This
   must be proven by a live experiment, not inferred from daily reports or API permissions.
5. **Upstream deletion.** Removing a binding locally does not delete the link Audience Manager already
   holds. Establish an operator-owned supported workflow using [the runbook](TARGET-UPSTREAM-DELETION.md);
   no automatic account erasure implementation is claimed.
6. **Live qualification acceptance.** Stage activity 689010 remains Stage-only. Create and verify a
   separate Production diagnostic activity/property/client before approving its Target config gate.
   A decision is never evidence, and report absence is never negative.
7. **Tuning.** The lease (default 10s) and timeouts (default 2s) are bounded configuration, not SLAs;
   measure them on Stage.

There is no account erasure flow in the repository, and this PR does not invent one.

### Disposable CAS verification runner (offline preparation)

The runner uses `createBindingStore` unchanged: unique `_id` insertion, conditional `updateOne` /
`matchedCount`, conditional `deleteOne` / `deletedCount`, stale writes/deletes, concurrent writers
and delete/reinsert ABA. Cleanup is conditional and limited to a fresh disposable key; no customer,
cart or order is accessed. It does not exercise `deleteMany` or missing-collection behavior: those
still need separate platform acceptance evidence.

```sh
# Dry run: no store opened or writes (explicit fake namespaces, no secrets).
node scripts/verify-target-binding-cas.mjs --environment=stage --namespace=mock-stage --stage-namespace=mock-stage --prefix=cas-probe-offline:
# Memory-only verification, not a live CAS test.
node scripts/verify-target-binding-cas.mjs --environment=production --namespace=mock-production --production-namespace=mock-production --prefix=cas-probe-offline: --memory
```

There is deliberately no live CLI mode, no .env loading or SDK initialization. `verifyTargetBindingCas`
is an injectable runner for future operator-controlled execution: default `execute=false`; execution
requires `execute:true`, a verified `platformNamespace` matching the selected map entry, a disposable
`cas-probe-<name>:` prefix, and an explicitly injected `getStore`. Operators must independently obtain
the correct platform namespace/credentials, authorize the disposable collection/key writes, review
the integration and record backend results before enabling the store gate. Do not pass customer
keys or infer workspace identity. On cleanup failure, stop and record the thrown error's `probeKey` securely;
do not delete a collection or retry with an unconditional customer deletion.

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
- Verify the exact namespace map and separate Database Storage credentials for the selected environment.
- Verify the gates above before enabling any flags. Stage and Production scope approval is covered;
  this implementation task does not deploy or activate either.
- No live customer/cart/order writes, emails or financial coupling were performed by this task.
