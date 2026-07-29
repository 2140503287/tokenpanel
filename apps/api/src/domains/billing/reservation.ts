/**
 * Pure balance reservation decisions (task 9.1 / 9.3).
 * I/O lives in workflow.ts; these are deterministic guards.
 */

export type BalanceSnapshot = {
  amountMicros: number;
  reservedMicros: number;
  currency: string;
};

/** Available prepaid cash after holds. */
export function availableMicros(balance: {
  amountMicros: number;
  reservedMicros?: number | null;
}): number {
  const reserved = Math.max(0, balance.reservedMicros ?? 0);
  return Math.max(0, balance.amountMicros - reserved);
}

/** Pure decision: would a hold of `needMicros` succeed given this snapshot? */
export function wouldReserveSucceed(
  balance: BalanceSnapshot,
  needMicros: number,
  currency: string,
):
  | { ok: true }
  | { ok: false; reason: "currency_mismatch" | "insufficient_available" } {
  if (needMicros <= 0) return { ok: true };
  if (balance.currency !== currency) {
    return { ok: false, reason: "currency_mismatch" };
  }
  if (availableMicros(balance) < needMicros) {
    return { ok: false, reason: "insufficient_available" };
  }
  return { ok: true };
}
