export type RechargeOrder = {
  orderId: string;
  customerId: string;
  packageId: string;
  amountFen: number;
  tokenGrant: bigint;
  notifyUrl: string;
};

export type PaymentCreateResult = {
  provider: "wechat" | "alipay";
  orderId: string;
  payUrl?: string;
  qrCode?: string;
  raw?: unknown;
};

export type PaymentNotifyResult = {
  verified: boolean;
  orderId?: string;
  providerTradeId?: string;
  paidAmountFen?: number;
  success: boolean;
  raw?: unknown;
};

export interface PaymentProvider {
  readonly name: "wechat" | "alipay";
  createPayment(order: RechargeOrder): Promise<PaymentCreateResult>;
  verifyNotification(input: {
    body: string;
    headers: Record<string, string | undefined>;
    query: Record<string, string | undefined>;
  }): Promise<PaymentNotifyResult>;
}

export function assertPaidAmount(expectedFen: number, actualFen: number): void {
  if (!Number.isInteger(actualFen) || actualFen !== expectedFen) {
    throw new Error(`payment amount mismatch: expected ${expectedFen}, got ${actualFen}`);
  }
}
