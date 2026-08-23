import { useMemo, useState } from "react";
import { Copy, Check } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const PACKAGES = [
  { amount: 1, tokens: 1_000_000 },
  { amount: 5, tokens: 5_000_000 },
  { amount: 10, tokens: 10_000_000 },
  { amount: 20, tokens: 20_000_000 },
  { amount: 50, tokens: 50_000_000 },
  { amount: 100, tokens: 100_000_000 },
] as const;

type Method = "alipay" | "wechat";

function formatTokens(value: number): string {
  return `${new Intl.NumberFormat("zh-CN").format(value)} Token`;
}

export default function PaymentPage(): React.ReactElement {
  const [method, setMethod] = useState<Method>("alipay");
  const [amount, setAmount] = useState(10);
  const [copied, setCopied] = useState(false);
  const selected = useMemo(() => PACKAGES.find((item) => item.amount === amount) ?? PACKAGES[2], [amount]);

  async function copyPaymentNote(): Promise<void> {
    await navigator.clipboard.writeText(`TokenPanel充值 ¥${selected.amount} / ${formatTokens(selected.tokens)}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-6">
      <PageHeader title="充值 Token" description="选择充值套餐后扫码付款。静态收款码支付需要管理员确认到账后发放额度。" />

      <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
        <Card className="p-6">
          <div className="mb-5 text-sm font-medium">选择充值套餐</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {PACKAGES.map((item) => (
              <button
                key={item.amount}
                type="button"
                onClick={() => setAmount(item.amount)}
                className={`rounded-xl border p-4 text-left transition ${
                  selected.amount === item.amount ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <div className="text-lg font-semibold">¥{item.amount}</div>
                <div className="mt-1 text-xs text-muted-foreground">{formatTokens(item.tokens)}</div>
              </button>
            ))}
          </div>

          <div className="mt-6 rounded-xl bg-muted/40 p-4 text-sm">
            <div className="font-medium">本次充值</div>
            <div className="mt-2 text-2xl font-bold">¥{selected.amount}</div>
            <div className="text-muted-foreground">到账 {formatTokens(selected.tokens)}</div>
          </div>

          <Button className="mt-4" variant="outline" onClick={() => void copyPaymentNote()}>
            {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
            {copied ? "已复制" : "复制充值信息"}
          </Button>
        </Card>

        <Card className="p-6">
          <div className="mb-4 flex gap-2">
            <Button variant={method === "alipay" ? "default" : "outline"} onClick={() => setMethod("alipay")} className="flex-1">
              支付宝
            </Button>
            <Button variant={method === "wechat" ? "default" : "outline"} onClick={() => setMethod("wechat")} className="flex-1">
              微信支付
            </Button>
          </div>

          <div className="rounded-xl border bg-white p-4">
            <img
              src={method === "alipay" ? "/payment/alipay.svg" : "/payment/wechat.svg"}
              alt={method === "alipay" ? "支付宝收款二维码" : "微信支付收款二维码"}
              className="mx-auto aspect-square w-full max-w-[320px] object-contain"
            />
          </div>

          <div className="mt-4 text-center text-sm text-muted-foreground">
            请扫码支付 ¥{selected.amount}。付款完成后保留支付凭证，并按照站点的充值确认流程提交。
          </div>
        </Card>
      </div>
    </div>
  );
}
