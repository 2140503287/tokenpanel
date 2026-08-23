/** Default prepaid Token packages. Amounts are RMB yuan; token grants are integer counts. */
export const DEFAULT_RECHARGE_PACKAGES = [
  { id: "rmb-1", amountFen: 100, tokenGrant: 1_000_000n },
  { id: "rmb-5", amountFen: 500, tokenGrant: 5_000_000n },
  { id: "rmb-10", amountFen: 1_000, tokenGrant: 10_000_000n },
  { id: "rmb-20", amountFen: 2_000, tokenGrant: 20_000_000n },
  { id: "rmb-50", amountFen: 5_000, tokenGrant: 50_000_000n },
  { id: "rmb-100", amountFen: 10_000, tokenGrant: 100_000_000n },
] as const;

export type RechargePackage = (typeof DEFAULT_RECHARGE_PACKAGES)[number];

export function getRechargePackage(id: string): RechargePackage | undefined {
  return DEFAULT_RECHARGE_PACKAGES.find((item) => item.id === id);
}
