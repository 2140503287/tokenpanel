/**
 * Provider adapter types.
 * Optional fields use `?: T | undefined` so exactOptionalPropertyTypes allows
 * explicit undefined from optional chaining / schema outputs without casts.
 */

import type { Effect } from "effect";
import type { ProviderError } from "./provider-errors.ts";

/**
 * Protocol-neutral content part. Field names are internal (camelCase);
 * adapters serialize to each protocol's wire shape (OpenAI snake_case
 * `image_url`/`input_audio`/`file`, Anthropic `image`/`document`/`tool_use`
 * blocks). Never JSON.stringify a ContentPart directly to a provider.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string; detail?: string | undefined } }
  | {
      type: "input_audio";
      inputData: { data: string; format: "wav" | "mp3" };
    }
  | {
      type: "file";
      file: {
        fileId?: string | undefined;
        fileData?: string | undefined;
        filename?: string | undefined;
      };
    }
  /** Anthropic assistant tool-call block (request replay). */
  | { type: "tool_use"; id: string; name: string; input: unknown }
  /** Anthropic user tool-result block (request replay). */
  | {
      type: "tool_result";
      toolUseId: string;
      content?: unknown;
      isError?: boolean | undefined;
    }
  /**
   * Protocol-native block kept verbatim for replay (Anthropic `thinking`
   * with signature, `document`, server-tool results, …). The owning
   * protocol's adapter passes it through; foreign adapters degrade to text.
   */
  | { type: "raw"; block: Record<string, unknown> };

export type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  /**
   * `null` is the canonical OpenAI assistant shape when the message carries
   * only tool_calls (spec: `string | array | null`). Adapters must preserve
   * null on the wire, not coerce to "".
   */
  content: string | ContentPart[] | null;
  name?: string | undefined;
  toolCallId?: string | undefined;
  toolCalls?: unknown[] | undefined;
  /** OpenAI assistant refusal (spec: `string | null`). */
  refusal?: string | null | undefined;
  /** OpenAI audio-response reference for multi-turn audio. */
  audio?: { id: string } | undefined;
  reasoning?: string | undefined;
};

export type DiscoveredModel = {
  upstreamModelId: string;
  displayName: string;
  reasoning?: boolean | undefined;
  toolCall?: boolean | undefined;
  structuredOutput?: boolean | undefined;
  temperature?: boolean | undefined;
  attachment?: boolean | undefined;
  limits: {
    context?: number | undefined;
    input?: number | undefined;
    output?: number | undefined;
  };
  modalities: { input: string[]; output: string[] };
  status?: "alpha" | "beta" | "deprecated" | "ga" | undefined;
  cost?:
    | {
        inputUnitsPerMillion: number;
        outputUnitsPerMillion: number;
        reasoningUnitsPerMillion?: number | undefined;
        cacheReadUnitsPerMillion?: number | undefined;
        cacheWriteUnitsPerMillion?: number | undefined;
        inputAudioUnitsPerMillion?: number | undefined;
        outputAudioUnitsPerMillion?: number | undefined;
      }
    | undefined;
  raw?: Record<string, unknown> | undefined;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  /**
   * Top-level system prompt (Anthropic `system` param). `text` feeds
   * estimation + OpenAI-shaped upstreams (developer message); `blocks`
   * carries the original structured array — including `cache_control`
   * breakpoints — to Anthropic upstreams verbatim.
   */
  system?: { text: string; blocks?: unknown[] | undefined } | undefined;
  stream?: boolean | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  reasoning?: { effort?: string | undefined } | boolean | undefined;
  topP?: number | undefined;
  tools?: unknown[] | undefined;
  toolChoice?: unknown | undefined;
  stop?: string[] | undefined;
  responseFormat?: unknown | undefined;
  signal?: AbortSignal | undefined;
  extra?: Record<string, unknown> | undefined;
};

export type ChatResponse = {
  id: string;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finishReason: string;
  }[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    totalTokens: number;
    /** Adapter-stamped cache billing mode; see CacheAccountingMode. */
    cacheAccounting?: "subset" | "additive" | undefined;
  };
  /** Explicit usage provenance; missing must not settle as free. */
  usageStatus?: "reported" | "missing" | undefined;
  usageMissingReason?: string | undefined;
  providerRequestId?: string | undefined;
};

export type StreamChunk = {
  type: "delta" | "done" | "error";
  delta?:
    | {
        role?: string | undefined;
        content?: string | undefined;
        toolCalls?: unknown[] | undefined;
        reasoning?: string | undefined;
      }
    | undefined;
  finishReason?: string | undefined;
  usage?: ChatResponse["usage"] | undefined;
  /**
   * True only when a protocol terminal event was observed
   * (OpenAI `[DONE]`, Anthropic `message_stop`). EOF without a terminal event
   * yields `done` with `streamComplete: false` so routes do not settle
   * partial/truncated usage as authoritative.
   */
  streamComplete?: boolean | undefined;
  error?: { code: string; message: string } | undefined;
};

export type AdapterContext = {
  baseUrl: string;
  apiKey: string;
  providerOrg?: string | null | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /**
   * App-level HTTP timeout (ms), resolved from per-provider `httpTimeoutMs`
   * or global PROVIDER_HTTP_TIMEOUT_MS (default 120_000).
   * 0 / undefined = no app timeout (only caller AbortSignal).
   * Non-streaming: full request. Streaming: TTFB / headers only.
   */
  timeoutMs?: number | undefined;
};

/**
 * Provider SDK adapter.
 * `listModels` / `chatComplete` return Effects (R=never); callers yield* or
 * Effect.runPromise in tests. `streamChat` stays an AsyncGenerator — throws
 * ProviderError on pre-stream / body-read failures.
 */
export type ProviderAdapter = {
  sdkType: string;
  listModels(
    ctx: AdapterContext,
  ): Effect.Effect<DiscoveredModel[], ProviderError>;
  chatComplete(
    ctx: AdapterContext,
    req: ChatRequest,
  ): Effect.Effect<ChatResponse, ProviderError>;
  streamChat(
    ctx: AdapterContext,
    req: ChatRequest,
  ): AsyncGenerator<StreamChunk, void, void>;
};
