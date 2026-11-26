# Target / AAM upstream deletion — operator runbook

Offline implementation only. No live deletion, opt-out or observation was submitted. Local withdrawal stops future linkage,
invalidates the grant generation and retains known ECIDs as pending retirement; it cannot recall an already sent
request or erase Adobe-held profiles. Consent withdrawal is not automatically an account-erasure
request. Legal review is not a project prerequisite; the operational privacy owner determines the
request's authority, applicable workflow and regulation values.

## Optional linkage withdrawal: scoped opt-out, not deletion

The selected company's partner host was verified by the operator from Audience Manager's selected
company metadata and independently from primary container 9133:
`ags050.demdex.net`, partner 8455, organization `28260E2056581D3B7F000101@AdobeOrg`.
This is **not** inferred from the Target client code. Runtime namespace separation does not itself
give Adobe partner/organization isolation; Stage and Production can share this upstream partner scope.

Adobe documents a device-scoped partner opt-out:
`https://ags050.demdex.net/demoptout.jpg?d_mid=<actual-retired-ECID>&d_orgid=<verified-org>`.
It stops future collection/segmentation/activation for the partner/device and requests unsegmentation,
but **does not delete historical data or ID mappings**. Do not substitute declared-ID deletion
(which affects linked devices), global opt-out or a fabricated GDPR/CCPA request for this purpose.

Local lifecycle containment now works as follows:

1. Anonymous MID acquisition sends no `d_cid`. Persist the validated MID under the CAS claim **before**
   any declared-ID request. Failed persistence or withdrawal during anonymous acquisition sends no
   declared ID; an unobserved anonymous MID is not a declared-ID orphan.
2. A known-MID issuing claim durably retains org, DPID, subject hash and grant generation. Withdrawal
   changes it to non-authorizing `retiring`, preserves the MID, and drops the obsolete blob. Linking
   timeout/lost response also retains pending retirement; an expired known-MID lease cannot remint.
   Only an explicitly anonymous `phase:'minting'` claim with `priorEcid:null` can be removed. Legacy
   ambiguous claims or malformed bound records stay quarantined pending operator investigation;
   an unknown ECID cannot be fabricated or submitted for a device opt-out.
3. Reconsent never discards old pending work or reuses its ID. The provider returns
   `retirement-pending` until a supported retirement/release workflow exists. Local consent status
   may be granted while linking is still unavailable. Do not delete the pending record to unblock it.
   This is distinct from the approved Production identity transition described in
   [the diagnostic contract](TARGET-AAM-DIAGNOSTIC.md): a same-grant legacy
   `identity-mapping-changed` record with verified server provenance and no
   submission/observation remains untouched while a separate canonical-alias
   binding is issued. That transition does not release retirement, reuse the old
   MID or apply to consent withdrawal, uncertain issuance or another grant.
4. The OFF-by-default authenticated operation `{op:'retirement',step:'submit'|'observe'}` uses only
   the verified shopper's persisted server-issued retiring MID. A scoped CAS sending claim is saved
   before any request; timeout/crash/unknown response retains identifiers and an unknown outcome.
   Submission records HTTP transport success as **submitted/pending**, never proven opt-out.
   Observation uses only the same partner `/event?d_mid=…&d_orgid=…&d_rtbd=json`; it sends no declared
   ID, cookies, traits, redirects or identity-bearing results. Unknown scoped submission can be
   observed without automatically resubmitting.
5. DCS code 171 in documented JSON `errors` or `X-Error` is an observation of opt-out, not proof of
   downstream unsegmentation, historical deletion, or cross-region completion. Do not invent regional
   routing or a verification entitlement. The approved observation, retry, regional coverage and
   safe release contract remains an activation gate; ID Service stays OFF. `coverage:'incomplete'`
   is retained even when all available hints appear observed. No automatic regional routing,
   full-verification, retirement release or historical-link deletion is implemented.

Configuration is final server input `TARGET_ID_RETIREMENT_ENABLED` from
`WKND_TARGET_ID_RETIREMENT_ENABLED` (empty/OFF by default), with binding-store approval, exact
verified org, DPID, environment/namespace and bounded timeout/lease. It is independent of ID issuance
and Target activation. Keep it OFF until the three-action generation-isolated release and live storage
acceptance are verified. Anonymous-mint and last-bound region hints and server-issued provenance are
persisted before/after linking and preserved through retirement; legacy unproven IDs are refused.

