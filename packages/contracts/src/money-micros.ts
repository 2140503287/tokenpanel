/**
 * Micros money codec (Phase 0 of the units → micros migration).
 *
 * Internal money grain = one-millionth of the major currency unit (micro-dollar
 * for USD, micro-yen for JPY). `1 major = 1,000,000 micros`. Settlement and
 * storage stay integer-exact; rounding is deferred to the display boundary.
 *
 * Why micro: JS `number` is exact only to ±2⁵³ ≈ ±9×10¹⁵. Worst realistic case
 * (200k tokens × $1,000/M = 10⁹ micros/M → 2×10¹⁴) stays under the bound. Finer
 * (nano) would overflow into float territory. Micro is the finest exact grain.
 *
 * All conversions here are string/integer based — NO float multiply — so there
 * is no `0.15 * 1e6 = 149999.99…` class of bug.
 *
 * Browser-safe: no env, I/O, Node, Mongo, or UI. Migrations MUST NOT import
 * this module (keep frozen snapshots).
 */
import { Schema } from "effect";
import { SafeInt } from "./effect/primitives.ts";
import { withParseApi } from "./parse.ts";

/** Micros per major currency unit (fixed 10⁻⁶ grain, currency-independent). */
export const MICROS_PER_MAJOR = 1_000_000;

/** Maximum fractional decimal places representable in micros (sub-micro = error). */
export const MICROS_FRACTIONAL_DIGITS = 6;

/**
 * Non-negative integer micros (never floats). 1 micro = 10⁻⁶ of the major unit.
 * Storage/computation unit only — admins never see "micros"; they type decimal
 * major units which are parsed via {@link parseMajorToMicros}.
 */
export const MoneyMicros = SafeInt.pipe(Schema.nonNegative());

/** Parse-API wrapped MoneyMicros (`.parse` / `.safeParse`) for callers/tests. */
export const moneyMicrosSchema = withParseApi(MoneyMicros);

export type MoneyMicros = Schema.Schema.Type<typeof MoneyMicros>;

/**
 * Minor-unit → micros multiplier for an ISO 4217 exponent.
 * `1 minor = 10^(6 − exponent) micros`:
 *  - USD/EUR/GBP (exp 2) → ×10,000
 *  - JPY/KRW (exp 0)     → ×1,000,000
 *  - KWD/BHD/OMR (exp 3) → ×1,000
 */
export function microsPerMinor(exponent: number): number {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new Error(`microsPerMinor: exponent out of range [0,6]: ${exponent}`);
  }
  return 10 ** (MICROS_FRACTIONAL_DIGITS - exponent);
}

/** Convert an integer minor-unit amount to micros for a currency exponent. */
export function minorToMicros(minor: number, exponent: number): number {
  if (!Number.isInteger(minor)) {
    throw new Error(`minorToMicros: non-integer minor amount: ${minor}`);
  }
  return minor * microsPerMinor(exponent);
}

export interface ParseMicrosOptions {
  /** Permit a leading `-` (signed money such as adjustments). Default: reject. */
  readonly allowNegative?: boolean | undefined;
}

/**
 * Parse a decimal major-unit string to integer micros via string manipulation
 * (no float). `"0.15"` → `150000`, `"3"` → `3000000`, `"0.005"` → `5000`.
 *
 * Rejects: empty/non-numeric input, more than 6 fractional places (sub-micro
 * precision is unrepresentable), and negatives unless `allowNegative`.
 */
export function parseMajorToMicros(
  input: string,
  options: ParseMicrosOptions = {},
): number {
  const s = input.trim();
  if (s.length === 0) {
    throw new Error("parseMajorToMicros: empty input");
  }

  let rest = s;
  let negative = false;
  if (rest[0] === "-" || rest[0] === "+") {
    negative = rest[0] === "-";
    rest = rest.slice(1);
  }
  if (negative && !options.allowNegative) {
    throw new Error(`parseMajorToMicros: negative not allowed: ${input}`);
  }
  if (rest.length === 0) {
    throw new Error(`parseMajorToMicros: missing digits: ${input}`);
  }

  const dot = rest.indexOf(".");
  let intPart: string;
  let fracPart: string;
  if (dot === -1) {
    intPart = rest;
    fracPart = "";
  } else {
    intPart = rest.slice(0, dot);
    fracPart = rest.slice(dot + 1);
    if (fracPart.indexOf(".") !== -1) {
      throw new Error(`parseMajorToMicros: multiple decimal points: ${input}`);
    }
  }
  if (intPart.length === 0) intPart = "0"; // allow ".5"
  if (!/^[0-9]+$/.test(intPart) || (fracPart.length > 0 && !/^[0-9]+$/.test(fracPart))) {
    throw new Error(`parseMajorToMicros: non-numeric input: ${input}`);
  }
  if (fracPart.length > MICROS_FRACTIONAL_DIGITS) {
    throw new Error(
      `parseMajorToMicros: more than ${MICROS_FRACTIONAL_DIGITS} fractional places: ${input}`,
    );
  }

  const fracPadded = fracPart.padEnd(MICROS_FRACTIONAL_DIGITS, "0");
  // Strip leading zeros so parseInt never sees an oversized digit string.
  const intTrim = intPart.replace(/^0+(?=[0-9])/, "");
  const whole = Number.parseInt(intTrim, 10) * MICROS_PER_MAJOR;
  const frac = Number.parseInt(fracPadded, 10);
  const value = whole + frac;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`parseMajorToMicros: result exceeds safe integer: ${input}`);
  }
  return negative ? -value : value;
}

/**
 * Format integer micros as a decimal major-unit string (integer division +
 * remainder, no float). Trailing fractional zeros are trimmed:
 * `150000` → `"0.15"`, `300` → `"0.0003"`, `3000000` → `"3"`.
 *
 * `exponent` is accepted for symmetry with the minor-unit display path but does
 * not affect the value: micros are a fixed 10⁻⁶ grain for every currency.
 */
export function formatMicrosToMajor(micros: number, _exponent = 2): string {
  if (!Number.isSafeInteger(micros)) {
    throw new Error(`formatMicrosToMajor: non-safe-integer micros: ${micros}`);
  }
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / MICROS_PER_MAJOR);
  const frac = abs % MICROS_PER_MAJOR;
  if (frac === 0) return `${sign}${whole}`;
  const fracStr = String(frac)
    .padStart(MICROS_FRACTIONAL_DIGITS, "0")
    .replace(/0+$/, "");
  return `${sign}${whole}.${fracStr}`;
}
