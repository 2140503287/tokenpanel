/**
 * Dual-path balance field helpers for the Units → Micros rescale window.
 *
 * Grain: micros (10⁻⁶ of the major unit) are authoritative. Legacy keys
 * `amountUnits`/`reservedUnits` (minor units) and the older
 * `amountMinor`/`reservedMinor` may still be present until post/ drops them.
 *
 * Effective value prefers Micros; when absent it converts the freshest legacy
 * key (Units, else Minor) by the currency factor 10^(6 − exponent). The factor
 * is read server-side from `balance.currency`, so a blind ×10,000 never corrupts
 * non-2dp currencies (JPY ×10⁶, KWD ×10³, CLF ×10²).
 *
 * Writes set Micros and dual-write Units (integer-divided back to minor units)
 * so an old reader that only knows Units sees an approximately-correct balance
 * during the swap window; the Minor key is dropped.
 */

/** Frozen ISO 4217 exponent sets (MUST NOT import live contracts here). */
const ZERO_DECIMAL = [
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF",
  "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
];
const THREE_DECIMAL = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];
const FOUR_DECIMAL = ["CLF", "UYW"];

/** Aggregation expr: micros-per-minor factor for a currency field path. */
export function balanceFactorExpr(
  currencyPath = "$balance.currency",
): Record<string, unknown> {
  return {
    $switch: {
      branches: [
        { case: { $in: [currencyPath, ZERO_DECIMAL] }, then: 1_000_000 },
        { case: { $in: [currencyPath, THREE_DECIMAL] }, then: 1_000 },
        { case: { $in: [currencyPath, FOUR_DECIMAL] }, then: 100 },
      ],
      default: 10_000,
    },
  };
}

/** Effective amount in micros: Micros ?? Units×factor ?? Minor×factor ?? 0. */
export function effectiveAmountExpr(): Record<string, unknown> {
  const factor = balanceFactorExpr();
  return {
    $ifNull: [
      "$balance.amountMicros",
      {
        $ifNull: [
          { $multiply: ["$balance.amountUnits", factor] },
          {
            $ifNull: [
              { $multiply: ["$balance.amountMinor", factor] },
              0,
            ],
          },
        ],
      },
    ],
  };
}

/** Effective reserved hold in micros. */
export function effectiveReservedExpr(): Record<string, unknown> {
  const factor = balanceFactorExpr();
  return {
    $ifNull: [
      "$balance.reservedMicros",
      {
        $ifNull: [
          { $multiply: ["$balance.reservedUnits", factor] },
          {
            $ifNull: [
              { $multiply: ["$balance.reservedMinor", factor] },
              0,
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Pipeline stages: add `amountDelta` / `reservedDelta` (micros) to the
 * effective balances, write Micros, and dual-write the minor-unit Units key
 * (rounded down) for old readers. Legacy Minor keys are dropped.
 */
export function balanceDualIncPipeline(opts: {
  amountDelta?: number;
  reservedDelta?: number;
  set?: Record<string, unknown>;
}): Record<string, unknown>[] {
  const amountDelta = opts.amountDelta ?? 0;
  const reservedDelta = opts.reservedDelta ?? 0;
  const setDoc: Record<string, unknown> = { ...(opts.set ?? {}) };
  const factor = balanceFactorExpr();

  if (amountDelta !== 0) {
    const next = { $add: [effectiveAmountExpr(), amountDelta] };
    setDoc["balance.amountMicros"] = next;
    setDoc["balance.amountUnits"] = { $floor: { $divide: [next, factor] } };
    setDoc["balance.amountMinor"] = "$$REMOVE";
  }
  if (reservedDelta !== 0) {
    const next = { $add: [effectiveReservedExpr(), reservedDelta] };
    setDoc["balance.reservedMicros"] = next;
    setDoc["balance.reservedUnits"] = { $floor: { $divide: [next, factor] } };
    setDoc["balance.reservedMinor"] = "$$REMOVE";
  }

  return [{ $set: setDoc }];
}

/** $expr: effective available (amount - reserved) >= need (micros). */
export function availableGteExpr(need: number): Record<string, unknown> {
  return {
    $gte: [
      {
        $subtract: [effectiveAmountExpr(), effectiveReservedExpr()],
      },
      need,
    ],
  };
}

/** $expr: effective amount >= price (micros). */
export function amountGteExpr(price: number): Record<string, unknown> {
  return {
    $gte: [effectiveAmountExpr(), price],
  };
}

/** $expr: effective reserved >= hold (micros). */
export function reservedGteExpr(reserved: number): Record<string, unknown> {
  return {
    $gte: [effectiveReservedExpr(), reserved],
  };
}
