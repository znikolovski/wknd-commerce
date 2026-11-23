# Target / AAM upstream deletion — operator runbook

Preparation only. No deletion or opt-out was submitted. Local withdrawal stops future linkage,
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
4. No automatic opt-out submission, verification or release worker is implemented in this change.
   A future authorized device-only submission must validate the exact partner/org and retained MID,
   preserve pending work on timeout/error, and at most record successful HTTP submission as
   **submitted/pending**. HTTP acceptance is not proven upstream opt-out or unsegmentation.
5. DCS code 171 in documented JSON `errors` or `X-Error` is an observation of opt-out, not proof of
   downstream unsegmentation, historical deletion, or cross-region completion. Do not invent regional
   routing or a verification entitlement. The approved observation, retry, regional coverage and
   safe release contract remains an activation gate; ID Service stays OFF.

The raw binding-store `remove` primitive remains available for disposable CAS probes. It is **not**
the withdrawal lifecycle: operational cleanup must not bypass retained retirement work.

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
- [Audience Manager identifiers](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/overview/data-privacy/data-privacy-reference/data-privacy-ids)
  — ECID, custom data-source namespace and integration-code formats.
- [Target privacy and data protection](https://experienceleague.adobe.com/en/docs/target-dev/developer/implementation/privacy/cmp-privacy-and-general-data-protection-regulation)
  — Target access/delete through Privacy Service; collection opt-in is a separate control.
- [Privacy Service jobs](https://experienceleague.adobe.com/en/docs/experience-platform/privacy/api/privacy-jobs)
  — job submission/status workflow and current regulation-value guidance.
