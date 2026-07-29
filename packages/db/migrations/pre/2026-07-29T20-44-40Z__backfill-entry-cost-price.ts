import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Backfill entry.cost (and optionally entry.price + marginBps) on models whose
 * entries were created before the cost UI existed.
 *
 * Source of truth for wholesale cost: model_catalog.cost. The preceding pre
 * migration (money-micros-dual-fields) additively adds cost.*MicrosPerMillion
 * beside the existing *UnitsPerMillion, so by the time this migration runs
 * the catalog carries micros leaves.
 *
 * For each entry missing `cost`:
 *   1. Look up model_catalog by (providerId, upstreamModelId).
 *   2. If the catalog doc has a cost schedule, copy it onto the entry.
 *   3. If the entry also lacks an explicit `price`, materialize model.price
 *      onto it (removes reliance on the entry.price ?? model.price fallback).
 *   4. If model.marginBps is still 0 (the old default) and we now have both a
 *      cost and a price, derive the implied margin from the input rates:
 *        marginBps = round((priceIn − costIn) / costIn × 10 000)
 *      Clamped to ≥ 0. This records the markup the org was already earning.
 *
 * Idempotent: only touches entries where `cost` is absent. Re-running is a
 * no-op once every entry has a cost.
 *
 * Non-transactional: each model update is independent and idempotent (it only
 * touches entries lacking cost), so a crash mid-run resumes cleanly on
 * re-run. Running outside a transaction also avoids MongoDB's 60-second /
 * 16 MB transaction limits on large catalogs.
 *
 * Additive-only ($set on new/optional fields); safe for pre/ phase.
 * down() is a no-op — we cannot distinguish backfilled costs from manually
 * entered ones after the fact.
 */
export const id = "2026-07-29T20-44-40Z__backfill-entry-cost-price";
export const phase = "pre" as const;
export const transactional = false as const;

/** Schedule leaves we copy from catalog → entry (all optional except in/out). */
const SCHEDULE_KEYS = [
  "inputMicrosPerMillion",
  "outputMicrosPerMillion",
  "reasoningMicrosPerMillion",
  "cacheReadMicrosPerMillion",
  "cacheWriteMicrosPerMillion",
  "inputAudioMicrosPerMillion",
  "outputAudioMicrosPerMillion",
] as const;

type Schedule = Partial<Record<(typeof SCHEDULE_KEYS)[number], number>>;

function hasCost(schedule: Schedule | undefined): boolean {
  if (!schedule) return false;
  return (
    (schedule.inputMicrosPerMillion ?? 0) > 0 ||
    (schedule.outputMicrosPerMillion ?? 0) > 0
  );
}

/** Derive margin bps from input rates; returns undefined when not computable. */
function deriveMarginBps(
  price: Schedule | undefined,
  cost: Schedule | undefined,
): number | undefined {
  const pIn = price?.inputMicrosPerMillion ?? 0;
  const cIn = cost?.inputMicrosPerMillion ?? 0;
  if (cIn <= 0 || pIn <= 0) return undefined;
  return Math.max(0, Math.round(((pIn - cIn) / cIn) * 10_000));
}

export async function up(mdb: MigrationDb): Promise<void> {
  const models = mdb.collection("models");
  const catalog = mdb.collection("model_catalog");

  // Load all models (admin-configured; small collection).
  const docs = await models.find({}).toArray();

  for (const model of docs) {
    const entries = model.entries as Array<Record<string, unknown>> | undefined;
    if (!entries || entries.length === 0) continue;

    const modelPrice = model.price as Schedule | undefined;
    const currentMargin = (model.marginBps as number | undefined) ?? 0;

    // Collect per-entry patches, keyed by the entry's stable `id` (not its
    // array position). Applied via arrayFilters so a concurrent admin edit
    // that reorders/adds/removes entries between this read and the write
    // still lands each patch on the intended entry instead of a shifted index.
    const setFields: Record<string, unknown> = {};
    const arrayFilters: Array<Record<string, unknown>> = [];
    let anyCostBackfilled = false;
    let backfilledCost: Schedule | undefined;

    for (const entry of entries) {
      const existingCost = entry.cost as Schedule | undefined;
      if (hasCost(existingCost)) continue; // already has cost — skip

      // Look up catalog by (providerId, upstreamModelId).
      const cat = await catalog.findOne({
        providerId: entry.providerId,
        upstreamModelId: entry.upstreamModelId,
      });
      const catCost = cat?.cost as Schedule | undefined;
      if (!hasCost(catCost)) continue; // no catalog cost available

      const entryId = entry.id as string;
      const tag = `e${arrayFilters.length}`;
      arrayFilters.push({ [`${tag}.id`]: entryId });

      // Copy catalog cost onto the entry.
      const costPatch: Schedule = {};
      for (const key of SCHEDULE_KEYS) {
        const v = catCost![key];
        if (v !== undefined) costPatch[key] = v;
      }
      setFields[`entries.$[${tag}].cost`] = costPatch;
      anyCostBackfilled = true;
      // Remember the first backfilled cost for margin derivation.
      if (!backfilledCost) backfilledCost = costPatch;

      // Materialize price if the entry lacks an explicit one.
      const existingPrice = entry.price as Schedule | undefined;
      if (!existingPrice && modelPrice) {
        setFields[`entries.$[${tag}].price`] = { ...modelPrice };
      }
    }

    // Derive marginBps if it's still the old default (0) and we have data.
    if (anyCostBackfilled && currentMargin === 0 && backfilledCost) {
      const derived = deriveMarginBps(modelPrice, backfilledCost);
      if (derived !== undefined && derived > 0) {
        setFields.marginBps = derived;
      }
    }

    if (Object.keys(setFields).length > 0) {
      await models.updateOne(
        { _id: model._id },
        { $set: setFields },
        { arrayFilters },
      );
    }
  }
}

export async function down(_mdb: MigrationDb): Promise<void> {
  // No-op: cannot distinguish backfilled costs from manually entered ones.
}
