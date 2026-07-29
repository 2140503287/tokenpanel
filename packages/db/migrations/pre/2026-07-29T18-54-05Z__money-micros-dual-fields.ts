import type { MigrationDb, SessionBoundCollection } from "../../src/migrator/migration-db.ts";

/**
 * Additive dual-field copy: *Units → *Micros (keep Units for old writers).
 *
 * Grain change: money moves from integer minor units (cents) to integer micros
 * (10⁻⁶ of the major unit). Unlike the earlier Minor→Units *rename* (factor 1),
 * this is a RESCALE: micros = units × 10^(6 − exponent), exponent = ISO 4217
 * decimal places of the document's currency. The factor is computed
 * per-document from the stored currency — a blind ×10,000 would corrupt
 * non-2dp currencies (JPY ×10⁶, KWD ×10³, CLF ×10²).
 *
 * Discourse deploy: runs from the NEW image while the OLD container still
 * serves. Old code keeps reading/writing *Units; new *Micros fields sit
 * alongside so after swap the new API can use *Micros immediately (dual-read
 * fallback converts Units on the fly). post/…units-to-micros.ts later promotes
 * Units→Micros where Micros is missing and drops Units (destructive — only
 * after new code is live).
 *
 * Spend caps: rate-limit `capValue` for dimension "spend_units" is scaled in
 * place here (rules on plans + customer_limits, factor from the owning org's
 * defaultCurrency). The dimension string is NOT renamed in pre — old code must
 * keep matching "spend_units". post/ renames spend_units → spend_micros and
 * scales the rolling counters (which pre leaves untouched: scaling a live
 * counter the old writer still increments would mix grains).
 *
 * Safe on re-run: only sets Micros when missing; cap scaling is guarded by a
 * per-rule marker so a re-run never double-scales.
 */
export const id = "2026-07-29T18-54-05Z__money-micros-dual-fields";
export const phase = "pre" as const;
// non-transactional: many collections of updateMany (16MB oplog cap + lock
// contention risk); each step is independently idempotent and resumable.
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

/**
 * ISO 4217 exponent sets (frozen snapshot — migrations MUST NOT import live
 * contracts). factor = 10^(6 − exponent): exp2 → 10,000 (USD/EUR/GBP…),
 * exp0 → 1,000,000 (JPY/KRW…), exp3 → 1,000 (KWD/BHD/OMR…), exp4 → 100 (CLF/UYW).
 */
const ZERO_DECIMAL = [
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF",
  "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
];
const THREE_DECIMAL = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];
const FOUR_DECIMAL = ["CLF", "UYW"];

/**
 * Aggregation expr: micros-per-minor factor for a currency field path.
 * Unknown/missing currency defaults to ×10,000 (ISO 2dp majority, matches the
 * admin display fallback). Server-side so the factor is read at write time.
 */
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

/** Copy scalar units → micros (× currency factor) when micros missing. */
async function copyScalar(
  coll: SessionBoundCollection,
  unitsPath: string,
  microsPath: string,
  currencyExpr: string | Record<string, unknown>,
): Promise<void> {
  await coll.updateMany(
    {
      [unitsPath]: { $exists: true },
      [microsPath]: { $exists: false },
    },
    [{ $set: { [microsPath]: { $multiply: [`$${unitsPath}`, factorExpr(currencyExpr)] } } }],
  );
}

async function copySchedulePrefix(
  coll: SessionBoundCollection,
  prefix: string,
  currencyExpr: string | Record<string, unknown>,
): Promise<void> {
  for (const [unitsLeaf, microsLeaf] of SCHEDULE_LEAVES) {
    await copyScalar(
      coll,
      `${prefix}.${unitsLeaf}`,
      `${prefix}.${microsLeaf}`,
      currencyExpr,
    );
  }
}

/**
 * Server-side additive copy of model entry[].price|cost schedule leaves. The
 * pipeline reads `entries` and the model-level `currency` at write time per
 * document, so a concurrent old-container write to `entries[i].price.*Units*`
 * between match and update is observed (no stale read-modify-write clobber).
 * For each leaf, set Micros = Units × factor only when Micros is missing;
 * entries without the Units leaf are left untouched (idempotent).
 */
