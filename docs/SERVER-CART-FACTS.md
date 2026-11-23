# A07 server cart facts

Source-ready adapter for a future AAM publisher. **No call sites, deployment, provider calls or live
AAM qualification are enabled.** The adapter does not evaluate Cart Abandoners, recovery eligibility,
offers, redemption or financial authorization.

## Exported contract

`lib/server-cart-facts.js` exports `createServerCartFacts`, `CartFactsError` and `FACT_SCHEMA`.
The factory accepts only server dependencies: `{ store, claims, environment, publisher?, clock? }`.
`claims` must already be Auth0-verified, as in the existing Target diagnostic. `environment` must
come from the validated server environment, not the request. The instance exposes:

- `read(cartId)`: read the persisted cart with `loadCart(..., {allowInactive:true})`, require its
  signed-in owner, read that owner's complete order list, and recheck the cart snapshot.
- `handoff(cartId)`: do the same fresh read, then invoke the injected `publisher(packet)` once.
  The publisher must resolve exactly `true`; missing, negative or ambiguous acknowledgement throws.
  Transport/database errors propagate. There is no retry, default HTTP destination or credential store.

Both return this frozen, allowlisted packet:

```js
{
  schema: 'wknd.server-cart-facts/v1',
  source: 'server-records',
  environment: 'stage',
  observedAt: '2026-11-23T07:00:00.000Z',
  cart: {
    state: 'active', // active | ordering | ordered | merging | merged
    version: 'v1', // existing cartVersion helper; legacy unversioned carts use v0
    lastActivityAt: '2026-11-22T01:00:00.000Z', // or null if unknown
    activitySource: 'activityAt', // updatedAt | createdAt | null are also possible
    itemCount: 2, // line count, not units
    totalQuantity: 2.5
  },
  purchase: {
    sinceLastActivity: 'not-recorded', // recorded | not-recorded | unknown
    reason: null, // ACTIVITY_UNKNOWN | ORDER_RECORD_UNKNOWN | CART_NOT_ACTIVE
    lastOrderAt: null,
    orderState: 'none' // processing-demo | none | unknown
  },
  episode: {
    key: 'cep_<64 lowercase hex>', // or null when activity is unknown
    startedAt: '2026-11-22T01:00:00.000Z' // or null
  }
}
```

No raw cart ID, shopper ID, email, SKU, address, order number, token or provider response is exported.
The episode key hashes schema, environment, persisted cart ID and activity timestamp using
the existing `canonicalJson`/`sha256` helpers. It is a correlation key, **not authentication or membership
evidence**. Generic writes can change `version` without changing the episode. Backfilling the activity
source with the same timestamp does not create another episode.

## Fact semantics and unknowns

- Activity uses the same `activityAt || updatedAt || createdAt` order as `recovery-policy.js`, but
  never its eligibility evaluator. A present malformed activity timestamp does not fall back to a
  newer generic write. Timestamps must be canonical server UTC ISO strings and not in the future.
- `cart.js` already updates `activityAt` for item add/update/remove and non-empty merges. Generic
  `saveCart` writes update `updatedAt` and the revision, not `activityAt`.
- Orders are the actual owner's persisted records across **all carts**. An order at or after
  the activity timestamp establishes `recorded`; `Processing (demo)` maps to `processing-demo`.
  This means a demo order was recorded, not that money was charged.
- `not-recorded` means the complete successful order read contained no such record, with valid
  timestamps/statuses and an active cart. It is not a claim of AAM non-membership or future absence.
  Missing/malformed/future dates, unknown order states or inactive/transitional carts never produce
  an invented negative fact. Unknown latest-order provenance is not replaced with an older order.
- A changed cart snapshot aborts with `CART_CHANGED`; malformed cart records abort rather than
  coercing strings into quantities. Unknown fact fields are explicit, not silent error fallbacks.
- Reads are not a multi-document transaction. `observedAt` is the server observation time, not a
  completeness watermark or audience evaluation timestamp. The provider owner must handle freshness,
  out-of-order handoffs and events racing these reads. Nothing here proves live transport acceptance,
  AAM profile merge semantics, segment membership or E05 email acceptance.

## Exact integration hooks for the provider owner (b8)

No existing files were wired or changed. Coordinate these hooks before adding call sites:

1. Construct the adapter using the existing request's verified `ctx.customer` and `ctx.store`.
   Derive `environment` through the existing server environment gate. Do not accept a caller's fact
   object, environment, identity or endpoint; `read`/`handoff` accept only a cart reference.
2. Inject a publisher closure over b8's existing transport and server-issued identity binding.
   Preserve its configured workspace, identity-linkage consent grant and lifecycle generation checks
   immediately before transmission. Map only these fact fields to the approved AAM attributes.
   `true` acknowledges that boundary's handoff, **not qualified audience membership**. Do not forward
   raw identity/provider responses through this adapter, or turn unknown into false/zero.
3. Cart-write hooks are after successful persistence in `lib/resolvers.js` `updateCart` and
   `respondCart`, and after `lib/cart.js` `mergeCarts` commits source/destination state.
   Send the destination facts and invalidate/replace the merged source's prior episode as required by
   the approved provider protocol. Never publish from a failed mutation or its pre-save snapshot.
4. Purchase hooks cover **both** resolver paths calling `lib/orders.js` `placeOrder`: `placeOrder`
   and `setPaymentMethodAndPlaceOrder`. The authoritative order is inserted before the ordered-cart
   save. An order may therefore persist even if later cart bookkeeping fails: coordinating durable
   delivery must anchor to the successful order insert, not only a successful resolver response.
   The affected shopper's other active carts also need fresh purchase-since-activity facts.
5. Live Stage transport/profile ingestion, freshness/order handling, consent withdrawal and actual
   Cart Abandoners qualification remain b8's acceptance work. E05 must keep its existing pause and
   readiness gates until that evidence and email configuration are independently accepted.

Focused offline validation:

```sh
./node_modules/.bin/jest --runInBand --runTestsByPath test/server-cart-facts.test.js
./node_modules/.bin/eslint lib/server-cart-facts.js test/server-cart-facts.test.js
```

Tests use isolated in-memory persisted records and existing cart persistence/activity helpers; they
do not reset live fixtures, place live orders, publish traits or send email.