The raw binding-store `remove` primitive remains available for disposable CAS probes. It is **not**
the withdrawal lifecycle: operational cleanup must not bypass retained retirement work.

## Generation-isolated selective Stage release

Runtime actions bundle their dependencies independently. Updating only the diagnostic does **not**
replace the old deletion helper embedded in other live actions.

`BINDING_COLLECTION` is the fixed `target_id_bindings_v2` in `lib/target-binding-store.js`.
Legacy deletion helpers and v12 retention bundles address only `target_id_bindings`; their
queued/in-flight activations cannot erase v2 IDs. No configurable generation, migration or deletion
of the old collection is introduced. This is structural non-erasure, **not queue-drain evidence**.
The same fixed default is used by `createBindingStore`, `removeBindingsForSubject`, both diagnostic
provider/retirement call sites and `verifyTargetBindingCas`.

An old handler may still withdraw authoritative customer consent. A v2 binding then cannot pass
`confirm` or authorize reuse. The explicitly gated retirement operation can reconcile that owned,
server-issued bound/linking MID under twice-verified withdrawn consent, using the observed binding
etag. It preserves the MID, provenance and region hints as pending retirement; that invocation
makes **no upstream request** and never grants consent. Unknown/absent purpose does not read the
binding store. Reconsent before confirmation aborts; a newer binding defeats the stale CAS.

| Required Stage action | Reachable linkage-withdrawal path |
|---|---|
| `commerce/target-diagnostic` | `lib/target-diagnostic-action.js` → `setIdLinkageConsent` → `removeBindingsForSubject` |
| `commerce/brevo-webhook` | `actions/brevo-webhook/index.js` → `handleBrevoWebhook` → `recordSuppression('unsubscribed')` → `withdrawIdLinkageForEmail` → `removeBindingsForSubject` |
| `commerce/promotions-worker` | `actions/promotions-worker/index.js` → `executeNextApprovedRun` → `executeRun` → `syncSuppressions` → `recordSuppression('unsubscribed')` → `withdrawIdLinkageForEmail` → `removeBindingsForSubject` |

`commerce-admin/promotions` imports the recovery-email module but exposes status, approval and pause
operations, **not** execution/suppression sync. `commerce/storefront-graphql` reaches email-purpose
setters through resolvers, which do not withdraw linkage. Module inclusion alone is not a reachable
withdrawal route; these actions are not part of this selective lifecycle release.

Future authorized release order:

1. Keep ID Service, binding-store approval, remote Target and financial gates OFF. Build the three
   required action bundles from the same reviewed revision. Do not modify shared CLI settings,
   credentials, packages, triggers or unrelated actions.
2. Selectively replace **only** `commerce/brevo-webhook` and `commerce/promotions-worker` first,
   preserving their existing parameters, authentication, annotations, limits and schedule.
   Verify the new exec fingerprints and the retention-aware helper in each built artifact.
3. Verify both built callers use `target_id_bindings_v2`, while legacy binding helpers use only
   `target_id_bindings`. The saved v11 artifacts contain no binding-store module/reference; the
   actual published v12 artifacts embed the old literal, not v2. Retain the old collection untouched and establish aggregate-only zero
   old known-ID/bound/retiring counts. Require fresh real disposable CAS acceptance and verified
   cleanup on v2 in the exact Stage workspace. This structural barrier replaces unavailable
   queue-drain proof; neither elapsed time nor empty activation history establishes drainage.
4. Then selectively replace `commerce/target-diagnostic`, still with ID Service OFF. Verify those
   three intended action changes, unchanged package inputs/bindings/annotations, and unchanged
   fingerprints for every unrelated action. Consent-status/grant/withdrawal acceptance is distinct
   from ID lifecycle activation.
5. Enable the retirement operation only after compatible isolated artifacts and live CAS acceptance.
   This source implementation was tested only with mocks; actual submission/observation semantics
   and region/destination coverage still require sanctioned live verification. Only after the
   remaining approved device opt-out observation/coverage/release contract and live
   storage acceptance are satisfied may ID Service activation be considered. Never activate against
   old deletion callers. Once retained IDs exist, do not roll any of these three actions back to an
   old `deleteMany` helper; disable upstream work while preserving retention-aware withdrawal code.

