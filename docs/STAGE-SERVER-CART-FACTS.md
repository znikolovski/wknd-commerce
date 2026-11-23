# Stage facts-only DCS handoff

This is a coordinator technical scope choice while the user is unavailable, **not approval of
new audience rules**. No Cart Abandoners traits/segments or existing page-view/climbing/planning
definitions are changed. No Target marker, page view, planning event, qualification, member or
financial attribute is synthesized.

`lib/stage-cart-fact-publisher.js` maps the exact `wknd.server-cart-facts/v1` packet:

| DCS key suffix (each prefixed `c_wknd_stage_`) | Packet field |
| --- | --- |
| environment | environment |
| observed_at | observedAt |
| cart_state | cart.state |
| cart_version | cart.version |
| cart_last_activity_at | cart.lastActivityAt |
| cart_activity_source | cart.activitySource |
| cart_item_count | cart.itemCount |
| cart_total_quantity | cart.totalQuantity |
| purchase_since_last_activity | purchase.sinceLastActivity |
| purchase_last_order_at | purchase.lastOrderAt |
| purchase_order_state | purchase.orderState |
| episode_key | episode.key |
| episode_started_at | episode.startedAt |

`recorded`, `not-recorded`, `unknown` remain strings. Absent optional values are omitted;
known counts of zero are legitimate facts, never substitutes for unknown. No raw cart/order/shopper
ID, email, SKU or token enters a customer-defined attribute. Reserved identity transport alone
uses the existing server-issued MID and verified declared identity under its current grant.
Delegated requests send only the existing MID, never a declared-ID assertion or identity link.
Neither a MID-only ACK nor a direct ACK proves authenticated-profile realization/qualification.

The exact Stage system namespace is required. Ordinary source and Production default OFF;
the approved server ZIP must separately include `factsOnly:true` in its lexical release configuration.
The sender reuses, but never mints/resyncs/relinks, a valid fresh v2 binding and confirmed grant.
It uses the existing verified partner `ags050.demdex.net/event`, bounded no-cookie/no-redirect
requests, JSON acknowledgement and no identity-sync response processing.

Existing binding-row CAS serializes handoffs across requests, with an eight-second lease,
fresh cart/order reads, a thirty-second observation limit, same grant/identity/etag checks before
and after transmission, and fixed sanitized failure receipts. A failed/unknown response is not ACK.
The A07 callback returns exactly true only after valid transport ACK and final freshness/ownership
checks. There is no retry of a stale packet or claim that an already-sent request can be recalled.

Post-persistence hooks cover cart mutations, complete merges and the durable order insert **before**
the ordered-cart save. Other active carts of the same verified shopper are independently refreshed
even if one handoff fails. Telemetry failures never undo an inserted order or committed cart mutation.

After a verified durable merge, the source's opaque episode is suppressed in the existing binding
row, scoped to that binding/grant; no external end or global exclusion is sent. Destination facts
come only from persisted state. An empty/replayed merge does not manufacture a new activity time.
Guest/unverifiable terminal episodes are not invented. Fresh source rereads reject merging/merged
states, so stale source retries cannot reactivate them. The bounded terminal ledger does not drop
older entries silently.

**DCS values are not transactional/current-cart aggregation or eligibility.** In-flight calls can
race later mutations, and AAM trait realization is historical; these guards are not a transactional
watermark or dequalification guarantee. Episode-scoped AAM end/expiry/aggregation semantics remain
deferred. No timers, scanners, new infrastructure or audience evaluators are added.
Public DCS custom signals are not authenticated financial evidence merely because these names
also have a server-owned producer.

Only `commerce/storefront-graphql` requires selective exec-only publication. All Runtime inputs,
including the nineteen original opaque inputs, and the other twenty-three actions remain unchanged.
Worker16, diagnostic5, webhook13 and authoring nodes are not republished.

References:
- [Supported DCS attributes](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/api-and-sdk-code/dcs/dcs-api-reference/dcs-keys)
- [CID identity transport](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/reference/cid)
- [CURRENT/NONE profile semantics](https://experienceleague.adobe.com/en/docs/audience-manager/user-guide/features/profile-merge-rules/merge-rule-definitions)
