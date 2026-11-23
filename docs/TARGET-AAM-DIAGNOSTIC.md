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

## Activation prerequisites

- The coordinator confirms that the activity exists and is saved and live in Stage only, plus the
  client code, property token, mbox and offer shapes. No offer is persisted today, and no activity is
  activated.
- Binding candidate A is verified, or another supported path is chosen, and its provider is approved,
  including any persistence.
- Manifest entry: a Stage-only raw web action that verifies the Auth0 token with `lib/auth.js` and
  passes only claims. The deploy check must refuse a Production namespace when the diagnostic is
  enabled. This needs explicit approval.
- No Production deployment, customer/cart/order writes, emails or financial coupling.
