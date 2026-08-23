import { createDecipheriv, createSign, createVerify } from "node:crypto";
import { loadPaymentConfig } from "./payment-config.ts";
import { type PaymentProvider, type RechargeOrder, type PaymentCreateResult, type PaymentNotifyResult } from "./payment-provider.ts";

function pem(value?: string): string {
  if (!value) throw new Error("missing WeChat Pay key configuration");
  return value.replace(/\\n/g, "\n");
}

export class WeChatNativeProvider implements PaymentProvider {
  readonly name = "wechat" as const;
  private readonly cfg = loadPaymentConfig().wechat;
  private readonly notifyBaseUrl = loadPaymentConfig().notifyBaseUrl;

  private authorization(method: string, urlPath: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
    const signer = createSign("RSA-SHA256");
    signer.update(message);
    signer.end();
    const signature = signer.sign(pem(this.cfg.privateKeyPem), "base64");
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.cfg.merchantId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.cfg.merchantSerialNo}"`;
  }

  async createPayment(order: RechargeOrder): Promise<PaymentCreateResult> {
    if (!this.cfg.enabled || !this.cfg.appId || !this.cfg.merchantId || !this.cfg.merchantSerialNo) throw new Error("WeChat Pay is not configured");
    const path = "/v3/pay/transactions/native";
    const body = JSON.stringify({
      appid: this.cfg.appId,
      mchid: this.cfg.merchantId,
      description: `TokenPanel ${order.tokenGrant.toString()} Tokens`,
      out_trade_no: order.orderId,
      notify_url: `${this.notifyBaseUrl}/api/payments/wechat/notify`,
      amount: { total: order.amountFen, currency: "CNY" },
    });
    const res = await fetch(`https://api.mch.weixin.qq.com${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: this.authorization("POST", path, body) },
      body,
    });
    const json = await res.json() as { code_url?: string; code?: string; message?: string };
    if (!res.ok || !json.code_url) throw new Error(`WeChat create order failed: ${json.code ?? res.status} ${json.message ?? ""}`);
    return { provider: this.name, orderId: order.orderId, qrCode: json.code_url, payUrl: json.code_url, raw: json };
  }

  async verifyNotification(input: { body: string; headers: Record<string, string | undefined>; query: Record<string, string | undefined> }): Promise<PaymentNotifyResult> {
    const signature = input.headers["wechatpay-signature"];
    const timestamp = input.headers["wechatpay-timestamp"];
    const nonce = input.headers["wechatpay-nonce"];
    if (!signature || !timestamp || !nonce || !this.cfg.platformPublicKeyPem || !this.cfg.apiV3Key) return { verified: false, success: false };
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${timestamp}\n${nonce}\n${input.body}\n`);
    verifier.end();
    if (!verifier.verify(pem(this.cfg.platformPublicKeyPem), signature, "base64")) return { verified: false, success: false };
    const envelope = JSON.parse(input.body) as { resource?: { algorithm?: string; ciphertext?: string; nonce?: string; associated_data?: string } };
    const r = envelope.resource;
    if (!r || r.algorithm !== "AEAD_AES_256_GCM" || !r.ciphertext || !r.nonce) return { verified: false, success: false };
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(this.cfg.apiV3Key, "utf8"), Buffer.from(r.nonce, "utf8"));
    decipher.setAAD(Buffer.from(r.associated_data ?? "", "utf8"));
    const encrypted = Buffer.from(r.ciphertext, "base64");
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8");
    const data = JSON.parse(plain) as { out_trade_no: string; transaction_id?: string; trade_state?: string; amount?: { total?: number } };
    return { verified: true, orderId: data.out_trade_no, providerTradeId: data.transaction_id, paidAmountFen: data.amount?.total, success: data.trade_state === "SUCCESS", raw: data };
  }
}
