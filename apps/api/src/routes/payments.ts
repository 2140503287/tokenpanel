import { Hono } from "hono";
import { Effect } from "effect";
import type { PublicAuthVariables } from "../middleware/public-auth.ts";
import { requirePublicPrincipal } from "../middleware/public-auth.ts";
import { resolveMongo } from "../infrastructure/mongo/resolve-db.ts";
import { getAppRuntime } from "../runtime/app-runtime.ts";
import { adjustCustomerBalance } from "../domains/customers/operations.ts";
import { WeChatNativeProvider } from "../billing/wechat-provider.ts";
import { AlipayProvider } from "../billing/alipay-provider.ts";
import type { PaymentProvider, RechargeOrder } from "../billing/payment-provider.ts";
import { DEFAULT_RECHARGE_PACKAGES } from "../billing/recharge-packages.ts";

const app = new Hono<{ Variables: PublicAuthVariables }>();
const providers: Record<string, PaymentProvider> = { wechat: new WeChatNativeProvider(), alipay: new AlipayProvider() };
function orderCollection(db: Awaited<ReturnType<typeof resolveMongo>>["rawDb"]) { return db.collection("payment_orders"); }
function packageById(id: string) { return DEFAULT_RECHARGE_PACKAGES.find((p) => p.id === id); }

app.get("/packages", (c) => c.json({ items: DEFAULT_RECHARGE_PACKAGES.map((p) => ({ ...p, tokenGrant: p.tokenGrant.toString() })) }));

app.post("/orders", requirePublicPrincipal, async (c) => {
  const principal = c.get("principal");
  if (principal.kind !== "customer") return c.json({ error: "customer_auth_required" }, 403);
  const body = await c.req.json().catch(() => null) as { packageId?: string; provider?: string } | null;
  const pkg = body?.packageId ? packageById(body.packageId) : undefined;
  const provider = body?.provider ? providers[body.provider] : undefined;
  if (!pkg || !provider) return c.json({ error: "invalid_package_or_provider" }, 400);
  const orderId = `TP${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`.slice(0, 32);
  const order: RechargeOrder = { orderId, customerId: principal.customer._id.toHexString(), packageId: pkg.id, amountFen: pkg.amountFen, tokenGrant: pkg.tokenGrant, notifyUrl: "" };
  const { rawDb } = await resolveMongo();
  const orders = orderCollection(rawDb);
  await orders.createIndex({ orderId: 1 }, { unique: true });
  await orders.insertOne({ orderId, organizationId: principal.orgId, customerId: principal.customer._id, packageId: pkg.id, amountFen: pkg.amountFen, tokenGrant: pkg.tokenGrant.toString(), provider: provider.name, status: "PENDING", createdAt: new Date() });
  try {
    const payment = await provider.createPayment(order);
    await orders.updateOne({ orderId }, { $set: { qrCode: payment.qrCode ?? null, payUrl: payment.payUrl ?? null, providerRaw: payment.raw ?? null, updatedAt: new Date() } });
    return c.json({ orderId, provider: provider.name, amountFen: pkg.amountFen, tokenGrant: pkg.tokenGrant.toString(), qrCode: payment.qrCode, payUrl: payment.payUrl });
  } catch (error) {
    await orders.updateOne({ orderId }, { $set: { status: "CREATE_FAILED", error: error instanceof Error ? error.message : String(error), updatedAt: new Date() } });
    return c.json({ error: "payment_create_failed" }, 502);
  }
});

async function settle(providerName: "wechat" | "alipay", body: string, headers: Record<string, string | undefined>) {
  const provider = providers[providerName];
  const result = await provider.verifyNotification({ body, headers, query: {} });
  if (!result.verified || !result.orderId || !result.success || result.paidAmountFen === undefined) return { ok: false, status: 400 as const };
  const { rawDb } = await resolveMongo();
  const orders = orderCollection(rawDb);
  const order = await orders.findOne({ orderId: result.orderId, provider: providerName });
  if (!order) return { ok: false, status: 404 as const };
  if (order.status === "PAID") return { ok: true, status: 200 as const };
  if (result.paidAmountFen !== order.amountFen) return { ok: false, status: 400 as const };
  const claimed = await orders.findOneAndUpdate({ orderId: order.orderId, status: "PENDING" }, { $set: { status: "CREDITING", providerTradeId: result.providerTradeId ?? null, paidAt: new Date(), updatedAt: new Date() } }, { returnDocument: "after" });
  if (!claimed) { const latest = await orders.findOne({ orderId: order.orderId }); return { ok: latest?.status === "PAID", status: 200 as const }; }
  try {
    await getAppRuntime().runPromise(adjustCustomerBalance({ organizationId: order.organizationId.toHexString(), customerId: order.customerId.toHexString(), amountMicros: order.amountFen * 10_000, reason: "topup", note: `Payment ${providerName} ${order.orderId}: ${order.tokenGrant} tokens` }).pipe(Effect.asVoid));
    await orders.updateOne({ orderId: order.orderId }, { $set: { status: "PAID", creditedTokenGrant: order.tokenGrant, updatedAt: new Date() } });
    return { ok: true, status: 200 as const };
  } catch (error) {
    await orders.updateOne({ orderId: order.orderId }, { $set: { status: "CREDIT_FAILED", creditError: error instanceof Error ? error.message : String(error), updatedAt: new Date() } });
    return { ok: false, status: 500 as const };
  }
}

app.post("/wechat/notify", async (c) => {
  const body = await c.req.text();
  const result = await settle("wechat", body, { "wechatpay-signature": c.req.header("Wechatpay-Signature"), "wechatpay-timestamp": c.req.header("Wechatpay-Timestamp"), "wechatpay-nonce": c.req.header("Wechatpay-Nonce"), "wechatpay-serial": c.req.header("Wechatpay-Serial") });
  return result.ok ? c.json({ code: "SUCCESS", message: "成功" }) : c.json({ code: "FAIL", message: "处理失败" }, result.status);
});
app.post("/alipay/notify", async (c) => { const result = await settle("alipay", await c.req.text(), {}); return result.ok ? c.text("success") : c.text("fail", result.status); });

app.get("/orders/:orderId", requirePublicPrincipal, async (c) => {
  const principal = c.get("principal");
  if (principal.kind !== "customer") return c.json({ error: "customer_auth_required" }, 403);
  const { rawDb } = await resolveMongo();
  const order = await orderCollection(rawDb).findOne({ orderId: c.req.param("orderId"), customerId: principal.customer._id }, { projection: { _id: 0, providerRaw: 0, creditError: 0 } });
  if (!order) return c.json({ error: "not_found" }, 404);
  return c.json(order);
});

export default app;
