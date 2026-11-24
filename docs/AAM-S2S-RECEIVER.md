# AAM S2S receiver and shared membership

This is a separate inbound destination, not the Target diagnostic or a marketer playbook.
All new capabilities default OFF. No campaign, email, contact creation, consent grant, Target
qualification or financial promotion is performed by this integration.

## Source endpoints

- Production POST: `https://28538-wkndcommerce.adobeioruntime.net/api/v1/web/aam/receiver`
- Stage POST: `https://28538-wkndcommerce-stage.adobeioruntime.net/api/v1/web/aam/receiver`
- Private processor: `aam/worker` (`web: no`), separately authenticated by Runtime.

The manifest defines final raw web intake with IMS credentials for Database Storage, not an IMS
requirement on Adobe's incoming request. POST only; no query parameters, GET, parsed-object
fallback, custom OAuth scheme or unsigned intake. `__ow_body` must be canonical base64 of the
unaltered request bytes. JSON media type and strict UTF-8 are required.

## Adobe wire protocol

Implementation references:

- [Real-time outbound transfers](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/implementation-integration-guides/receiving-audience-data/real-time-outbound-transfers/real-time-outbound-transfers)
- [Digitally signed HTTP requests](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/implementation-integration-guides/receiving-audience-data/real-time-outbound-transfers/digitally-signed-http-requests)

Configure HMAC **SHA256**, with base64 output in the agreed signature header (proposed
`x-aam-signature`). The signature covers the **exact POST body**, not a JSON reserialization.
MD5/SHA1/unsigned requests are unsupported. A dedicated >=32-byte random signing key must be
shared securely with Adobe and injected as `WKND_AAM_SIGNATURE_SECRET`; do not paste it into
chat, URLs, Git, logs or a shared global format. Coordinate rotations with Adobe.
Other headers do not authenticate routing: `Client_ID`, `User_DPID` and destination ID inside
the signed body must all match the exact namespace-scoped configuration.

Accepted payload is Adobe's `ProcessTime`, `User_DPID`, `Client_ID`, `AAM_Destination_ID`
(table spelling) or `AAM_Destination_Id` (sample/format spelling), `User_count`, `Users`.
If both destination spellings are present they must agree. Decimal integer strings and actual
nonnegative safe integers are accepted; booleans, arrays, exponents and coercions are not.
Users have `AAM_UUID`, `DataPartner_UUID`, optional `AAM_Regions`, and `Segments`.
Each segment requires an allowlisted numeric `Segment_ID`, explicit `Status` 0/1 and `DateTime`.
Dates use Adobe's UTC representation, e.g. `Wed Jul 27 16:17:42 UTC 2016`; impossible dates and
future times are rejected. Limits: 64KiB, 10 users, 50 segments/user, 20 optional regions/user.
Messages exceeding these limits fail explicitly; the destination's selected format must fit them.

Coordinator readback of global **format 285**, "Default HTTP Realtime with UserDPID":
POST / JSON, no format headers, `User_DPID=<DPID>`, `Client_ID=<PID_ALIAS>`,
`AAM_Destination_Id=<ORDER_ID>`, decimal-string counts, `dpUuid`, active `seg.traitAlias` and
explicit `removedSegments` with Status 0, and **no AAM_Regions**. This is a candidate format,
not proof of a saved destination or proof that `dpUuid` exports the person alias.
Do not edit this shared format.

Adobe requires **HTTP 200 within 3000ms**, with only **one retry**, and publishes no throughput
rate limit. Intake first validates, then inserts a complete normalized inbox document with a
unique scope+raw-body digest and rereads it. Only confirmed durable receipt gets 200. There is no
reservation that acknowledges unfinished work. Uncertain writes, incomplete duplicates, DB
failure or the 2500ms persistence deadline return non200; the retry can confirm an already
committed complete document. No Brevo/identity/Target calls occur on the acknowledgement path.
Warm/cold Runtime + DB latency and expected delivery volume still require real destination
verification; unit timing is not a Production SLA. Limits are defensive payload limits, not
a delivery throttle. Do not enable until the selected format and capacity meet these bounds.

