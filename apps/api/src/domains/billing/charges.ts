/**
 * Pure charge computation (task 9.1).
 * Money in integer micros (10⁻⁶ of major unit); never free-bill missing usage.
 */

import type { ModelDoc, ModelEntryDoc } from "@tokenpanel/db";
import type { CacheAccountingMode } from "../../providers/provider-usage.ts";
import type { ChatResponse } from "../../providers/types.ts";
import { TOKENS_PER_MILLION_COUNT } from "./policy.ts";

/** Per-million micros price/cost schedule fields. */
export type ChargeSchedule = {
  inputMicrosPerMillion?: number | undefined;
  outputMicrosPerMillion?: number | undefined;
  reasoningMicrosPerMillion?: number | undefined;
  cacheReadMicrosPerMillion?: number | undefined;
  cacheWriteMicrosPerMillion?: number | undefined;
  inputAudioMicrosPerMillion?: number | undefined;
  outputAudioMicrosPerMillion?: number | undefined;
};

/** Protocol default when adapters did not stamp usage.cacheAccounting. */
export function cacheAccountingForProtocol(
  protocol: "openai" | "anthropic",
): CacheAccountingMode {
  return protocol === "anthropic" ? "additive" : "subset";
}

/**
 * Resolve cache accounting mode. Prefer adapter-stamped usage field, then an
 * explicit override (protocol / frozen outbox), never token-amount heuristics.
 */
export function resolveCacheAccounting(
  usage: ChatResponse["usage"],
  fallback?: CacheAccountingMode,
): CacheAccountingMode {
  if (usage.cacheAccounting === "subset" || usage.cacheAccounting === "additive") {
    return usage.cacheAccounting;
  }
  return fallback ?? "subset";
}

/**
 * Apply a token price schedule.
 *
 * - Reasoning is inside completion/output (never double-charge).
 * - Cache: subset (OpenAI) peels from prompt; additive (Anthropic) adds cache.
 */
export function applyTokenSchedule(
  schedule: ChargeSchedule,
  usage: ChatResponse["usage"],
  opts?: { cacheAccounting?: CacheAccountingMode | undefined } | undefined,
): number {
  const reasoningRaw = Math.max(0, usage.reasoningTokens ?? 0);
  const reasoning = Math.min(reasoningRaw, usage.completionTokens);
  const outputRate = schedule.outputMicrosPerMillion ?? 0;
  const reasoningRate = schedule.reasoningMicrosPerMillion;

  let outputCharge: number;
  if (reasoningRate === undefined || reasoning === 0) {
    outputCharge = Math.ceil(
      (usage.completionTokens * outputRate) / TOKENS_PER_MILLION_COUNT,
    );
  } else {
    const nonReasoningOutput = usage.completionTokens - reasoning;
    outputCharge =
      Math.ceil((nonReasoningOutput * outputRate) / TOKENS_PER_MILLION_COUNT) +
      Math.ceil((reasoning * reasoningRate) / TOKENS_PER_MILLION_COUNT);
  }

  const inputRate = schedule.inputMicrosPerMillion ?? 0;
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  const readRate = schedule.cacheReadMicrosPerMillion;
  const writeRate = schedule.cacheWriteMicrosPerMillion;
  const prompt = usage.promptTokens;
  const cacheAccounting = resolveCacheAccounting(usage, opts?.cacheAccounting);

  let inputCharge: number;
  if (cacheAccounting === "additive") {
    inputCharge =
      Math.ceil((prompt * inputRate) / TOKENS_PER_MILLION_COUNT) +
      Math.ceil((cacheRead * (readRate ?? 0)) / TOKENS_PER_MILLION_COUNT) +
      Math.ceil((cacheWrite * (writeRate ?? 0)) / TOKENS_PER_MILLION_COUNT);
  } else {
    let remaining = prompt;
    let cacheCharge = 0;
    if (readRate !== undefined && cacheRead > 0) {
      const peeled = Math.min(cacheRead, remaining);
      remaining -= peeled;
      cacheCharge += Math.ceil((peeled * readRate) / TOKENS_PER_MILLION_COUNT);
    }
    if (writeRate !== undefined && cacheWrite > 0) {
      const peeled = Math.min(cacheWrite, remaining);
      remaining -= peeled;
      cacheCharge += Math.ceil((peeled * writeRate) / TOKENS_PER_MILLION_COUNT);
    }
    inputCharge =
      Math.ceil((remaining * inputRate) / TOKENS_PER_MILLION_COUNT) +
      cacheCharge;
  }

  return inputCharge + outputCharge;
}

/**
 * Compute cost (org pays) and price (customer charged) in micros.
 */
export function computeCharges(params: {
  entry: ModelEntryDoc;
  model: ModelDoc;
  usage: ChatResponse["usage"];
  cacheAccounting?: CacheAccountingMode | undefined;
}): { costMicros: number; priceMicros: number; currency: string } {
  const { entry, model, usage } = params;
  const priceSchedule = entry.price ?? model.price;
  const costSchedule = entry.cost;
  const opts = { cacheAccounting: params.cacheAccounting };

  const priceMicros = applyTokenSchedule(priceSchedule, usage, opts);
  const costMicros = costSchedule
    ? applyTokenSchedule(costSchedule, usage, opts)
    : 0;

  return { costMicros, priceMicros, currency: model.currency };
}
