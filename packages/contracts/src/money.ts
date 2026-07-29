/**
 * Browser-safe money / currency product contracts.
 *
 * Policy version: 2026-07-15
 * Money is always integer micros (amountMicros, 10⁻⁶ of the major unit) +
 * ISO 4217 currency — never floats.
 * Migrations MUST NOT import this module — keep frozen snapshots.
 *
 * Effect Schema live under `@tokenpanel/contracts/effect`.
 *
 * The MoneyUnits/moneyUnitsSchema exports below are retained for optional
 * legacy dual-field schema slots (ISO 4217 exponent scale: 1 unit =
 * 10^(-exp) of the major unit). New code uses MoneyMicros (money-micros.ts).
 */
import {
  CurrencyCode,
  MoneyUnits,
  Money,
} from "./effect/primitives.ts";
import { withParseApi } from "./parse.ts";

/** Tokens priced per this many units (standard LLM pricing denominator). */
export const TOKENS_PER_MILLION_COUNT = 1_000_000;

export type { CurrencyCode, MoneyUnits, Money };

export const currencyCodeSchema = withParseApi(CurrencyCode);
export const moneyUnitsSchema = withParseApi(MoneyUnits);
export const moneySchema = withParseApi(Money);
