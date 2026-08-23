# Token Recharge & Payment

The API recharge packages are defined in `apps/api/src/billing/recharge-packages.ts`.

Default packages:

| RMB | Tokens |
|---:|---:|
| ¥1 | 1,000,000 |
| ¥5 | 5,000,000 |
| ¥10 | 10,000,000 |
| ¥20 | 20,000,000 |
| ¥50 | 50,000,000 |
| ¥100 | 100,000,000 |

## Payment configuration

Use environment variables; never commit merchant secrets.

### WeChat Pay

- `WECHAT_PAY_ENABLED=true`
- `WECHAT_PAY_APP_ID`
- `WECHAT_PAY_MERCHANT_ID`
- `WECHAT_PAY_MERCHANT_SERIAL_NO`
- `WECHAT_PAY_API_V3_KEY`
- `WECHAT_PAY_PRIVATE_KEY_PEM`
- `WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM`

WeChat Pay API v3 callbacks are POST notifications. The service must verify `Wechatpay-Serial`, `Wechatpay-Signature`, `Wechatpay-Timestamp`, and `Wechatpay-Nonce`, decrypt the resource, validate the order amount, then idempotently credit tokens. WeChat documents a 5-second acknowledgement requirement and notes that duplicate notifications can occur.

### Alipay

- `ALIPAY_ENABLED=true`
- `ALIPAY_APP_ID`
- `ALIPAY_PRIVATE_KEY_PEM`
- `ALIPAY_PUBLIC_KEY_PEM`
- `ALIPAY_GATEWAY_URL=https://openapi.alipay.com`

Alipay's official Node.js SDK supports signing/verification and notification signature checks. The integration should verify the callback before crediting tokens and validate the amount and merchant order number.

### Public URL

- `PUBLIC_BASE_URL`
- `PAYMENT_NOTIFY_BASE_URL`

These must point to your HTTPS deployment when using production payment callbacks.
