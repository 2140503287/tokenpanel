/**
 * Streaming tool-call normalization.
 *
 * Adapters yield provider-shaped tool deltas on `StreamChunk.delta.toolCalls`:
 * - OpenAI upstream: `{ index, id?, type?, function?: { name?, arguments? } }`
 * - Anthropic upstream: `{ index, type: "tool_use", id, name }` from
 *   `content_block_start`, then `{ partial_json }` from `input_json_delta`.
 *
 * The two public surfaces need different wire shapes:
 * - OpenAI surface: pass through OpenAI-shaped deltas; translate
 *   Anthropic-shaped deltas into OpenAI incremental `tool_calls`.
 * - Anthropic surface: emit `content_block_start` / `input_json_delta` /
 *   `content_block_stop` events, translating OpenAI-shaped deltas.
 *
 * One block index space per surface; callers own the SSE framing.
 */

/** Raw tool delta as adapters emit it (provider-shaped). */
export type RawToolDelta = Record<string, unknown>;

/** OpenAI incremental tool_calls delta element. */
export type OpenAIToolCallDelta = {
  index: number;
  id?: string | undefined;
  type?: "function" | undefined;
  function?: { name?: string | undefined; arguments?: string | undefined };
};

/**
 * Normalize raw adapter tool deltas into OpenAI-shaped incremental deltas.
 * OpenAI-shaped entries pass through; Anthropic-shaped entries are translated
 * (block start → id/type/name; partial_json → function.arguments fragment).
 */
export function toOpenAIToolCallDeltas(raw: RawToolDelta[]): OpenAIToolCallDelta[] {
  const out: OpenAIToolCallDelta[] = [];
  for (const d of raw) {
    if (!d || typeof d !== "object") continue;
    const index = typeof d.index === "number" ? d.index : 0;
    const fn = d.function as Record<string, unknown> | undefined;
    if (d.type === "tool_use" || (d.id !== undefined && fn === undefined && d.partial_json === undefined)) {
      // Anthropic content_block_start for a tool_use block.
      out.push({
        index,
        ...(typeof d.id === "string" ? { id: d.id } : {}),
        type: "function",
        function: {
          ...(typeof d.name === "string" ? { name: d.name } : {}),
          arguments: "",
        },
      });
      continue;
    }
    if (d.partial_json !== undefined) {
      // Anthropic input_json_delta → OpenAI arguments fragment.
      out.push({
        index,
        function: { arguments: typeof d.partial_json === "string" ? d.partial_json : "" },
      });
      continue;
    }
    // Already OpenAI-shaped: pass through the fields OpenAI defines.
    const passthrough: OpenAIToolCallDelta = { index };
    if (typeof d.id === "string") passthrough.id = d.id;
    if (d.type === "function") passthrough.type = "function";
    if (fn && typeof fn === "object") {
      passthrough.function = {
        ...(typeof fn.name === "string" ? { name: fn.name } : {}),
        ...(typeof fn.arguments === "string" ? { arguments: fn.arguments } : {}),
      };
    }
    out.push(passthrough);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Anthropic-surface content-block stream state
// ---------------------------------------------------------------------------

export type AnthropicBlockKind = "text" | "thinking" | "tool_use";

/**
 * Tracks open content blocks for the Anthropic SSE surface. Anthropic streams
 * one block at a time per index; a kind change closes the previous block.
 * The surface emits start/stop events from the returned instructions.
 */
export class AnthropicBlockStream {
  private nextIndex = 0;
  private open: { index: number; kind: AnthropicBlockKind } | null = null;

  /** Currently open block index, if any. */
  currentIndex(): number | null {
    return this.open?.index ?? null;
  }

  /**
   * Feed a desired block kind; returns the events the surface must emit
   * (close previous block, start new one) before sending the delta.
   */
  transition(kind: AnthropicBlockKind): {
    close: number[];
    start: { index: number; kind: AnthropicBlockKind }[];
    index: number;
  } {
    if (this.open && this.open.kind === kind) {
      return { close: [], start: [], index: this.open.index };
    }
    const close: number[] = [];
    const start: { index: number; kind: AnthropicBlockKind }[] = [];
    if (this.open) close.push(this.open.index);
    const index = this.nextIndex++;
    this.open = { index, kind };
    start.push({ index, kind });
    return { close, start, index };
  }

  /**
   * Force-open a new block of the given kind, closing any open block.
   * Unlike `transition`, a same-kind open block is NOT reused — each tool
   * call is its own block even when consecutive (parallel tool calls).
   */
  openBlock(kind: AnthropicBlockKind): {
    close: number[];
    start: { index: number; kind: AnthropicBlockKind }[];
    index: number;
  } {
    const close: number[] = [];
    if (this.open) close.push(this.open.index);
    const index = this.nextIndex++;
    this.open = { index, kind };
    return { close, start: [{ index, kind }], index };
  }

  /** Close the open block (if any) and return its index. */
  closeOpen(): number | null {
    if (!this.open) return null;
    const index = this.open.index;
    this.open = null;
    return index;
  }

  /** How many blocks have been opened so far. */
  openedCount(): number {
    return this.nextIndex;
  }
}

/**
 * OpenAI-shaped tool deltas → Anthropic tool_use block instructions.
 * A delta carrying `id` opens a new tool_use block; `function.arguments`
 * fragments become `input_json_delta` events on the current tool block.
 */
export function anthropicToolInstructions(
  blocks: AnthropicBlockStream,
  raw: RawToolDelta[],
): {
  close: number[];
  start: { index: number; id: string; name: string }[];
  json: { index: number; partial: string }[];
} {
  const close: number[] = [];
  const start: { index: number; id: string; name: string }[] = [];
  const json: { index: number; partial: string }[] = [];
  for (const d of raw) {
    if (!d || typeof d !== "object") continue;
    const fn = d.function as Record<string, unknown> | undefined;
    const args = typeof fn?.arguments === "string" ? fn.arguments : undefined;
    const hasId = typeof d.id === "string" && d.id.length > 0;
    if (hasId) {
      // New tool_use block (OpenAI first delta for a call, or Anthropic start).
      const t = blocks.openBlock("tool_use");
      close.push(...t.close);
      start.push({
        index: t.index,
        id: d.id as string,
        name: typeof d.name === "string" ? d.name : (fn?.name as string | undefined) ?? "",
      });
      if (args) json.push({ index: t.index, partial: args });
      continue;
    }
    if (args !== undefined) {
      const cur = blocks.currentIndex();
      if (cur !== null) json.push({ index: cur, partial: args });
      continue;
    }
    if (typeof d.partial_json === "string") {
      const cur = blocks.currentIndex();
      if (cur !== null) json.push({ index: cur, partial: d.partial_json });
    }
  }
  return { close, start, json };
}
