# Money Precision Migration: `units` (cents) → `micros` (10⁻⁶ of major unit)

**Status:** Implemented — pre + post migrations written, schemas/settlement/admin
swapped to micros, codec + formatter + integration tests green. Migration files:
`pre/2026-07-29T18-54-05Z__money-micros-dual-fields.ts`,
`post/2026-07-29T19-00-00Z__money-units-to-micros.ts`.
**Scope:** DB schema, settlement, balance/reservation, rate limits, admin UI.

**Implementation notes (deviations from the draft, all deliberate):**
- **Rescale ≠ rename.** The earlier Minor→Units migration was factor-1, so its
  `{$in:[spend_units,spend_minor]}` counter dual-read could safely *sum* both
  labels. units→micros is ×10⁴, so summing mixed grains would corrupt totals.
  Instead: pre scales `capValue` on spend **rules** in place (tagged
  `_microsScaled`) but keeps dimension `spend_units`; new code matches
  `{$in:[spend_units,spend_micros]}` (values already same-grain); post renames
  the dimension and scales the live **counters** (which pre leaves untouched —
  scaling a counter the old writer still increments would mix grains).
- **Currency gaps.** `model_catalog` (always USD), `customer_limits` and
  `rate_limit_counters` (no currency field — factor resolved by joining the
  owning org's `defaultCurrency`) do not carry a per-doc currency. The draft's
  "every money collection stores its currency" held only for the balance/plan/
  usage/adjustment/budget/outbox collections.
- **Catalog self-heals.** `model_catalog.cost` is written from models.dev in
  USD units; the read-path normalizer converts units→micros (×10⁴) on decode,
  and post/ converts the stored field, so no write-path change was required.
- **Dual-write on balance updates.** New writers set `amountMicros` (exact) and
  dual-write `amountUnits` (floored back to minor units) so an old reader sees
  an approximately-correct balance during the swap window; `amountMinor` is
  dropped. Effective reads prefer Micros, else convert Units/Minor by factor.
- **Admin input = decimal major units** (model price/cost, plan price/credit,
  spend caps, balance adjustments) parsed via the string-based codec; display
  uses `formatMicros` (adaptive precision, sub-cent never shows `$0.00`).

---

## 1. Problem

Money is stored as **integer minor units** (cents for USD; 1 unit = 10⁻² of the
major unit). Every request charge is rounded **up to a whole cent**
(`Math.ceil`). For cheap models this is wildly inaccurate:

- A request whose true cost is **$0.0003** = 0.03¢ → `ceil` → **1¢ = $0.01** → a
  **33× overcharge**.

There are two distinct granularity gaps:

1. **Per-request result** — the exact charge (e.g. 0.03¢) can't be represented in
   whole cents, so it snaps up.
2. **Authorable rate** — the admin inputs an **integer** count of minor units per
   million tokens, so sub-cent rates (e.g. $0.005/M) can't even be entered.

## 2. Design decisions

### 2.1 Grain: micros (10⁻⁶ of the major unit)

Internal unit = **one-millionth of the major currency unit** (micro-dollar for
USD, micro-yen for JPY). `1 major = 1,000,000 micros`.

- The pricing formula is unchanged: `tokens × rate / 1,000,000`. Only `rate` is
  now in **micros per million tokens**, so the result is an exact integer of
  micros for realistic requests.
- Rounding is deferred to the **display** boundary; settlement stays integer-exact.

**Why micro and not finer:** JS `number` (double) is exact only to ±2⁵³ ≈ ±9×10¹⁵.
Worst realistic case — 200k tokens × $1,000/M (= 10⁹ micros/M) = 2×10¹⁴ — is
safely under the bound. Going to nano (10⁻⁹) would overflow into float territory
and reintroduce the errors we're eliminating. **Micro is the finest grain that
stays exact in JS integers.** (Finer would require `BigInt`; unnecessary here.)

### 2.2 Naming: `micros`

New field suffix `*Micros`. Standard term (Stripe uses "micros"), self-documenting.

| Concept | Old | New |
|---|---|---|
| Rate | `inputUnitsPerMillion` (minor/M) | `inputMicrosPerMillion` (micros/M) |
| Balance | `balance.amountUnits` | `balance.amountMicros` |
| Reserved | `balance.reservedUnits` | `balance.reservedMicros` |
| Usage | `costUnits` / `priceUnits` | `costMicros` / `priceMicros` |
| Plan price | `price.amountUnits` | `price.amountMicros` |
| Plan credit | `includedCredit.amountUnits` | `includedCredit.amountMicros` |
| Adjustment | `amountUnits` | `amountMicros` |
| Budget | `amountUnits` | `amountMicros` |
| Limit cap | `capValue` (dim `spend_units`) | `capValue` (dim `spend_micros`) |

The admin **never sees "micros"** — they type **decimal major units** (`0.15` =
$0.15/M), parsed to micros internally. "Micros" is the hidden storage/computation
unit only.

### 2.3 Admin input: decimal major units (Option B)

Admin types dollars per million tokens as a decimal (`0.15`, `3.00`, `0.005`).
Matches how providers publish prices. Internally stored as integer micros →
no float-money bugs. (This is how Stripe works: integers inside, decimals at the
edges.)

### 2.4 Currency-aware conversion factor

`1 minor unit = 10^(6 − exponent) micros`, exponent = ISO 4217 decimal places:

| Currency | exponent | minor → micros factor |
|---|---:|---:|
| USD / EUR / GBP (2 dp) | 2 | **×10,000** |
| JPY / KRW (0 dp) | 0 | **×1,000,000** |
| KWD / BHD / OMR (3 dp) | 3 | **×1,000** |

The migration **must** compute the factor per-document from the stored `currency`
— a blind ×10,000 would corrupt non-2dp currencies. Every money collection also
stores its `currency` (verified), so the aggregation can do this server-side.

## 3. Exactness argument

- All operands are integers (token counts, micros rates). Multiplication/division
  are exact; the only quantization is the final display rounding.
- Decimal input is parsed via **string manipulation, not float multiply**:
  `"0.15"` → split on `.` → pad fractional part to 6 places → `150000`. No float
  involved, so no `0.15 * 1e6 = 149999.99…` class of bug.
- Display: integer micros → decimal string (integer division + remainder), again
  no float.

## 4. Decimal ↔ micro codec (Phase 0)

Pure functions, fully unit-tested:

```
parseMajorToMicros("0.15", exponent=2)  → 150000      // exact
parseMajorToMicros("3", exponent=2)     → 3000000
parseMajorToMicros("0.005", exponent=2) → 5000
parseMajorToMicros("", ...)             → error
parseMajorToMicros("1.2345678", exp=2)  → error (more than 6 fractional places)
parseMajorToMicros("-0.1", ...)         → error (negative) unless signed allowed

formatMicrosToMajor(150000, exponent=2) → "0.15"
formatMicrosToMajor(300, exponent=2)    → "0.0003"
```

- Rejects non-numeric, negative (where unsigned expected), and >6 fractional
  digits (sub-micro precision can't be represented).
- `formatMoney` gains adaptive precision so sub-cent amounts render (e.g.
  `$0.0003 USD`), not `$0.00`.

## 5. Field inventory (from the existing `minor→units` migration)

Collections + paths holding money (all also carry a `currency`):

| Collection | Paths |
|---|---|
| `customers` | `balance.amountUnits`, `balance.reservedUnits` |
| `balance_adjustments` | `amountUnits` |
| `budgets` | `amountUnits` |
| `subscription_plans` | `price.amountUnits`, `includedCredit.amountUnits`, `rateLimits[].capValue` (dim `spend_units`) |
| `customer_limits` | `rules[].capValue` (dim `spend_units`) |
| `usage_records` | `costUnits`, `priceUnits` |
| `models` | `price.*UnitsPerMillion`, `cost.*UnitsPerMillion`, `entries[].price.*`, `entries[].cost.*` |
| `model_catalog` | `cost.*UnitsPerMillion` |
| `settlement_outbox` | `context.priceUnits`, `costUnits`, `reservedUnits`, `priceUnitsOverride`, `context.priceSchedule.*`, `costSchedule.*` |
| `rate_limit_counters` | `dimension: "spend_units"` (counters accumulate in the money unit) |

Schedule leaves (7): `input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`,
`inputAudio`, `outputAudio` — each `*UnitsPerMillion` → `*MicrosPerMillion`.

## 6. Phased plan

### Phase 0 — Foundations (safe, reversible, no stored data)
- `MoneyMicros` grain constant + type (`packages/db` primitives / contracts).
- Decimal↔micro codec + unit tests (exactness, edge cases).
- `formatMoney` adaptive-precision rendering.
- **No migration, no schema change yet.**

### Phase 1 — `pre/` migration (additive, non-destructive)
- Add `*Micros` beside every `*Units`; copy `units × factor(currency)` per-document
  via server-side aggregation (reads at write time → no stale clobber).
- Scale spend-limit `capValue` **only where `dimension == "spend_units"`**;
  introduce `spend_micros` dimension value.
- Idempotent (only sets micros when missing); `down()` = no-op.
- **`transactional = false`** (multi-collection, oplog-cap safe), each step
  independently resumable — mirrors the existing `money-units-dual-fields` pre.

### Phase 2 — Schema + settlement + admin (code swap)
- DB schemas: `*Micros` authoritative; `*Units` kept optional for dual-read.
- Settlement (`charges.ts`, `settle.ts`): compute in micros; formula unchanged.
- Balance/reservation: read micros, fall back to units (dual-read window).
- Admin: pricing inputs → **decimal major units** (model form + entry editor);
  `formatMoney` everywhere.
- `LimitDimension` gains `"spend_micros"`; reservation/limit code reads it.

### Phase 3 — `post/` migration (destructive, after new code is live)
- Promote `*Units → *Micros` (units wins if newer), then `$unset` `*Units`.
- Rewrite `spend_units → spend_micros` on rules + counters.
- `down()` = best-effort recreate units from micros (cannot restore divergence).
- `transactional = false`, idempotent, resumable.

## 7. Safety & rollback guarantees

- **Transactional rollback:** when `transactional = true`, `up()` and the
  `_migrations` record insert run in one `withTransaction`; a throw rolls back
  **both** data writes and the applied marker → no partial state, clean retry.
- **Non-transactional steps** (the big cleanups) are each idempotent + resumable,
  so a crash mid-migration resumes rather than corrupts.
- **Lock + checksums:** `_migration_lock` prevents concurrent runs; SHA-256
  checksums prevent re-running an edited file.
- **Deploy ordering (Discourse model):** pre from new image while old container
  serves → swap → post from live new container. Old readers/writers stay valid
  throughout the additive pre window (upgrade-compat hard rule).
- **Immutable files:** once pushed, migration files can't be edited — so pre/post
  are reviewed and signed off **before** being written.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Currency-aware factor wrong | Per-document factor from stored `currency`; test USD×10⁴ / JPY×10⁶ / KWD×10³ on sample docs |
| Blind multiply corrupts non-money caps | Scale `capValue` strictly filtered on `dimension == "spend_units"` |
| In-flight reservations across swap | Dual-read fallback + pre→swap→post ordering (proven by existing migration) |
| Float error in codec | String-based parse/format, no float multiply; unit tests |
| Immutable migration mistake | Review + sign-off before writing pre/post files |
| Sub-cent display shows `$0.00` | `formatMoney` adaptive precision |

## 9. Testing strategy

- **Codec:** exactness round-trips, edge cases (empty, negative, >6 dp, JPY/KWD).
- **Migration:** unit/integration on a fixture DB — verify USD/JPY/KWD conversions,
  spend-limit scaling leaves `tokens`/`requests` caps untouched, idempotent re-run.
- **Settlement:** recompute the $0.0003 case → exactly 300 micros; verify the
  existing 5-unit E2E debit becomes 50,000 micros (= $0.05, unchanged value).
- **Admin:** decimal input parses to correct micros; display renders sub-cent.
- **Release checks:** `schema:snapshot` + `release:check` updated and green.

## 10. Sign-off points

1. **Grain = micros (10⁻⁶ of major unit), admin types decimal major units, field
   suffix `*Micros`** — confirm.
2. **Phase 0 (codec + formatter + grain + tests) implemented first** — confirm.
3. **Phase 1 pre-migration file reviewed before being written** (immutable once
   pushed) — confirm.

## 11. Out of scope (noted, not doing now)

- `BigInt` money (only needed if finer than micro is ever required).
- Aggregate-then-round settlement model (current per-request model retained).
- Historical re-billing of past usage (records keep their stored value; only
  representation changes).
