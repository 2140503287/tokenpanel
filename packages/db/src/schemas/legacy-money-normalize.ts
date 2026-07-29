/**
 * In-memory money normalize before schema decode.
 *
 * Two legacy layers, both resolved here so decoded docs always carry the
 * authoritative *Micros fields the schemas require:
 *
 *  1. *Minor → *Units (the earlier rename): prefer existing Units, else copy
 *     Minor; drop the Minor key. (Permanent no-op once post/ dropped Minor.)
 *  2. *Units → *Micros (the rescale): if Micros is absent, derive it as
 *     Units × 10^(6 − exponent) using the document's currency. Prefer existing
 *     Micros when present (new writer). Drop the Units key. (No-op once post/
 *     drops Units.)
 *
 * Used at every Mongo read boundary during the deploy windows. Pure /
 * side-effect free — safe to run on every document leaving Mongo. The currency
 * factor is a frozen snapshot (this module MUST NOT import live contracts).
 */

const MINOR_SCHEDULE_LEAVES = [
  ["inputUnitsPerMillion", "inputMinorPerMillion"],
  ["outputUnitsPerMillion", "outputMinorPerMillion"],
  ["reasoningUnitsPerMillion", "reasoningMinorPerMillion"],
  ["cacheReadUnitsPerMillion", "cacheReadMinorPerMillion"],
  ["cacheWriteUnitsPerMillion", "cacheWriteMinorPerMillion"],
  ["inputAudioUnitsPerMillion", "inputAudioMinorPerMillion"],
  ["outputAudioUnitsPerMillion", "outputAudioMinorPerMillion"],
] as const;

const MICRO_SCHEDULE_LEAVES = [
  ["inputMicrosPerMillion", "inputUnitsPerMillion"],
  ["outputMicrosPerMillion", "outputUnitsPerMillion"],
  ["reasoningMicrosPerMillion", "reasoningUnitsPerMillion"],
  ["cacheReadMicrosPerMillion", "cacheReadUnitsPerMillion"],
  ["cacheWriteMicrosPerMillion", "cacheWriteUnitsPerMillion"],
  ["inputAudioMicrosPerMillion", "inputAudioUnitsPerMillion"],
  ["outputAudioMicrosPerMillion", "outputAudioUnitsPerMillion"],
] as const;

const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF",
  "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
const FOUR_DECIMAL = new Set(["CLF", "UYW"]);

