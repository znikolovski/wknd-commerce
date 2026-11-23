# Target / AAM upstream deletion — operator runbook

Preparation only. No deletion was submitted or implemented. Local withdrawal stops future linkage,
invalidates the grant generation and removes local bindings; it cannot recall an already sent
request or erase Adobe-held profiles. Consent withdrawal is not automatically an account-erasure
request. Legal review is not a project prerequisite; the operational privacy owner determines the
request's authority, applicable workflow and regulation values.

1. **Contain and scope.** Authenticate the requester through the established privacy process.
   Stop linkage for the subject and prevent regrant while an authorized deletion is being handled.
   Existing withdrawal does not implement a durable deletion hold; the operator must arrange one.
   Record Stage/Production scope, the real Adobe organization, data source/integration code and
   affected Target configuration. Privacy Service organization/product scope is **not** scoped by
   this action's Runtime namespace. Do not assume it deletes only a diagnostic activity.
2. **Collect identifiers securely before discarding them.** Inventory the authorized subject's
   actual ECIDs and the exact declared customer ID sent to Adobe (verified Auth0 `sub`, not
   `sha256(sub)` or `shopperKey`). AAM supports ECID with namespace `ECID` / type `standard` and
   customer IDs under the instance's verified data-source namespace / type `namespaceId`, or its
   verified integration code. Check Target-supported identifiers against current documentation and
   actual integration. Do not guess namespace IDs or manufacture missing ECIDs. If local bindings
   have already been deleted, escalate identification to the privacy owner; do not remint identities.
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
  — access/delete via Privacy Service UI/API.
- [Audience Manager identifiers](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/overview/data-privacy/data-privacy-reference/data-privacy-ids)
  — ECID, custom data-source namespace and integration-code formats.
- [Target privacy and data protection](https://experienceleague.adobe.com/en/docs/target-dev/developer/implementation/privacy/cmp-privacy-and-general-data-protection-regulation)
  — Target access/delete through Privacy Service; collection opt-in is a separate control.
- [Privacy Service jobs](https://experienceleague.adobe.com/en/docs/experience-platform/privacy/api/privacy-jobs)
  — job submission/status workflow and current regulation-value guidance.