## Durable processing and ordering

`aam_outbound_inbox_v1` stores complete normalized hashed-identity events, never raw bodies or
emails. `aam_memberships_v1` is the shared CAS-backed canonical observation store. A private
worker drains one receipt per invocation; interrupted partial processing safely replays it.
Worker ownership uses a five-minute CAS lease, longer than the 120-second action timeout.
Brevo effects are separate and never affect Adobe acknowledgement.

Real-time messages may contain all memberships, but batches contain only changes and neither
message labels its mode. **Absence never removes membership.** Only explicit Status 0 writes a
sticky withdrawal tombstone. Last-verified `DateTime` is not a monotonic revocation sequence:
equal/older positive observations cannot refresh TTL, and **no later positive automatically
reactivates a tombstone**. A real reconciliation/reconsent policy is needed before adding such
an operation; none is exposed here. Historical signed removals are retained; historical
positives expire immediately according to qualification time, not receipt time.

Active observations expire at last verification plus the configured 1-minute..24-hour TTL.
Consumers enforce exclusive expiry and recheck the current TTL if shortened. Pending inbox
work makes positives unknown; missing, incomplete, expired or unverified identities also remain
unknown. Neither unknown nor a tombstone asserts a complete negative audience result.
There is no automatic deletion of replay receipts/tombstones: operational retention/privacy
policy and any safe reconciliation must preserve non-reactivation guarantees.

## Implementable identity registration (no arbitrary bootstrap)

Supported identity format is **only** DPID `1547309`, `wkndCustomerId`, with `DataPartner_UUID`
equal to the existing server-issued `wpa_` + 32 lowercase hex alias. ECID, raw Auth0 subject,
device UUID and ID-to-email guesses are not adapters.

When `WKND_AAM_IDENTITY_REGISTRATION_ENABLED=true` and destination scope is configured and
verified, the **existing authenticated first-party** `person-status`/`person-binding` handler
registers its own confirmed alias receipt in `aam_destination_identities_v1`. It verifies the
same subject, current explicit idLinkage generation and alias before and after CAS registration.
Delegated calls do not register. There is no new operation, request identity parameter, consent
writer, customer lookup by supplied ID or public membership/mapping write. Public
`wknd.person-binding/v1` remains unchanged. Source registration does not mark export verification
true. Failure reports unavailable rather than a success-shaped mapping.

Registration is keyed by SHA256(JSON.stringify([scopeKey, actualAlias])). Consumers reread the
registered subject's authoritative grant and exact existing alias with `create:false`; they
never mint an alias. Grant changes/withdrawal and registration expiry fail closed.
This is an implemented initializer, not a request for manual unknown collection writes.
The registration augmentation needs a separately approved current-source diagnostic publication;
a disabled `aam` package release does **not** alter the existing diagnostic or storefront.

An authenticated Auth0 profile refresh also records `emailIdentityVerified` only for a matching
subject with literal `email_verified:true`. Brevo projection requires that fresh (<=24h) profile,
current audienceEmail opt-in with matching consent evidence/wording, and no local suppression.
It locates **only an existing Brevo contact** by that verified email, confirms the returned
identity, and CAS-stores its numeric contact ID/hash in the registered mapping. No synthetic
fallback profile email or new contact is used.

## Commerce and Brevo consumers

With its separate read gate enabled, authenticated `Customer.wknd_aam_memberships` reads the
same canonical store:

```graphql
customer {
  wknd_aam_memberships {
    segment_id status expires_at financial_authorization
  }
}
```

Statuses: `MEMBER` (fresh scoped observation + current verified identity), `WITHDRAWN`
(explicit tombstone), `UNKNOWN`. Disabled returns `[]`. No subject/alias/email is exposed.
`financial_authorization` is always false. Existing financial audience resolvers, promotions,
cart pricing, recovery and bundle settings are not wired to this field.

