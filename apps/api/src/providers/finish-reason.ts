/**
 * Cross-protocol finish-reason normalization.
 *
 * TokenPanel fronts heterogeneous providers; each public surface must emit
 * its own protocol's enum regardless of the backing provider:
 * - OpenAI chat completions: `stop | length | tool_calls | content_filter`
 *   (plus `function_call` for legacy models).
 * - Anthropic messages: `end_turn | max_tokens | stop_sequence | tool_use |
 *   pause_turn | refusal | model_context_window_exceeded`.
 *
 * Unknown upstream reasons map to the neutral default (never leak a foreign
 * enum value to a client).
 */

export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call";

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded";

/** Map any upstream/provider finish reason to the OpenAI wire enum. */
export function toOpenAIFinishReason(raw: string | undefined | null): OpenAIFinishReason {
  switch (raw) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "length":
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_calls":
    case "tool_use":
      return "tool_calls";
    case "content_filter":
    case "refusal":
      return "content_filter";
    case "function_call":
      return "function_call";
    default:
      return "stop";
  }
}

/** Map any upstream/provider finish reason to the Anthropic wire enum. */
export function toAnthropicStopReason(raw: string | undefined | null): AnthropicStopReason {
  switch (raw) {
    case "end_turn":
    case "stop":
    case "function_call":
      return "end_turn";
    case "max_tokens":
    case "length":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "tool_use":
    case "tool_calls":
      return "tool_use";
    case "pause_turn":
      return "pause_turn";
    case "refusal":
    case "content_filter":
      return "refusal";
    case "model_context_window_exceeded":
      return "model_context_window_exceeded";
    default:
      return "end_turn";
  }
}
