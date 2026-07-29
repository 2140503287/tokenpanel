/**
 * Atomic balance reservation.
 *
 * Available = amountMicros - reservedMicros.
 * preFlight holds estimated spend in reservedMicros; settle releases the hold
 * and debits actual price. Release on upstream failure / cancel.
 *
 * Persistence: schema-decoding CustomersRepo only (task 14.2).
 * Primary API is Effect (run on ManagedRuntime / AppServices).
 */

import { Effect } from "effect";
import type { ClientSession, ObjectId } from "mongodb";
import { CustomersRepo } from "../infrastructure/mongo/repositories/customers.ts";
import type { MongoFailure } from "../infrastructure/mongo/try-mongo.ts";

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

export type ReserveResult =
  | { reserved: true; reservedMicros: number }
  | { reserved: false; reason: string };

/**
 * Atomic hold: available >= need → $inc reservedMicros.
 * Missing reservedMicros treated as 0 via $ifNull in $expr.
 */
export const reserveBalance = (params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  needMicros: number;
  currency: string;
  session?: ClientSession;
}): Effect.Effect<ReserveResult, MongoFailure, CustomersRepo> =>
  Effect.gen(function* () {
    const customers = yield* CustomersRepo;
    return yield* customers.reserveBalance({
      customerId: params.customerId,
      organizationId: params.organizationId,
      needMicros: params.needMicros,
      currency: params.currency,
      ...(params.session !== undefined ? { session: params.session } : {}),
    });
  });

/** Release a prior hold without debiting (upstream failure / cancel). */
export const releaseBalanceReservation = (params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  reservedMicros: number;
  session?: ClientSession;
}): Effect.Effect<boolean, MongoFailure, CustomersRepo> =>
  Effect.gen(function* () {
    const customers = yield* CustomersRepo;
    return yield* customers.releaseReserved({
      customerId: params.customerId,
      organizationId: params.organizationId,
      reservedMicros: params.reservedMicros,
      ...(params.session !== undefined ? { session: params.session } : {}),
    });
  });

/**
 * Settle after a hold: debit actual priceMicros and release the full reserved hold.
 * Filter requires reservedMicros >= reserved and amountMicros >= priceMicros.
 */
export const settleBalanceWithReservation = (params: {
  customerId: ObjectId;
  organizationId: ObjectId;
  priceMicros: number;
  reservedMicros: number;
  currency: string;
  session?: ClientSession;
}): Effect.Effect<boolean, MongoFailure, CustomersRepo> =>
  Effect.gen(function* () {
    const customers = yield* CustomersRepo;
    return yield* customers.settleWithReservation({
      customerId: params.customerId,
      organizationId: params.organizationId,
      priceMicros: params.priceMicros,
      reservedMicros: params.reservedMicros,
      currency: params.currency,
      ...(params.session !== undefined ? { session: params.session } : {}),
    });
  });