The private worker may separately add/remove the confirmed existing numeric contact from
dedicated receiver-owned lists using Brevo's
[add](https://developers.brevo.com/reference/add-contact-to-list) /
[remove](https://developers.brevo.com/reference/remove-contact-from-list) endpoints.
List mappings must cover the exact segment allowlist, have distinct positive list IDs, be
verified as receiver-owned, and have **no campaigns/automation attached**.
No campaigns, sends, imports, unsubscribes or other profile edits occur.

Before adds: identity, generation, freshness, consent evidence, suppression, Brevo blacklist,
contact identity and inbox completeness are checked. Owned projections are removed on expiry,
withdrawal or consent loss even if current identity authorization no longer permits an add.
Identity changes at the same Brevo contact ID fail explicitly rather than editing someone else.
Confirmed per-contact success and readback are required; HTTP 201 alone or partial arrays are
not success. A pending/ambiguous add is never blindly retried: its projection is blocked and
conservatively reconciled/removed on the next run. Unknown outcomes remain operator-visible.
Brevo may still have asynchronous/in-flight uncertainty; this is not atomic with AAM or an
email-send permission. Worker scans bounded pages with a durable cursor, so cleanup needs the
approved scheduler to run regularly; no immediate upstream deletion SLA is claimed.

## Configuration confirmation checklist

All `WKND_AAM_*` inputs are documented in [.env.example](../.env.example).
Before activation confirm:

| Actual destination/server field | Receiver setting / requirement |
| --- | --- |
| Dedicated name | Proposed `WKND Commerce + Brevo Production AAM Receiver` |
| Domain / port / URL prefix | `28538-wkndcommerce.adobeioruntime.net` / **443 HTTPS** / `/api/v1/web/aam/receiver`; verify UI actually constructs HTTPS, not HTTP |
| MaxUsers | <=10; signed total count must agree |
| Authentication | None **only for HTTP auth**; SHA256 HMAC remains mandatory |
| HTTP signature header / algorithm / key | `x-aam-signature` / SHA256 / securely injected same private key |
| Realtime server / format | Dedicated server + confirmed format285; do not change the shared format |
| Foreign Client ID / PID_ALIAS | Coordinator-selected `wknd-commerce-brevo-production`; must match `WKND_AAM_CLIENT_ID` |
| Destination ORDER_ID | Actual saved ID -> `WKND_AAM_DESTINATION_ID`; never invent one |
| User DPID and actual dpUuid | `1547309` candidate only; prove export is the existing exact `wpa_...` alias |
| Segment mapping aliases | Confirm actual exported `seg.traitAlias`; retain existing source IDs; numeric exact `WKND_AAM_SEGMENT_ALLOWLIST` |
| Environment | `production`, exact Runtime namespace `28538-wkndcommerce` |
| TTL, batching and capacity | Approved TTL + <=50 segments/user + DB durable writes and <3s real acknowledgement |
| List map and suppression | Confirm existing dedicated Brevo lists, no sends/automations, API key and existing-contact read/list permissions |
| Privacy/retention/reconciliation | Approve receiver data retention, sticky withdrawal handling and regular private worker schedule |

Keep realtime/batch delivery **OFF** while saving the dedicated server/destination. Keep
`RECEIVER_ENABLED`, `WORKER_ENABLED`, `COMMERCE_READ_ENABLED`, `CONFIG_VERIFIED`,
`IDENTITY_MAPPING_VERIFIED`, `IDENTITY_REGISTRATION_ENABLED`, `BREVO_SYNC_ENABLED` and
`BREVO_LISTS_VERIFIED` false until their individual conditions are met. No scheduler is added
automatically. A disabled endpoint may be published solely for setup; it returns 404 and
performs no DB/provider calls. A saved inactive destination is not live qualification.

Canonical engagement rules/trait alignment remain separate: this receiver ingests actual
destination observations; it does not invent quiz/navigation/kit events or change existing IDs.
No successful-generation receipt matrix is required to prepare this receiver.
