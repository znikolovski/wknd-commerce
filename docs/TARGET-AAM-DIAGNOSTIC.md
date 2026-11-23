# Target AAM diagnostic (Stage only) — offline preparation

Status: **offline preparation only**. `lib/target-diagnostic.js` and its tests exist; there is no action,
manifest entry, configuration or deployment. Nothing calls Target, Audience Manager or Edge from this
code until the coordinator confirms the activity, client code, property token and manifest, and a Stage
deploy is approved. Production is refused by configuration (environment and namespace).

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

## Trusted ECID binding: feasibility (not verified, not implemented)

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

## Binding provider lifecycle (offline): `lib/target-id-binding.js`

`createIdServiceBindingProvider({ orgId, dpid, consent, store })` implements candidate A as an offline
design. Nothing wires it: there is no store collection, consent source, configuration, manifest entry or
call site, and the diagnostic's default provider is still `unavailableBindingProvider`.

- **Request:** `GET https://dpm.demdex.net/id?d_orgid=…&d_ver=2[&d_mid=<stored ECID>]&d_cid=<DPID>%01<verified sub>%011`.
  - No traits, `d_cb`, headers, cookies, browser identifiers or caller input.
  - `redirect:'error'`, `credentials:'omit'`, with a timeout.
- **Response:** `d_mid` must be 38 digits, `dcs_region` an integer ≥ 1, and `d_blob` non-empty and at
  most **512 bytes**. 512 is the ID Service's own documented limit; the Target adapter keeps the
  Delivery API's 1024-byte limit.
- **`id_sync_ttl`** is the documented re-synchronization interval, **not** membership expiry. It sets
  only `resyncAt`. A missing or implausible value (over 30 days) means "do not reuse".
- **Unconfigured unless all are present:** a valid org, a DPID, `consent.lookup`, a CAS store
  (`get`/`put`/`remove`), and a lease of at least two ID Service timeouts. The legacy boolean
  `consent.allowed()` is not accepted.

### Consent provider interface (authoritative source not chosen)

`consent.lookup({ shopperKey, sub })` must return one of:

| Answer | Meaning | Provider action |
|---|---|---|
| `{ state:'granted', grantId }` | Current opt-in. `grantId` (1–128 chars `[A-Za-z0-9._:-]`) identifies that specific grant, e.g. the opt-in event ID. | Issue or reuse, only within the same `grantId`. |
| `{ state:'withdrawn' }` | Explicit opt-out. | Remove the binding; issue nothing. |
| `{ state:'absent' }` | No consent record, e.g. never asked or erased. | Remove the binding if one exists; write nothing otherwise. |
| A throw, or anything else (bare `true`, a missing or malformed `grantId`, unknown states) | Unknown. | Deny, and change **nothing**: no store write, removal or ID Service call. |

Unknown never removes, because an outage is not a withdrawal and removal would cause ECID churn.
Unknown never issues either, so a withdrawal during an outage is still honoured.

None of the existing consent purposes may back this interface. `marketing.recoveryEmail` and
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

### Store CAS contract and cold start (no collection approved)

- `get(key)` returns `{ etag, record }` or `null`.
- `put(key, record, { ifMatch })` returns the new etag, or `null` if the precondition fails.
  `ifMatch: null` means create-if-absent.
- `remove(key, { ifMatch? })` removes conditionally; without `ifMatch` it is unconditional.
- **Etags are opaque and never reused for a key, even after a removal.** Random UUIDs qualify; a
  counter that restarts after a delete does not, because a stale holder's write could then match.
- Possible mapping to the existing store pattern (`lib/cart.js` CAS):
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

### Implementation gaps (all block any live call)

1. **Consent source.** There is no ID-linkage consent purpose. It needs:
   - purpose, wording and source;
   - a stable `grantId` (for example the opt-in `marketing_consent_events.id`). The profile write and
     the event append are currently not atomic, and the profile does not store the event ID;
   - an explicit decision on whether a Brevo unsubscribe (`recordSuppression`, which withdraws **every**
     `CONSENT_PURPOSES` entry) withdraws ID linkage;
   - confirmation that delegated agents cannot grant it.
2. **Withdrawal / erasure push.** `setMarketingConsent(false)`, the Brevo unsubscribe and any account
   erasure must call `invalidate()` after flipping consent. There are no call sites, and the repository
   has no erasure flow.
3. **Adobe-side linkage.** Local invalidation stops future use, but does **not** remove the
   ECID↔declared-ID link already held by Audience Manager. That needs a Privacy Service or AAM
   deletion path, which is not designed.
4. **Store.** A diagnostic-only collection and the mapping above need approval, plus a check of CAS
   semantics on the real `lib/store.js` backend.
5. **Adobe behaviour (from the open points above):**
   - side effects of the `d_cid` call (DCS event, profile linking);
   - the merge rule for a server-minted ECID;
   - the effect of the server IP on `dcs_region`;
   - `d_blob` freshness between resyncs (the blob is not membership).
6. **Tuning.** The lease (10s) and timeout (2s) defaults are unmeasured.

None of these are implemented here. The provider remains unconfigured by default.

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
- Binding candidate A is verified, and the implementation gaps above are closed and approved (consent purpose, withdrawal push, Adobe-side deletion, store).
- Manifest entry: a Stage-only raw web action that verifies the Auth0 token with `lib/auth.js` and
  passes only claims. The deploy check must refuse a Production namespace when the diagnostic is
  enabled. This needs explicit approval.
- No Production deployment, customer/cart/order writes, emails or financial coupling.
