export type PaymentConfig = {
  baseUrl: string;
  notifyBaseUrl: string;
  wechat: {
    enabled: boolean;
    appId?: string;
    merchantId?: string;
    merchantSerialNo?: string;
    apiV3Key?: string;
    privateKeyPem?: string;
    platformPublicKeyPem?: string;
  };
  alipay: {
    enabled: boolean;
    appId?: string;
    privateKeyPem?: string;
    alipayPublicKeyPem?: string;
    gatewayUrl?: string;
  };
};

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadPaymentConfig(): PaymentConfig {
  return {
    baseUrl: process.env.PUBLIC_BASE_URL?.trim() ?? "http://localhost:3000",
    notifyBaseUrl:
      process.env.PAYMENT_NOTIFY_BASE_URL?.trim() ??
      process.env.PUBLIC_BASE_URL?.trim() ??
      "http://localhost:3000",
    wechat: {
      enabled: process.env.WECHAT_PAY_ENABLED === "true",
      appId: optional("WECHAT_PAY_APP_ID"),
      merchantId: optional("WECHAT_PAY_MERCHANT_ID"),
      merchantSerialNo: optional("WECHAT_PAY_MERCHANT_SERIAL_NO"),
      apiV3Key: optional("WECHAT_PAY_API_V3_KEY"),
      privateKeyPem: optional("WECHAT_PAY_PRIVATE_KEY_PEM"),
      platformPublicKeyPem: optional("WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM"),
    },
    alipay: {
      enabled: process.env.ALIPAY_ENABLED === "true",
      appId: optional("ALIPAY_APP_ID"),
      privateKeyPem: optional("ALIPAY_PRIVATE_KEY_PEM"),
      alipayPublicKeyPem: optional("ALIPAY_PUBLIC_KEY_PEM"),
      gatewayUrl: optional("ALIPAY_GATEWAY_URL") ?? "https://openapi.alipay.com",
    },
  };
}
