# Stage one-hour shopper cart window

This audience-source slice is separate from the **55-minute financial/email recovery policy**
(nominal automatic reminder trigger at the next five-minute alarm, within 55–60 minutes).
The approved window is nonempty active owner carts with valid quantities and activity,
inactivity **>=1 hour and <=7 days**, and no recorded owner purchase since that cart's activity.
Malformed/incomplete purchase/activity evidence stays unknown, not false. Any qualifying cart
establishes a positive aggregate; another cart becoming empty/new cannot overwrite it.
Terminal merged sources are excluded; only persisted destination activity defines the next episode.
New activity resets the window and can qualify again one hour later.

The existing `promotions-worker-tick` (`*/5 * * * *`) calls the refresh path without needing a shopper
request. Cart/order/merge persistence hooks refresh the same aggregate. Thus crossing and expiry
are processed on the next successful five-minute tick **plus Runtime/Adobe processing latency**,
not exactly at the wall-clock boundary. Complete carts/orders are rechecked, not transactional.
The worker discovers only persisted granted customers matching the sole configured shopper-key
allowlist. It must reuse a fresh current-grant server-issued binding; it cannot grant consent,
mint/resync an identity, or infer financial/member evidence.

## Wire contract and AAM boundary

Existing guarded DCS transport emits:

| Key | Value |
|---|---|
| `c_wknd_stage_shopper_cart_window` | `within-window`, `outside-window`, `unknown` |
| `c_wknd_stage_shopper_cart_observed_at` | server ISO observation time |
| `c_wknd_stage_shopper_cart_count` | candidate count; omitted when unknown with no positive candidate |
| `c_wknd_stage_shopper_cart_episode_set` | opaque digest, never raw IDs |

`c_wknd_stage_shopper_cart_window == "within-window"` is a supported **historical realization**
trait rule, **not a correct current Cart Abandoners segment**. Do not activate that naive segment:
a subsequent outside/unknown signal does not remove a realized trait. Adding a global negative
trait prevents later episodes from requalifying. One-day TTL is **25–47 hours**, not one hour.
No timestamp comparison, receipt, Target marker, or worker tick proves AAM membership/removal.

Minimal remaining platform decision: use an Adobe-supported trait-removal/current-state ingestion
mechanism (documented `d_unsid` is **batch inbound files**, not permission to send it on DCS), or
explicitly accept historical realization semantics. The first requires separately approved
integration; the second does not satisfy current reset/purchase/expiry semantics. No new traits,
segments, external end signals, global exclusions or fabricated deletion are created here.
Existing climbing/planning audience definitions are untouched.

Official references:
- https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/features/traits/segment-ttl-explained
- https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/implementation-integration-guides/sending-audience-data/batch-data-transfer-process/inbound-file-contents

## Release controls

Ordinary builds, Production and unapproved namespaces remain OFF. The exact Stage lexical release
must separately set `enabled:true`, `factsOnly:true`, `cartWindow:true`, its existing trusted Stage
Target settings, and worker-only approved Auth0 issuer/audience. No body parameter enables it.
The latter two public identity configuration strings are copied only for this worker composition;
they never overwrite storefront identity/DB/legacy gates. No new Runtime inputs or cron are added.
Publish only the affected storefront and worker **exec**, preserving opaque parameters/security.
The worker's existing recovery/email paths and all their inputs remain unchanged. The previously
waived Stage email URL concern stays deferred, not a blocker for this audience-source slice.
