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

Configure HMAC **SHA256**, with base64 output in the agreed signature header
`x-aam-signature`. The signature covers the **exact POST body**, not a JSON reserialization.
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
explicit `removedSegments` with Status 0, and **no AAM_Regions**. It is configured on saved
destination120278, not proof that `dpUuid` exports the person alias.
Do not edit this shared format.

Adobe requires **HTTP 200 within 3000ms**, with only **one retry**, and publishes no throughput
rate limit. Intake first validates, then inserts a complete normalized inbox document with a
unique scope+raw-body digest and rereads it. Only confirmed durable receipt gets 200. There is no
reservation that acknowledges unfinished work. Uncertain writes, incomplete duplicates, DB
failure or the 2500ms persistence deadline return non200; the retry can confirm an already
committed complete document. No Brevo/identity/Target calls occur on the acknowledgement path.
Warm/cold Runtime + DB latency and expected delivery volume still require real destination
verification; unit timing is not a Production SLA. Limits are defensive payload limits, not
a delivery throttle. Confirm the selected format fits these bounds and obtain explicit
population/write approval before arming intake. Real acknowledgement timing remains a
separate acceptance check, not a claim inferred from configuration.

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
Confirm protocol, scope, signing, storage and export/write approval before arming intake.
Identity export, list permissions and reconciliation are separate consumer gates:

| Actual destination/server field | Receiver setting / requirement |
| --- | --- |
| Saved destination name / ID | `WKND Production AAM Destination` / `120278` (partner8455, S2S) |
| Domain / port / URL prefix | `28538-wkndcommerce.adobeioruntime.net` / **443 HTTPS** / `/api/v1/web/aam/receiver`; verify UI actually constructs HTTPS, not HTTP |
| MaxUsers | <=10; signed total count must agree |
| Authentication | None **only for HTTP auth**; SHA256 HMAC remains mandatory |
| HTTP signature header / algorithm / key | `x-aam-signature` / SHA256 / securely injected same private key |
| Realtime server / format | Dedicated server5030 + confirmed format285; do not change the shared format |
| Target Data Source / master source | Saved `1547309` / `1547309`, integration code `wkndCustomerId`; source is now inboundS2S=true and outboundS2S=true |
| Foreign Client ID / PID_ALIAS | Coordinator-selected `wknd-commerce-brevo-production`; must match `WKND_AAM_CLIENT_ID` |
| Destination ORDER_ID | Saved `120278` -> `WKND_AAM_DESTINATION_ID` |
| Saved destination labels | `ONSITE_PERSONALIZATION`, `PII`; preserve these and source export controls, not proof of permitted alias export |
| User DPID and actual dpUuid | Signed intake scope `1547309`; before consumers, prove export is the existing exact `wpa_...` alias |
| Segment mapping aliases | Selected source `27507404`, registry label `Climbing Planner`; configure numeric export alias `27507404`, matching the sole allowlist entry; actual export still requires capture |
| Environment | `production`, exact Runtime namespace `28538-wkndcommerce` |
| TTL, batching and capacity | Approved TTL + <=50 segments/user + DB durable writes and <3s real acknowledgement |
| List map and suppression | Confirm existing dedicated Brevo lists, no sends/automations, API key and existing-contact read/list permissions |
| Privacy/retention/reconciliation | Approve receiver data retention, sticky withdrawal handling and regular private worker schedule |

The actual Admin creation form requires a Target Data Source and at least one delivery mode.
For this setup, select **realtime**, leave **batch OFF**, and save the new destination with
**no segments mapped**. Selecting a required delivery mode is not receiver or consumer activation.

Source1547309 was previously excluded from the Admin's `outboundOnly:true` query. Its saved
settings now have inbound and Outbound S2S enabled, sharing=false, and the
`ONSITE_AD_TARGETING` / `OFFSITE_AD_TARGETING` restrictions preserved. Do not change remaining settings.
Do not substitute another source or relax its export controls. Outbound eligibility and a stale
raw-sub description do not prove that format285 exports the required server person alias.

