/**
 * Domain API client for analytics summary aggregates.
 */
import { getJson } from "./client.ts";

export type AnalyticsSummary = {
  from: string;
  to: string;
  totals: {
    requests: number;
    tokens: number;
    promptTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    byCurrency: Array<{
      currency: string;
      requests: number;
      tokens: number;
      costMicros: number;
      priceMicros: number;
    }>;
  };
  topCustomers: Array<{
    customerId: string;
    customerName: string;
    currency: string;
    requests: number;
    tokens: number;
    cacheReadTokens: number;
    promptTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    costMicros: number;
    priceMicros: number;
  }>;
};

export function getAnalyticsSummary(params: {
  from: string;
  to: string;
  top?: number;
}): Promise<AnalyticsSummary> {
  const q = new URLSearchParams({
    from: params.from,
    to: params.to,
    top: String(params.top ?? 50),
  });
  return getJson<AnalyticsSummary>(`/admin/analytics/summary?${q.toString()}`);
}