On 2026-11-23 the publisher-process Stage CAS probe passed duplicate insert, concurrent conditional
writers, stale update/delete and ABA checks against `target_id_bindings_v2`, with disposable-key
cleanup verified. Aggregate document counts in both old and v2 collections were zero before/after;
no old collection/customer/consent/identity write was made. This is DB CAS acceptance, not Runtime
region, upstream opt-out, qualification or withdrawal completion. All 24 live action fingerprints
remained unchanged during that probe: webhook/worker `0.0.12`, diagnostic `0.0.2`. This correction
was **not deployed**; its exact three-action re-release still requires review and authorization.

## Separately authorized deletion requests

1. **Contain and scope.** Authenticate the requester through the established privacy process.
   Stop linkage for the subject and prevent regrant while an authorized deletion is being handled.
   Existing withdrawal does not implement a durable deletion hold; the operator must arrange one.
   Record Stage/Production scope, the real Adobe organization, data source/integration code and
   affected Target configuration. Privacy Service organization/product scope is **not** scoped by
   this action's Runtime namespace. Do not assume it deletes only a diagnostic activity.
2. **Collect identifiers securely; do not discard pending retirement work.** Inventory the authorized subject's
   actual ECIDs and the exact declared customer ID sent to Adobe (verified Auth0 `sub`, not
   `sha256(sub)` or `shopperKey`). AAM supports ECID with namespace `ECID` / type `standard` and
   customer IDs under the instance's verified data-source namespace / type `namespaceId`, or its
   verified integration code. Check Target-supported identifiers against current documentation and
   actual integration. Do not guess namespace IDs or manufacture missing ECIDs. If local bindings
   have already been deleted or an old implementation lost an issuing response, escalate identification
   to the privacy owner; do not remint identities.
3. **Submit using the supported Privacy Service UI/API.** An authorized operator uses its documented
   delete-job workflow for the correct organization/products (Target and Audience Manager as
   appropriate), supported identity namespaces and applicable regulation. Review the product scope
   before submission. Never paste identifiers or tokens in Git, chat, logs or this runbook.
   This repository contains no submission command or automatic erasure endpoint.
4. **Track completion, not HTTP acceptance.** Retain the job/request ID securely and monitor each
   product's status using the documented job-status workflow. Investigate partial/error results;
   do not claim deletion from a 2xx response, local deletion, lack of qualification or absent reports.
   Coordinate any downstream destinations or other products separately. Reintroduction from
   continued browser/app ingestion must be prevented through the consent/collection controls.
5. **Close with evidence.** The operator records completion, unresolved product/identifier coverage
   and retention handling under the organization's existing process. No automatic account erasure,
   destination deletion or legal compliance guarantee is asserted here.

## Official references (retrieved and verified 2026-11-23)

- [Audience Manager data privacy requests](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/overview/data-privacy/data-privacy-requests)
  — device/declared-ID partner opt-out versus separately authorized access/delete.
- [Direct integration use cases](https://experienceleague.adobe.com/en/docs/id-service/using/implementation/direct-integration-examples)
  — anonymous MID acquisition and subsequent linking of a known MID.
- [DCS error codes](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/api-and-sdk-code/dcs/dcs-api-reference/dcs-error-codes)
  — opt-out observation code 171 and JSON / X-Error formats.
- [Supported DCS attributes](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/api-and-sdk-code/dcs/dcs-api-reference/dcs-keys)
  — `d_mid` and `d_rtbd=json`; no traits/segments entitlement is requested.
- [Audience Manager identifiers](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/overview/data-privacy/data-privacy-reference/data-privacy-ids)
  — ECID, custom data-source namespace and integration-code formats.
- [Target privacy and data protection](https://experienceleague.adobe.com/en/docs/target-dev/developer/implementation/privacy/cmp-privacy-and-general-data-protection-regulation)
  — Target access/delete through Privacy Service; collection opt-in is a separate control.
- [Privacy Service jobs](https://experienceleague.adobe.com/en/docs/experience-platform/privacy/api/privacy-jobs)
  — job submission/status workflow and current regulation-value guidance.
