/**
 * Approved Production defaults, scoped by Runtime's namespace (never a caller-supplied value).
 * Existing action inputs override defaults; all credentials stay in encrypted Runtime inputs.
 */
function emailParams(params) {
  if (process.env.__OW_NAMESPACE !== '28538-wkndcommerce') return params;
  return {
    RECOVERY_EMAIL_AUTOMATION_ENABLED: 'true',
    SHOP_CART_URL: 'https://wknd-adventures.run.place/shop/cart',
    ORDER_CONFIRMATION_ENABLED: 'true',
    ORDER_CONFIRMATION_SENDER_EMAIL: 'hello@wknd-adventures.run.place',
    ORDER_CONFIRMATION_SENDER_NAME: 'WKND Adventures',
    ...params,
  };
}

module.exports = { emailParams };
