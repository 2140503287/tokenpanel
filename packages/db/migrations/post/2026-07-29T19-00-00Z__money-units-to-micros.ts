import type { MigrationDb, SessionBoundCollection } from "../../src/migrator/migration-db.ts";

/**
 * Destructive cleanup after the micros dual-field pre migration + new code swap.
 *
 * Runs from the LIVE new container (old container stopped), so nothing writes
 * legacy *Units anymore. This phase:
 *   1. Promotes *Units → *Micros where Micros is missing (Units × currency
 *      factor), then $unsets the *Units keys. Micros wins when present.
 *   2. Renames rate-limit dimension spend_units → spend_micros on rules +
 *      counters, scaling any residual unscaled spend cap/counter values by the
 *      currency factor (guarded by the `_microsScaled` marker pre set, so this
 *      is idempotent and never double-scales).
 *
 * Grain: micros = units × 10^(6 − exponent), exponent from the document's
 * currency (frozen ISO snapshot — MUST NOT import live contracts). A blind
 * ×10,000 would corrupt non-2dp currencies (JPY ×10⁶, KWD ×10³, CLF ×10²).
 *
 * Safe only after new code is live. Safe on re-run: promote only where Micros
 * is missing; scaling guarded by marker; rename matches the old label only.
 */
export const id = "2026-07-29T19-00-00Z__money-units-to-micros";
export const phase = "post" as const;
// non-transactional: many collections of updateMany/$unset (16MB oplog cap +
// lock contention risk); each step is independently idempotent and resumable.
export const transactional = false as const;

const SCHEDULE_LEAVES = [
  ["inputUnitsPerMillion", "inputMicrosPerMillion"],
  ["outputUnitsPerMillion", "outputMicrosPerMillion"],
  ["reasoningUnitsPerMillion", "reasoningMicrosPerMillion"],
  ["cacheReadUnitsPerMillion", "cacheReadMicrosPerMillion"],
  ["cacheWriteUnitsPerMillion", "cacheWriteMicrosPerMillion"],
  ["inputAudioUnitsPerMillion", "inputAudioMicrosPerMillion"],
  ["outputAudioUnitsPerMillion", "outputAudioMicrosPerMillion"],
] as const;

const ZERO_DECIMAL = [
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF",
  "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
];
const THREE_DECIMAL = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];
const FOUR_DECIMAL = ["CLF", "UYW"];

/** Aggregation expr: micros-per-minor factor for a currency expression. */
function factorExpr(currencyExpr: string | Record<string, unknown>): Record<string, unknown> {
  return {
    $switch: {
      branches: [
        { case: { $in: [currencyExpr, ZERO_DECIMAL] }, then: 1_000_000 },
        { case: { $in: [currencyExpr, THREE_DECIMAL] }, then: 1_000 },
        { case: { $in: [currencyExpr, FOUR_DECIMAL] }, then: 100 },
      ],
      default: 10_000,
    },
  };
}

function clientFactor(currency: string): number {
  if (ZERO_DECIMAL.includes(currency)) return 1_000_000;
  if (THREE_DECIMAL.includes(currency)) return 1_000;
  if (FOUR_DECIMAL.includes(currency)) return 100;
  return 10_000;
}

/**
 * Promote Units → Micros where Micros is missing (Micros wins when present —
 * it is the new writer's truth), then drop Units. Two server-side passes so a
 * concurrent write between them cannot clobber.
 */
async function promoteAndDropScalar(
  coll: SessionBoundCollection,
  unitsPath: string,
  microsPath: string,
  currencyExpr: string | Record<string, unknown>,
): Promise<void> {
  await coll.updateMany(
    { [unitsPath]: { $exists: true }, [microsPath]: { $exists: false } },
    [{ $set: { [microsPath]: { $multiply: [`$${unitsPath}`, factorExpr(currencyExpr)] } } }],
  );
  await coll.updateMany(
    { [unitsPath]: { $exists: true } },
    { $unset: { [unitsPath]: "" } },
  );
}