Keep `WORKER_ENABLED`, `COMMERCE_READ_ENABLED`, `IDENTITY_MAPPING_VERIFIED`,
`IDENTITY_REGISTRATION_ENABLED`, `BREVO_SYNC_ENABLED` and `BREVO_LISTS_VERIFIED` false until
their separately approved conditions are met. No scheduler is added automatically. A disabled
endpoint may be published solely for setup; it returns 404 and performs no DB/provider calls.
A saved realtime-selected, unmapped destination is not live qualification.

### Approved full-population intake and capture

The user explicitly authorized **"Authorize full eligible-segment export and queued intake
records"**. Mapping one segment can export all eligible members, including initial backlog and
in-flight transfers. Neither MaxUsers10, sampling denominator1, a single captured receipt nor
later unmapping bounds total recipients or writes. Unknown/unconsented identities may be
stored pseudonymously in the approved durable inbox. This is not a one-shopper test.

Production `aam/receiver` **0.0.4** is armed for signed **intake only**, scoped to
destination120278 / client `wknd-commerce-brevo-production` / DPID1547309 / environment
`production`. `AAM_RECEIVER_ENABLED` and this action's `AAM_CONFIG_VERIFIED` are true;
the latter confirms the intake contract, not identity export or consumer readiness.
The original executable, annotations, limits and publish state are unchanged. Package inputs
and all other actions remain unchanged; the private worker is still disabled0.0.1.

The existing Production workspace4566206088345849900 credentials were privately installed as
`__ims_oauth_s2s` with `__ims_env=prod`. The IMS annotation alone had not installed these defaults
when the new action was created. A real read-only Database Storage connection and catalog/inbox
queries passed using that same namespace and workspace. Local SDK checks must supply Runtime
namespace `28538-wkndcommerce`; a missing local namespace is not evidence of an auth denial.
Never replay opaque GET parameters or print credentials. The same private signing key remains
bound (SHA256 fingerprint prefix `00b2a53b93c6`), without regeneration or clipboard changes.

The sole allowlist entry is numeric export alias **27507404**, for existing registry source
**27507404 / Climbing Planner** (`climbing-planner`). Observation TTL is **3600000ms (one hour)**,
measured from last verification. It is not inbox retention: queued records remain durable until
operator review, without automatic purge. Payload limits remain unchanged.

Next manual step for the user/coordinator:

1. In destination120278, map only existing source segment27507404 with numeric export mapping
   value **27507404**. Verify the actual source ID; do not rename it, create a segment or
   fabricate qualification. If other mappings are present, stop and reconcile scope rather
   than silently changing them or broadening the receiver allowlist.
2. Preserve realtime ON, batch OFF, format285/server5030, source export controls and labels.
   Backend code does not perform Adobe UI writes.
3. Monitor scoped inbox count and recent complete queued receipts read-only. Report aggregate
   event/identity counts, segment IDs and receipt timing; never log raw bodies, aliases, emails
   or signatures. Correlate genuine Runtime responses with complete durable receipts and
   inspect actual HTTP200/latency. Missing, rejected or uncertain delivery is not acceptance.
4. When an existing explicitly consenting demo identity's fresh authenticated `person-status`
   receipt is available, compare its expected
   SHA256(JSON.stringify([scopeKey, receipt.personAlias])) privately with queued identity keys.
   Do not mint an alias or grant. A match proves that observed export's identity only, not
   full-population identity coverage, qualification or consumer activation.

As of `2026-11-24T09:00:35Z`, the scoped inbox count is **0**. Unsigned HTTPS returns
401 `SIGNATURE_INVALID`; Production DB reads pass. No genuine signed durable acceptance,
HTTP200 or real delivery latency is yet verified, and no synthetic signed body was sent.
The first actual approved export supplies this evidence; do not claim an end-to-end pass
from the unsigned smoke or a read-only DB check.

Live diagnostic0.0.5 has the existing person receipt transport but not this PR's registration
initializer; live storefront0.0.26 does not expose the shared membership field. Neither action
was changed for destination setup. Registration publication and all downstream consumers
remain separately gated. No contacts, lists, campaigns, grants or financial settings were
changed by arming intake.

Canonical engagement rules/trait alignment remain separate: this receiver ingests actual
destination observations; it does not invent quiz/navigation/kit events or change existing IDs.
No successful-generation receipt matrix is required to prepare this receiver.