async function copyModelEntrySchedules(
  coll: SessionBoundCollection,
  currencyExpr: string,
): Promise<void> {
  const factor = factorExpr(currencyExpr);
  for (const prefix of ["price", "cost"] as const) {
    for (const [unitsLeaf, microsLeaf] of SCHEDULE_LEAVES) {
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
                          {
                            $or: [
                              { $eq: [{ $type: `$$e.${prefix}` }, "missing"] },
                              { $eq: [`$$e.${prefix}`, null] },
                            ],
                          },
                          "$$REMOVE",
                          {
                            $mergeObjects: [
                              `$$e.${prefix}`,
                              {
                                [microsLeaf]: {
                                  $ifNull: [
                                    `$$e.${prefix}.${microsLeaf}`,
                                    {
                                      $cond: [
                                        { $eq: [{ $type: `$$e.${prefix}.${unitsLeaf}` }, "missing"] },
                                        "$$REMOVE",
                                        { $multiply: [`$$e.${prefix}.${unitsLeaf}`, factor] },
                                      ],
                                    },
                                  ],
                                },
                              },
                            ],
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
 * Scale rate-limit rule `capValue` (× org-currency factor) for spend rules,
 * tagging each scaled rule with `_microsScaled: true` so re-runs skip it.
 * Dimension stays "spend_units" in pre (old code must keep matching). The
 * factor comes from the owning document's currency path (plan price.currency;
 * customer_limits resolves org defaultCurrency before calling).
 */
async function scaleSpendCaps(
  coll: SessionBoundCollection,
  field: "rateLimits" | "rules",
  currencyExpr: string,
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
                {
                  $and: [
                    { $eq: ["$$r.dimension", "spend_units"] },
                    { $ne: ["$$r._microsScaled", true] },
                  ],
                },
                {
                  $mergeObjects: [
                    "$$r",
                    {
                      capValue: { $multiply: ["$$r.capValue", factorExpr(currencyExpr)] },
                      _microsScaled: true,
                    },
                  ],
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
 * customer_limits has no currency of its own — spend caps are in the org's
 * defaultCurrency. Group the org→factor mapping, then scale each cohort.
 */
async function scaleCustomerLimitCaps(
  mdb: MigrationDb,
): Promise<void> {
  const orgs = await mdb
    .collection("organizations")
    .aggregate<{ _id: unknown; currency: string }>([
      { $project: { currency: { $ifNull: ["$defaultCurrency", "USD"] } } },
    ])
    .toArray();

  const byFactor = new Map<number, unknown[]>();
  for (const o of orgs) {
    // Mirror factorExpr on the client to bucket org ids.
    const c = o.currency;
    const f = ZERO_DECIMAL.includes(c)
      ? 1_000_000
      : THREE_DECIMAL.includes(c)
        ? 1_000
        : FOUR_DECIMAL.includes(c)
          ? 100
          : 10_000;
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
                  {
                    $and: [
                      { $eq: ["$$r.dimension", "spend_units"] },
                      { $ne: ["$$r._microsScaled", true] },
                    ],
                  },
                  {
                    $mergeObjects: [
                      "$$r",
                      { capValue: { $multiply: ["$$r.capValue", factor] }, _microsScaled: true },
                    ],
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

export async function up(mdb: MigrationDb): Promise<void> {
  // customers.balance (currency: balance.currency)
  await copyScalar(
    mdb.collection("customers"),
    "balance.amountUnits",
    "balance.amountMicros",
    "$balance.currency",
  );
  await copyScalar(
    mdb.collection("customers"),
    "balance.reservedUnits",
    "balance.reservedMicros",
    "$balance.currency",
  );

  // balance_adjustments, budgets (top-level currency)
  await copyScalar(
    mdb.collection("balance_adjustments"),
    "amountUnits",
    "amountMicros",
    "$currency",
  );
  await copyScalar(mdb.collection("budgets"), "amountUnits", "amountMicros", "$currency");

  // plans (price.currency; includedCredit currency mirrors price)
  await copyScalar(
    mdb.collection("subscription_plans"),
    "price.amountUnits",
    "price.amountMicros",
    "$price.currency",
  );
  await copyScalar(
    mdb.collection("subscription_plans"),
    "includedCredit.amountUnits",
    "includedCredit.amountMicros",
    "$price.currency",
  );

  // usage (top-level currency)
  await copyScalar(mdb.collection("usage_records"), "costUnits", "costMicros", "$currency");
  await copyScalar(mdb.collection("usage_records"), "priceUnits", "priceMicros", "$currency");

  // models root schedules + entry overrides (model-level currency)
  await copySchedulePrefix(mdb.collection("models"), "price", "$currency");
  await copySchedulePrefix(mdb.collection("models"), "cost", "$currency");
  await copyModelEntrySchedules(mdb.collection("models"), "$currency");

  // catalog cost schedules — models.dev cost is always USD (2dp → ×10,000)
  await copySchedulePrefix(mdb.collection("model_catalog"), "cost", { $literal: "USD" });

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
    }
  }

  // spend caps (dimension stays spend_units; post/ renames + scales counters)
  await scaleSpendCaps(mdb.collection("subscription_plans"), "rateLimits", "$price.currency");
  await scaleCustomerLimitCaps(mdb);
}

export async function down(mdb: MigrationDb): Promise<void> {
  // Additive-only reverse would $unset Micros — forbidden in spirit of down for
  // dual-field pre; leave Micros in place (harmless extra fields). Cap scaling
  // is also left as-is (reversing it would need the marker, and a down here is
  // not expected once the new image is deployed).
  void mdb;
}
