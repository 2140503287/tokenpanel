import { test, describe, expect, afterAll } from "bun:test";
import { MongoClient, ObjectId } from "mongodb";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createMigrationDb } from "../migration-db.ts";
import { up as preUp } from "../../../migrations/pre/2026-07-29T18-54-05Z__money-micros-dual-fields.ts";
import { up as postUp } from "../../../migrations/post/2026-07-29T19-00-00Z__money-units-to-micros.ts";

/**
 * Integration coverage for the units → micros money migration (pre + post).
 * Verifies currency-aware conversion (USD ×10⁴, JPY ×10⁶, KWD ×10³), spend-cap
 * scaling that leaves tokens/requests caps untouched, and idempotent re-runs.
 *
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

const TEST_DB = "tokenpanel_micros_it";
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

async function runPre(): Promise<void> {
  const db = client!.db(TEST_DB);
  await client!.withSession(async (session) => {
    const mdb = createMigrationDb(db, session);
    await preUp(mdb);
  });
}

async function runPost(): Promise<void> {
  const db = client!.db(TEST_DB);
  await client!.withSession(async (session) => {
    const mdb = createMigrationDb(db, session);
    await postUp(mdb);
  });
}

describe.skipIf(!connected)("money units → micros migration", () => {
  test("pre: currency-aware dual-field copy (USD/JPY/KWD)", async () => {
    const db = client!.db(TEST_DB);
    const customers = db.collection("customers");
    await customers.deleteMany({});
    await customers.insertMany([
      { _id: new ObjectId(), balance: { amountUnits: 1, reservedUnits: 2, currency: "USD" } },
      { _id: new ObjectId(), balance: { amountUnits: 1, reservedUnits: 2, currency: "JPY" } },
      { _id: new ObjectId(), balance: { amountUnits: 1, reservedUnits: 2, currency: "KWD" } },
    ]);

    await runPre();

    const docs = await customers.find({}).toArray();
    const byCur = new Map(docs.map((d) => [d.balance.currency, d.balance]));
    expect(byCur.get("USD")?.amountMicros).toBe(10_000); // ×10,000
    expect(byCur.get("USD")?.reservedMicros).toBe(20_000);
    expect(byCur.get("JPY")?.amountMicros).toBe(1_000_000); // ×1,000,000
    expect(byCur.get("KWD")?.amountMicros).toBe(1_000); // ×1,000
    // Units preserved for old readers during the window.
    expect(byCur.get("USD")?.amountUnits).toBe(1);
  });

  test("pre: spend cap scaled + marker, tokens/requests caps untouched", async () => {
    const db = client!.db(TEST_DB);
    const plans = db.collection("subscription_plans");
    await plans.deleteMany({});
    await plans.insertOne({
      _id: new ObjectId(),
      price: { amountUnits: 5, currency: "USD" },
      rateLimits: [
        { id: "spend", dimension: "spend_units", capValue: 100, windowSeconds: 3600 },
        { id: "tok", dimension: "tokens", capValue: 1000, windowSeconds: 3600 },
        { id: "req", dimension: "requests", capValue: 50, windowSeconds: 3600 },
      ],
    });

    await runPre();

    const plan = await plans.findOne({});
    const rules = new Map<string, Record<string, unknown>>(
      plan!.rateLimits.map((r: Record<string, unknown>) => [r.id as string, r] as [string, Record<string, unknown>]),
    );
    expect(rules.get("spend")?.capValue).toBe(1_000_000); // 100 × 10,000
    expect(rules.get("spend")?._microsScaled).toBe(true);
    expect(rules.get("spend")?.dimension).toBe("spend_units"); // not renamed in pre
    expect(rules.get("tok")?.capValue).toBe(1000); // untouched
    expect(rules.get("req")?.capValue).toBe(50); // untouched
    expect(rules.get("tok")?._microsScaled).toBeUndefined();
  });

  test("pre: idempotent re-run does not double-scale caps or duplicate micros", async () => {
    const db = client!.db(TEST_DB);
    const plans = db.collection("subscription_plans");
    await plans.deleteMany({});
    await plans.insertOne({
      _id: new ObjectId(),
      price: { amountUnits: 5, currency: "USD" },
      rateLimits: [{ id: "spend", dimension: "spend_units", capValue: 100, windowSeconds: 3600 }],
    });

    await runPre();
    await runPre(); // second run must be a no-op

    const plan = await plans.findOne({});
    expect(plan!.rateLimits[0].capValue).toBe(1_000_000); // not 10^10
  });

  test("post: promotes units→micros, drops units, renames spend dim", async () => {
    const db = client!.db(TEST_DB);
    const customers = db.collection("customers");
    const plans = db.collection("subscription_plans");
    const counters = db.collection("rate_limit_counters");
    const orgs = db.collection("organizations");
    await customers.deleteMany({});
    await plans.deleteMany({});
    await counters.deleteMany({});
    await orgs.deleteMany({});

    const orgId = new ObjectId();
    await orgs.insertOne({ _id: orgId, defaultCurrency: "USD" });
    await customers.insertOne({
      _id: new ObjectId(),
      balance: { amountUnits: 3, currency: "USD" },
    });
    await plans.insertOne({
      _id: new ObjectId(),
      price: { amountUnits: 5, currency: "USD" },
      rateLimits: [{ id: "spend", dimension: "spend_units", capValue: 100, windowSeconds: 3600 }],
    });
    await counters.insertOne({
      _id: new ObjectId(),
      organizationId: orgId,
      customerId: new ObjectId(),
      dimension: "spend_units",
      windowSeconds: 3600,
      bucketStart: new Date(),
      count: 7,
    });

    await runPre();
    await runPost();

    const cust = await customers.findOne({});
    expect(cust!.balance.amountMicros).toBe(30_000);
    expect(cust!.balance.amountUnits).toBeUndefined();

    const plan = await plans.findOne({});
    expect(plan!.price.amountMicros).toBe(50_000);
    expect(plan!.price.amountUnits).toBeUndefined();
    expect(plan!.rateLimits[0].dimension).toBe("spend_micros");
    expect(plan!.rateLimits[0].capValue).toBe(1_000_000);
    expect(plan!.rateLimits[0]._microsScaled).toBeUndefined();

    const counter = await counters.findOne({});
    expect(counter!.dimension).toBe("spend_micros");
    expect(counter!.count).toBe(70_000); // 7 × 10,000
  });

  test("post: idempotent re-run does not re-scale counters", async () => {
    const db = client!.db(TEST_DB);
    const counters = db.collection("rate_limit_counters");
    const orgs = db.collection("organizations");
    await counters.deleteMany({});
    await orgs.deleteMany({});

    const orgId = new ObjectId();
    await orgs.insertOne({ _id: orgId, defaultCurrency: "USD" });
    await counters.insertOne({
      _id: new ObjectId(),
      organizationId: orgId,
      customerId: new ObjectId(),
      dimension: "spend_units",
      windowSeconds: 3600,
      bucketStart: new Date(),
      count: 7,
    });

    await runPre();
    await runPost();
    await runPost(); // second run: dimension already spend_micros → no match

    const counter = await counters.findOne({});
    expect(counter!.dimension).toBe("spend_micros");
    expect(counter!.count).toBe(70_000); // not 7×10^8
  });
});
