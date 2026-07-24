import * as React from "react";
import { formatMoney } from "@/utils/format";

interface UnitsPreviewProps {
  /** Raw string value from the input (may be empty or non-integer). */
  value: string;
  /** ISO 4217 currency code (e.g. "USD", "JPY"). */
  currency: string;
  /** Optional suffix appended after the formatted money (e.g. "/ 1M tokens"). */
  suffix?: string;
}

/**
 * Live preview of integer units as formatted money.
 * Renders nothing when the value is empty, non-numeric, or zero.
 */
function UnitsPreview({ value, currency, suffix }: UnitsPreviewProps): React.ReactElement | null {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n === 0) return null;
  return (
    <span className="text-xs text-muted-foreground">
      ≈ {formatMoney(n, currency)}{suffix ? ` ${suffix}` : ""}
    </span>
  );
}

export { UnitsPreview };
export type { UnitsPreviewProps };
