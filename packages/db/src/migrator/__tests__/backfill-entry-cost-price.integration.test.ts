import { test, describe, expect, afterAll } from "bun:test";
import { MongoClient, ObjectId } from "mongodb";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createMigrationDb } from "../migration-db.ts";
import { up } from "../../../migrations/pre/2026-07-29T20-44-40Z__backfill-entry-cost-price.ts";

/**
 * Integration coverage for the entry cost/price/margin backfill migration.
 * Requires a live MongoDB replica set. Uses a dedicated test database and drops
 * it on cleanup. Skipped when no reachable, authenticated MongoDB is available.
 */
function loadRootEnvIfPresent(): void {
  let dir = import.meta.dir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      const text = readFileSync(candidate, "utf8");
      for (const line of text.split("\n")) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!m) continue;
        const key = m[1]!;
        if (process.env[key] !== undefined) continue;
        process.env[key] = m[2]!.replace(/^["']|["']$/g, "");
      }
      break;
    }
    dir = dirname(dir);
  }
}
loadRootEnvIfPresent();

const TEST_DB = "tokenpanel_backfill_it";
const MONGO_USER = process.env.MONGO_USER;
const MONGO_PASS = process.env.MONGO_PASS;
const MONGO_HOST = process.env.MONGO_HOST ?? "localhost";
const MONGO_PORT = process.env.MONGO_PORT ?? "27017";

const uri = MONGO_USER
  ? `mongodb://${encodeURIComponent(MONGO_USER)}:${encodeURIComponent(MONGO_PASS ?? "")}@${MONGO_HOST}:${MONGO_PORT}/${TEST_DB}?authSource=admin&directConnection=true`
  : `mongodb://${MONGO_HOST}:${MONGO_PORT}/${TEST_DB}?directConnection=true`;

let client: MongoClient | null = null;
let connected = false;
{
  let c: MongoClient | null = null;
  try {
    c = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    await c.connect();
    const hello = await c.db("admin").command({ hello: 1 });
    if (!hello?.isWritablePrimary) throw new Error("not writable primary");
    await c.db(TEST_DB).command({ dbStats: 1 });
    await c.db(TEST_DB).dropDatabase().catch(() => {});
    client = c;
    connected = true;
    c = null;
  } catch {
    connected = false;
  } finally {
    if (c) await c.close().catch(() => {});
  }
}

afterAll(async () => {
  if (client) {
    await client.db(TEST_DB).dropDatabase().catch(() => {});
    await client.close().catch(() => {});
    client = null;
  }
});

async function runMigration(): Promise<void> {
  const db = client!.db(TEST_DB);
  await client!.withSession(async (session) => {
    const mdb = createMigrationDb(db, session);
    await up(mdb);
  });
}

const orgId = new ObjectId();
const providerId = new ObjectId();
const modelId = new ObjectId();
const catalogId = new ObjectId();

const CATALOG_COST = {
  inputMicrosPerMillion: 1_000_000,   // $1/M
  outputMicrosPerMillion: 2_000_000,  // $2/M
  cacheReadMicrosPerMillion: 100_000, // $0.10/M
};

const MODEL_PRICE = {
  inputMicrosPerMillion: 1_500_000,   // $1.50/M
  outputMicrosPerMillion: 3_000_000,  // $3/M
};

async function seed(): Promise<void> {
  const db = client!.db(TEST_DB);
  await db.collection("model_catalog").insertOne({
    _id: catalogId,
    organizationId: orgId,
    providerId,
    upstreamModelId: "gpt-4o",
    displayName: "GPT-4o",
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: {},
    modalities: { input: ["text"], output: ["text"] },
    cost: CATALOG_COST,
    raw: {},
    discoveredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.collection("models").insertOne({
    _id: modelId,
    organizationId: orgId,
    aliasId: "gpt-4o",
    displayName: "GPT-4o",
    entries: [
      {
        id: "e1",
        providerId,
        upstreamModelId: "gpt-4o",
        priority: 0,
        active: true,
        // no cost, no price — the state left by the old UI
      },
    ],
    reasoning: false,
    toolCall: false,
    attachment: false,
    limits: {},
    modalities: { input: ["text"], output: ["text"] },
    price: MODEL_PRICE,
    marginBps: 0,
    currency: "USD",
    active: true,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function getModel(): Promise<Record<string, any>> {
  return (await client!.db(TEST_DB).collection("models").findOne({ _id: modelId }))!;
}

describe.skipIf(!connected)("backfill-entry-cost-price", () => {
  test("backfills entry.cost from catalog, materializes price, derives margin", async () => {
    await seed();
    await runMigration();

    const model = await getModel();
    const entry = model.entries[0]!;

    // Cost copied from catalog.
    expect(entry.cost).toEqual(CATALOG_COST);
    // Price materialized from model.price.
    expect(entry.price).toEqual(MODEL_PRICE);
    // Margin derived: (1.5 − 1) / 1 × 10000 = 5000 bps.
    expect(model.marginBps).toBe(5000);
  });

  test("idempotent: re-run is a no-op", async () => {
    await runMigration();
    const model = await getModel();
    expect(model.entries[0]!.cost).toEqual(CATALOG_COST);
    expect(model.marginBps).toBe(5000);
  });

  test("skips entries that already have a cost", async () => {
    const db = client!.db(TEST_DB);
    const manualCost = { inputMicrosPerMillion: 999, outputMicrosPerMillion: 888 };
    await db.collection("models").updateOne(
      { _id: modelId },
      { $set: { "entries.0.cost": manualCost } },
    );
    await runMigration();
    const model = await getModel();
    // Manual cost preserved, not overwritten by catalog.
    expect(model.entries[0]!.cost).toEqual(manualCost);
  });

  test("does not overwrite a non-zero marginBps", async () => {
    const db = client!.db(TEST_DB);
    await db.collection("models").updateOne(
      { _id: modelId },
      { $set: { marginBps: 2000, "entries.0.cost": undefined } },
    );
    await runMigration();
    const model = await getModel();
    // Cost backfilled again (was cleared).
    expect(model.entries[0]!.cost).toEqual(CATALOG_COST);
    // Margin untouched — admin set it explicitly.
    expect(model.marginBps).toBe(2000);
  });

  test("no catalog match → entry left untouched", async () => {
    const db = client!.db(TEST_DB);
    const noMatchId = new ObjectId();
    await db.collection("models").insertOne({
      _id: noMatchId,
      organizationId: orgId,
      aliasId: "unknown-model",
      displayName: "Unknown",
      entries: [{ id: "e1", providerId, upstreamModelId: "no-such-model", priority: 0, active: true }],
      reasoning: false,
      toolCall: false,
      attachment: false,
      limits: {},
      modalities: { input: ["text"], output: ["text"] },
      price: MODEL_PRICE,
      marginBps: 0,
      currency: "USD",
      active: true,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await runMigration();
    const model = await db.collection("models").findOne({ _id: noMatchId });
    expect(model!.entries[0]!.cost).toBeUndefined();
    expect(model!.marginBps).toBe(0);
  });
});
