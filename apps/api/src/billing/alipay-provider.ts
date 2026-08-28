import { createSign, createVerify } from "node:crypto";
import { loadPaymentConfig } from "./payment-config.ts";
import { type PaymentProvider, type RechargeOrder, type PaymentCreateResult, type PaymentNotifyResult } from "./payment-provider.ts";

function pem(value?: string): string { if (!value) throw new Error("missing Alipay key configuration"); return value.replace(/\\n/g, "\n"); }
function encode(value: string): string { return encodeURIComponent(value).replace(/%20/g, "+"); }
function signContent(params: Record<string, string>): string { return Object.keys(params).filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "").sort().map((k) => `${k}=${encode(params[k]!)}`).join("&"); }
function rsaSign(content: string, privateKey: string): string { const signer = createSign("RSA-SHA256"); signer.update(content); signer.end(); return signer.sign(pem(privateKey), "base64"); }
function rsaVerify(content: string, signature: string, publicKey: string): boolean { const verifier = createVerify("RSA-SHA256"); verifier.update(content); verifier.end(); return verifier.verify(pem(publicKey), signature, "base64"); }
function parseForm(input: string): Record<string, string> { const out: Record<string, string> = {}; for (const [k, v] of new URLSearchParams(input)) out[k] = v; return out; }
function alipayTimestamp(): string { const d = new Date(Date.now() + 8 * 60 * 60 * 1000); return d.toISOString().slice(0, 19).replace("T", " "); }

export class AlipayProvider implements PaymentProvider {
  readonly name = "alipay" as const;
  private readonly cfg = loadPaymentConfig().alipay;
  private readonly notifyBaseUrl = loadPaymentConfig().notifyBaseUrl;

  async createPayment(order: RechargeOrder): Promise<PaymentCreateResult> {
    if (!this.cfg.enabled || !this.cfg.appId || !this.cfg.privateKeyPem) throw new Error("Alipay is not configured");
    const params: Record<string, string> = {
      app_id: this.cfg.appId,
      method: "alipay.trade.precreate",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: alipayTimestamp(),
      version: "1.0",
      notify_url: `${this.notifyBaseUrl}/api/payments/alipay/notify`,
      biz_content: JSON.stringify({ out_trade_no: order.orderId, total_amount: (order.amountFen / 100).toFixed(2), subject: `TokenPanel ${order.tokenGrant.toString()} Tokens` }),
    };
    params.sign = rsaSign(signContent(params), this.cfg.privateKeyPem);
    const res = await fetch(`${this.cfg.gatewayUrl ?? "https://openapi.alipay.com"}/gateway.do`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" }, body: new URLSearchParams(params) });
    const json = await res.json() as { alipay_trade_precreate_response?: { code?: string; msg?: string; qr_code?: string } };
    const payload = json.alipay_trade_precreate_response;
    if (!res.ok || !payload?.qr_code || payload.code !== "10000") throw new Error(`Alipay create order failed: ${payload?.code ?? res.status} ${payload?.msg ?? ""}`);
    return { provider: this.name, orderId: order.orderId, qrCode: payload.qr_code, payUrl: payload.qr_code, raw: json };
  }

  async verifyNotification(input: { body: string; headers: Record<string, string | undefined>; query: Record<string, string | undefined> }): Promise<PaymentNotifyResult> {
    const data = parseForm(input.body);
    if (!this.cfg.alipayPublicKeyPem || !data.sign) return { verified: false, success: false };
    if (!rsaVerify(signContent(data), data.sign, this.cfg.alipayPublicKeyPem)) return { verified: false, success: false };
    const amount = Number(data.total_amount);
    return { verified: true, orderId: data.out_trade_no, providerTradeId: data.trade_no, paidAmountFen: Number.isFinite(amount) ? Math.round(amount * 100) : undefined, success: data.trade_status === "TRADE_SUCCESS" || data.trade_status === "TRADE_FINISHED", raw: data };
  }
}
