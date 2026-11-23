# Stage live-audience planner demo

The source defaults **OFF**. `WKND_STAGE_AAM_GENERAL_OFFERS_ENABLED=true` enables an explicitly
mock-Commerce Stage benefit only when the configured Stage environment and exact Runtime namespace
match. Production cannot enable this path, even with the flag set. This is not trusted financial
Audience Manager authorization.

`lib/stage-live-audience.js` reuses the authenticated customer, authoritative `idLinkage` grant,
v2 binding store, retained-aware ID provider and Target diagnostic. The active Stage activity's
canonical `climbing-planner` / `climbing-interest` markers map to the existing registry keys.
Control, absent binding, transport failure and unavailable decisions remain unknown; no complete
negative, membership attestation or behavioral audience evaluator is invented. Provider metadata
stays internal: `source:'target-aam-decision'`, `evidence:false`, `financialAuthorization:false`.
Delegated reads can reuse a valid confirmed binding but cannot mint, relink or grant consent.

The independently approved Stage candidate is 10% off catalog merchandise tagged `climbing`,
capped at AUD25. Tags select merchandise, not shopper membership. It reuses C01's disabled-draft
definition normalizer and the existing promotion engine. No authoring draft is read, activated,
copied to promotions or used as cart evidence. Real qualification is inspected alongside the demo.

## Shared consumer contract

```graphql
query Planner($id: String!) {
  wkndPlannerOffer(cart_id: $id) {
    kind status percent_off max_discount { value currency }
    saving { value currency } current_saving { value currency } expires_at message
  }
}
```

The query and `Cart.wknd_planner_offer` return the same normalized `WkndRecoveryOffer` shape:
`kind:'climbing_planner'`, `coupon_code:null`, nullable expiry, and existing Money `{value,currency}`.
`ELIGIBLE` means available but not the engine's winner. `CLAIMED` means automatically selected in
the mock cart totals; **it requires no welcome-back claim and no planner claim/apply mutation**.
`UNAVAILABLE` includes a user-facing message and does not assert negative qualification.
No AAM/draft IDs, source or evidence metadata appear in this offer.

The existing shared engine selects the best actual saving, retains a better coupon and performs
integer-cent allocation/GST. The automatic label is **Climbing planner gear benefit**, not
welcome-back `offer_applied`. A change in effective selected savings updates the cart by its existing
revision CAS and advances `wknd_cart_version`; stable reads do not. A stale reviewed version remains
invalid. Production pricing and source-OFF behavior remain unchanged.

## Publication boundary

Only `commerce/storefront-graphql` needs this runtime source and final-input configuration.
`schema/promotions.graphql` is the schema authority; `npm run schema:build` regenerates the storefront
SDL. Native/LLM consumers use the query above and the normalized cart field.

No changes/deployments to C01's MCP, secured admin, public admin sequence or validators, or to
worker/webhook/diagnostic are required. Selective publication must retain their metadata and preserve
storefront security/credentials. Never replay encrypted GET parameters as plaintext. Configuration
updates require the complete authoritative original storefront inputs plus the explicit Stage
overlay; missing unrelated gates must not be guessed. Upstream withdrawal, live qualification and
cross-channel completeness are separate checks, not prerequisites for this mock wiring.