/** micros-per-minor factor for an ISO 4217 currency (unknown → 2dp ×10,000). */
function currencyFactor(currency: unknown): number {
  const c = typeof currency === "string" ? currency.toUpperCase() : "";
  if (ZERO_DECIMAL.has(c)) return 1_000_000;
  if (THREE_DECIMAL.has(c)) return 1_000;
  if (FOUR_DECIMAL.has(c)) return 100;
  return 10_000;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** Minor → Units rename: prefer Units, else copy Minor; always drop Minor. */
function promoteMinor(
  obj: Record<string, unknown>,
  unitsKey: string,
  minorKey: string,
  opts?: { preferMinor?: boolean },
): void {
  const units = obj[unitsKey];
  const minor = obj[minorKey];
  if (opts?.preferMinor) {
    // Balance hot path: old writers only update Minor during pre→swap.
    if (minor !== undefined) obj[unitsKey] = minor;
  } else if (units === undefined && minor !== undefined) {
    obj[unitsKey] = minor;
  }
  if (minorKey in obj) {
    delete obj[minorKey];
  }
}

/**
 * Units → Micros rescale: prefer Micros, else derive from Units × factor;
 * always drop Units. Signed values (adjustments) are scaled preserving sign.
 */
function promoteMicros(
  obj: Record<string, unknown>,
  microsKey: string,
  unitsKey: string,
  factor: number,
): void {
  const micros = obj[microsKey];
  const units = obj[unitsKey];
  if (!isInt(micros) && isInt(units)) {
    obj[microsKey] = units * factor;
  }
  if (unitsKey in obj) {
    delete obj[unitsKey];
  }
}

function normalizeScheduleMinor(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const o = { ...raw };
  for (const [u, m] of MINOR_SCHEDULE_LEAVES) {
    promoteMinor(o, u, m);
  }
  return o;
}

function normalizeScheduleMicros(raw: unknown, factor: number): unknown {
  if (!isPlainObject(raw)) return raw;
  const o = { ...raw };
  for (const [micros, units] of MICRO_SCHEDULE_LEAVES) {
    promoteMicros(o, micros, units, factor);
  }
  return o;
}

/** Full schedule normalize: minor→units then units→micros. */
function normalizeSchedule(raw: unknown, factor: number): unknown {
  return normalizeScheduleMicros(normalizeScheduleMinor(raw), factor);
}

function normalizeMoney(raw: unknown, factor: number): unknown {
  if (!isPlainObject(raw)) return raw;
  const o = { ...raw };
  promoteMinor(o, "amountUnits", "amountMinor");
  promoteMicros(o, "amountMicros", "amountUnits", factor);
  return o;
}

function normalizeBalance(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const o = { ...raw };
  promoteMinor(o, "amountUnits", "amountMinor", { preferMinor: true });
  promoteMinor(o, "reservedUnits", "reservedMinor", { preferMinor: true });
  const factor = currencyFactor(o.currency);
  promoteMicros(o, "amountMicros", "amountUnits", factor);
  promoteMicros(o, "reservedMicros", "reservedUnits", factor);
  return o;
}

function normalizeRateRules(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((rule) => {
    if (!isPlainObject(rule)) return rule;
    const r = { ...rule };
    if (r.dimension === "spend_minor") {
      r.dimension = "spend_units";
    }
    return r;
  });
}

/**
 * Deep-promote known money fields on a Mongo document (or agg row) so it
 * decodes under *Micros schemas. Returns a shallow-cloned tree; never mutates
 * the input.
 */
export function normalizeLegacyMoneyFields(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const doc = { ...value };

  if ("balance" in doc) {
    doc.balance = normalizeBalance(doc.balance);
  }

  // Top-level scalars (adjustments, budgets, usage). Currency is the doc's own.
  const factor = currencyFactor(doc.currency);
  promoteMinor(doc, "amountUnits", "amountMinor");
  promoteMicros(doc, "amountMicros", "amountUnits", factor);
  promoteMinor(doc, "costUnits", "costMinor");
  promoteMicros(doc, "costMicros", "costUnits", factor);
  promoteMinor(doc, "priceUnits", "priceMinor");
  promoteMicros(doc, "priceMicros", "priceUnits", factor);
  promoteMinor(doc, "totalCostUnits", "totalCostMinor");
  promoteMicros(doc, "totalCostMicros", "totalCostUnits", factor);
  promoteMinor(doc, "totalPriceUnits", "totalPriceMinor");
  promoteMicros(doc, "totalPriceMicros", "totalPriceUnits", factor);
  promoteMinor(doc, "totalUnits", "totalMinor");
  promoteMicros(doc, "totalMicros", "totalUnits", factor);

  if ("price" in doc) {
    // Plan money { amountMicros, currency } OR token schedule — both handled.
    const p = doc.price;
    if (isPlainObject(p) && ("currency" in p || "amountMinor" in p || "amountUnits" in p || "amountMicros" in p)) {
      doc.price = normalizeMoney(p, currencyFactor(p.currency));
    } else {
      doc.price = normalizeSchedule(p, factor);
    }
  }
  if ("cost" in doc) {
    doc.cost = normalizeSchedule(doc.cost, factor);
  }
  if ("includedCredit" in doc) {
    const c = doc.includedCredit;
    doc.includedCredit = normalizeMoney(
      c,
      isPlainObject(c) ? currencyFactor(c.currency) : factor,
    );
  }
  if ("startingBalance" in doc) {
    const s = doc.startingBalance;
    doc.startingBalance = normalizeMoney(
      s,
      isPlainObject(s) ? currencyFactor(s.currency) : factor,
    );
  }

  if (Array.isArray(doc.entries)) {
    doc.entries = doc.entries.map((entry) => {
      if (!isPlainObject(entry)) return entry;
      const e = { ...entry };
      if ("price" in e) e.price = normalizeSchedule(e.price, factor);
      if ("cost" in e) e.cost = normalizeSchedule(e.cost, factor);
      return e;
    });
  }

  if ("rateLimits" in doc) {
    doc.rateLimits = normalizeRateRules(doc.rateLimits);
  }
  if ("rules" in doc) {
    doc.rules = normalizeRateRules(doc.rules);
  }
  if (doc.dimension === "spend_minor") {
    doc.dimension = "spend_units";
  }

  // Settlement outbox context blob (carries its own currency).
  if (isPlainObject(doc.context)) {
    const ctx = { ...doc.context };
    const ctxFactor = currencyFactor(ctx.currency);
    promoteMinor(ctx, "priceUnits", "priceMinor");
    promoteMicros(ctx, "priceMicros", "priceUnits", ctxFactor);
    promoteMinor(ctx, "costUnits", "costMinor");
    promoteMicros(ctx, "costMicros", "costUnits", ctxFactor);
    promoteMinor(ctx, "reservedUnits", "reservedMinor");
    promoteMicros(ctx, "reservedMicros", "reservedUnits", ctxFactor);
    promoteMinor(ctx, "priceUnitsOverride", "priceMinorOverride");
    promoteMicros(ctx, "priceMicrosOverride", "priceUnitsOverride", ctxFactor);
    if ("priceSchedule" in ctx) {
      ctx.priceSchedule = normalizeSchedule(ctx.priceSchedule, ctxFactor);
    }
    if ("costSchedule" in ctx) {
      ctx.costSchedule = normalizeSchedule(ctx.costSchedule, ctxFactor);
    }
    doc.context = ctx;
  }

  return doc;
}