async function promoteAndDropSchedulePrefix(
  coll: SessionBoundCollection,
  prefix: string,
  currencyExpr: string | Record<string, unknown>,
): Promise<void> {
  for (const [unitsLeaf, microsLeaf] of SCHEDULE_LEAVES) {
    await promoteAndDropScalar(
      coll,
      `${prefix}.${unitsLeaf}`,
      `${prefix}.${microsLeaf}`,
      currencyExpr,
    );
  }
}

/**
 * Server-side promote+drop of model entry[].price|cost schedule leaves. Reads
 * `entries` + model `currency` at write time per document (no stale clobber).
 */
async function cleanupModelEntrySchedules(
  coll: SessionBoundCollection,
  currencyExpr: string | Record<string, unknown>,
): Promise<void> {
  const factor = factorExpr(currencyExpr);
  for (const prefix of ["price", "cost"] as const) {
    for (const [unitsLeaf, microsLeaf] of SCHEDULE_LEAVES) {
      // Promote where micros missing.
      await coll.updateMany(
        {
          entries: {
            $elemMatch: {
              [`${prefix}.${unitsLeaf}`]: { $exists: true },
              [`${prefix}.${microsLeaf}`]: { $exists: false },
            },
          },
        },
        [{
          $set: {
            entries: {
              $map: {
                input: { $ifNull: ["$entries", []] },
                as: "e",
                in: {
                  $mergeObjects: [
                    "$$e",
                    {
                      [prefix]: {
                        $cond: [
                          { $eq: [{ $type: `$$e.${prefix}.${unitsLeaf}` }, "missing"] },
                          `$$e.${prefix}`,
                          {
                            $setField: {
                              field: microsLeaf,
                              input: `$$e.${prefix}`,
                              value: { $multiply: [`$$e.${prefix}.${unitsLeaf}`, factor] },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        }],
      );
      // Drop the units leaf everywhere it remains.
      await coll.updateMany(
        { entries: { $elemMatch: { [`${prefix}.${unitsLeaf}`]: { $exists: true } } } },
        [{
          $set: {
            entries: {
              $map: {
                input: { $ifNull: ["$entries", []] },
                as: "e",
                in: {
                  $mergeObjects: [
                    "$$e",
                    {
                      [prefix]: {
                        $cond: [
                          { $eq: [{ $type: `$$e.${prefix}` }, "missing"] },
                          "$$REMOVE",
                          {
                            $unsetField: {
                              field: unitsLeaf,
                              input: `$$e.${prefix}`,
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        }],
      );
    }
  }
}

/**
 * Spend rules: scale any residual unscaled capValue (guarded by _microsScaled),
 * rename spend_units → spend_micros, drop the marker. Idempotent: already-
 * renamed (spend_micros) rules are untouched; already-scaled rules skip the ×.
 */
async function finalizeSpendRules(
  coll: SessionBoundCollection,
  field: "rateLimits" | "rules",
  currencyExpr: string | Record<string, unknown>,
): Promise<void> {
  await coll.updateMany(
    { [`${field}.dimension`]: "spend_units" },
    [{
      $set: {
        [field]: {
          $map: {
            input: { $ifNull: [`$${field}`, []] },
            as: "r",
            in: {
              $cond: [
                { $eq: ["$$r.dimension", "spend_units"] },
                {
                  $unsetField: {
                    field: "_microsScaled",
                    input: {
                      $mergeObjects: [
                        "$$r",
                        {
                          dimension: "spend_micros",
                          capValue: {
                            $cond: [
                              { $eq: ["$$r._microsScaled", true] },
                              "$$r.capValue",
                              { $multiply: ["$$r.capValue", factorExpr(currencyExpr)] },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
                "$$r",
              ],
            },
          },
        },
      },
    }],
  );
}

/**
 * customer_limits has no currency — resolve the factor from the owning org's
 * defaultCurrency, then finalize each cohort's spend rules.
 */
async function finalizeCustomerLimitRules(mdb: MigrationDb): Promise<void> {
  const orgs = await mdb
    .collection("organizations")
    .aggregate<{ _id: unknown; currency: string }>([
      { $project: { currency: { $ifNull: ["$defaultCurrency", "USD"] } } },
    ])
    .toArray();

  const byFactor = new Map<number, unknown[]>();
  for (const o of orgs) {
    const f = clientFactor(o.currency);
    const list = byFactor.get(f) ?? [];
    list.push(o._id);
    byFactor.set(f, list);
  }

  const coll = mdb.collection("customer_limits");
  for (const [factor, orgIds] of byFactor) {
    await coll.updateMany(
      { organizationId: { $in: orgIds }, "rules.dimension": "spend_units" },
      [{
        $set: {
          rules: {
            $map: {
              input: { $ifNull: ["$rules", []] },
              as: "r",
              in: {
                $cond: [
                  { $eq: ["$$r.dimension", "spend_units"] },
                  {
                    $unsetField: {
                      field: "_microsScaled",
                      input: {
                        $mergeObjects: [
                          "$$r",
                          {
                            dimension: "spend_micros",
                            capValue: {
                              $cond: [
                                { $eq: ["$$r._microsScaled", true] },
                                "$$r.capValue",
                                { $multiply: ["$$r.capValue", factor] },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  },
                  "$$r",
                ],
              },
            },
          },
        },
      }],
    );
  }
}

/**
 * Rolling spend counters: scale `count` by the org factor (counters carry no
 * currency), then rename spend_units → spend_micros.
 *
 * Safety: this only touches `dimension: "spend_units"` buckets — the legacy
 * cents-valued counters written by the old release. New code normalizes its
 * write dimension to spend_micros at the counter write boundary
 * (usage.ts bulkUpsertCounters), so it never deposits micros into a
 * spend_units bucket; there is therefore no micros value here to over-scale.
 * The two labels are read as one stream (findWindowCounters $in-matches both),
 * so the window stays consistent while the legacy buckets age out.
 */
async function finalizeCounters(mdb: MigrationDb): Promise<void> {
  const orgs = await mdb
    .collection("organizations")
    .aggregate<{ _id: unknown; currency: string }>([
      { $project: { currency: { $ifNull: ["$defaultCurrency", "USD"] } } },
    ])
    .toArray();

  const byFactor = new Map<number, unknown[]>();
  for (const o of orgs) {
    const f = clientFactor(o.currency);
    const list = byFactor.get(f) ?? [];
    list.push(o._id);
    byFactor.set(f, list);
  }

  const coll = mdb.collection("rate_limit_counters");
  for (const [factor, orgIds] of byFactor) {
    await coll.updateMany(
      { organizationId: { $in: orgIds }, dimension: "spend_units" },
      [{ $set: { dimension: "spend_micros", count: { $multiply: [{ $ifNull: ["$count", 0] }, factor] } } }],
    );
  }
}

export async function up(mdb: MigrationDb): Promise<void> {
  // customers.balance
  await promoteAndDropScalar(
    mdb.collection("customers"),
    "balance.amountUnits",
    "balance.amountMicros",
    "$balance.currency",
  );
  await promoteAndDropScalar(
    mdb.collection("customers"),
    "balance.reservedUnits",
    "balance.reservedMicros",
    "$balance.currency",
  );

  // balance_adjustments, budgets
  await promoteAndDropScalar(
    mdb.collection("balance_adjustments"),
    "amountUnits",
    "amountMicros",
    "$currency",
  );
  await promoteAndDropScalar(mdb.collection("budgets"), "amountUnits", "amountMicros", "$currency");

  // plans
  await promoteAndDropScalar(
    mdb.collection("subscription_plans"),
    "price.amountUnits",
    "price.amountMicros",
    "$price.currency",
  );
  await promoteAndDropScalar(
    mdb.collection("subscription_plans"),
    "includedCredit.amountUnits",
    "includedCredit.amountMicros",
    "$price.currency",
  );

  // usage
  await promoteAndDropScalar(mdb.collection("usage_records"), "costUnits", "costMicros", "$currency");
  await promoteAndDropScalar(mdb.collection("usage_records"), "priceUnits", "priceMicros", "$currency");

  // models root schedules + entry overrides
  await promoteAndDropSchedulePrefix(mdb.collection("models"), "price", "$currency");
  await promoteAndDropSchedulePrefix(mdb.collection("models"), "cost", "$currency");
  await cleanupModelEntrySchedules(mdb.collection("models"), "$currency");

  // catalog cost schedules — models.dev cost is always USD (2dp → ×10,000)
  await promoteAndDropSchedulePrefix(mdb.collection("model_catalog"), "cost", { $literal: "USD" });

  // settlement_outbox.context (context.currency)
  const outbox = mdb.collection("settlement_outbox");
  const top: Array<[string, string]> = [
    ["priceUnits", "priceMicros"],
    ["costUnits", "costMicros"],
    ["reservedUnits", "reservedMicros"],
    ["priceUnitsOverride", "priceMicrosOverride"],
  ];
  for (const [units, micros] of top) {
    await outbox.updateMany(
      { [`context.${units}`]: { $exists: true }, [`context.${micros}`]: { $exists: false } },
      [{
        $set: {
          [`context.${micros}`]: {
            $multiply: [`$context.${units}`, factorExpr("$context.currency")],
          },
        },
      }],
    );
    await outbox.updateMany(
      { [`context.${units}`]: { $exists: true } },
      { $unset: { [`context.${units}`]: "" } },
    );
  }
  for (const scheduleKey of ["priceSchedule", "costSchedule"] as const) {
    for (const [unitsLeaf, microsLeaf] of SCHEDULE_LEAVES) {
      await outbox.updateMany(
        {
          [`context.${scheduleKey}.${unitsLeaf}`]: { $exists: true },
          [`context.${scheduleKey}.${microsLeaf}`]: { $exists: false },
        },
        [{
          $set: {
            [`context.${scheduleKey}.${microsLeaf}`]: {
              $multiply: [
                `$context.${scheduleKey}.${unitsLeaf}`,
                factorExpr("$context.currency"),
              ],
            },
          },
        }],
      );
      await outbox.updateMany(
        { [`context.${scheduleKey}.${unitsLeaf}`]: { $exists: true } },
        { $unset: { [`context.${scheduleKey}.${unitsLeaf}`]: "" } },
      );
    }
  }

  // spend caps + dimension rename (plans use price.currency; limits use org)
  await finalizeSpendRules(mdb.collection("subscription_plans"), "rateLimits", "$price.currency");
  await finalizeCustomerLimitRules(mdb);
  await finalizeCounters(mdb);
}

export async function down(mdb: MigrationDb): Promise<void> {
  // Best-effort: recreate Units from Micros (integer-divided back to minor
  // units; cannot restore sub-minor precision lost in the rescale) and rename
  // spend_micros → spend_units. Does not reverse counter scaling exactly.
  const pairs: Array<[string, string, string, string]> = [
    ["customers", "balance.amountMicros", "balance.amountUnits", "$balance.currency"],
    ["customers", "balance.reservedMicros", "balance.reservedUnits", "$balance.currency"],
    ["balance_adjustments", "amountMicros", "amountUnits", "$currency"],
    ["budgets", "amountMicros", "amountUnits", "$currency"],
    ["subscription_plans", "price.amountMicros", "price.amountUnits", "$price.currency"],
    ["subscription_plans", "includedCredit.amountMicros", "includedCredit.amountUnits", "$price.currency"],
    ["usage_records", "costMicros", "costUnits", "$currency"],
    ["usage_records", "priceMicros", "priceUnits", "$currency"],
  ];
  for (const [name, micros, units, currencyExpr] of pairs) {
    const coll = mdb.collection(name);
    await coll.updateMany(
      { [micros]: { $exists: true }, [units]: { $exists: false } },
      [{ $set: { [units]: { $floor: { $divide: [`$${micros}`, factorExpr(currencyExpr)] } } } }],
    );
  }
  await mdb.collection("subscription_plans").updateMany(
    { "rateLimits.dimension": "spend_micros" },
    { $set: { "rateLimits.$[r].dimension": "spend_units" } },
    { arrayFilters: [{ "r.dimension": "spend_micros" }] },
  );
  await mdb.collection("customer_limits").updateMany(
    { "rules.dimension": "spend_micros" },
    { $set: { "rules.$[r].dimension": "spend_units" } },
    { arrayFilters: [{ "r.dimension": "spend_micros" }] },
  );
  await mdb.collection("rate_limit_counters").updateMany(
    { dimension: "spend_micros" },
    { $set: { dimension: "spend_units" } },
  );
}
