/**
 * OpenAI / Anthropic / playground request Effect schemas.
 * Intentionally permissive (passthrough extras) for provider compatibility.
 * Production routes decode via safeParseSchema / sValidator.
 *
 * Bounds (max messages / string lengths) defend against memory DoS from
 * authenticated keys; wire size is also capped by hono bodyLimit.
 */
import { Schema } from "effect";
import {
  Email,
  exactOptional,
  PositiveSafeInt,
  SafeInt,
} from "@tokenpanel/contracts/effect";
import {
  MAX_CHAT_MEDIA_BASE64_CHARS,
  MAX_CHAT_MESSAGES_COUNT,
  MAX_CHAT_TEXT_CHARS,
  MAX_CHAT_TOOLS_COUNT,
  MAX_THINKING_BUDGET_TOKENS,
} from "../../config/security-policy.ts";

/** Passthrough bag for unknown compatibility fields. */
const PassthroughRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

const BoundedText = Schema.String.pipe(Schema.maxLength(MAX_CHAT_TEXT_CHARS));
const BoundedMediaData = Schema.String.pipe(
  Schema.maxLength(MAX_CHAT_MEDIA_BASE64_CHARS),
);
const BoundedModelId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
);
const BoundedMessages = <A, I, R>(item: Schema.Schema<A, I, R>) =>
  Schema.Array(item).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_CHAT_MESSAGES_COUNT),
  );
const BoundedTools = Schema.Array(Schema.Unknown).pipe(
  Schema.maxItems(MAX_CHAT_TOOLS_COUNT),
);

// ---------------------------------------------------------------------------
// OpenAI chat completions
// ---------------------------------------------------------------------------

const OpenAIImageUrlObject = Schema.Struct({
  url: Schema.String.pipe(Schema.maxLength(MAX_CHAT_MEDIA_BASE64_CHARS)),
  detail: exactOptional(Schema.Literal("auto", "low", "high")),
});

const OpenAIInputAudioObject = Schema.Struct({
  data: BoundedMediaData,
  format: Schema.Literal("wav", "mp3"),
});

const OpenAIFileObject = Schema.Struct({
  file_id: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
  file_data: exactOptional(BoundedMediaData),
  filename: exactOptional(Schema.String.pipe(Schema.maxLength(512))),
});

const OpenAIContentPart = Schema.Struct(
  {
    type: Schema.Literal("text", "image_url", "input_audio", "file"),
    text: exactOptional(BoundedText),
    image_url: exactOptional(OpenAIImageUrlObject),
    input_audio: exactOptional(OpenAIInputAudioObject),
    file: exactOptional(OpenAIFileObject),
  },
  PassthroughRecord,
);

const OpenAIToolCall = Schema.Struct(
  {
    id: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
    type: exactOptional(Schema.Literal("function")),
    function: exactOptional(
      Schema.Struct(
        {
          name: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
          arguments: exactOptional(Schema.String.pipe(Schema.maxLength(MAX_CHAT_TEXT_CHARS))),
        },
        PassthroughRecord,
      ),
    ),
  },
  PassthroughRecord,
);

export const OpenAIMessage = Schema.Struct({
  role: Schema.Literal("system", "developer", "user", "assistant", "tool"),
  /**
   * Spec: `string | array | null`; null is canonical for assistant messages
   * that carry only tool_calls. Required for user/system/developer/tool.
   */
  content: exactOptional(
    Schema.NullOr(
    Schema.Union(
      BoundedText,
      Schema.Array(OpenAIContentPart).pipe(
        Schema.maxItems(MAX_CHAT_MESSAGES_COUNT),
      ),
    ),
  ),
  ),
  name: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
  refusal: exactOptional(
    Schema.NullOr(Schema.String.pipe(Schema.maxLength(MAX_CHAT_TEXT_CHARS))),
  ),
  audio: exactOptional(
    Schema.Struct({ id: Schema.String.pipe(Schema.maxLength(256)) }),
  ),
  tool_call_id: exactOptional(
    Schema.String.pipe(Schema.maxLength(256)),
  ),
  tool_calls: exactOptional(
    Schema.Array(OpenAIToolCall).pipe(Schema.maxItems(MAX_CHAT_TOOLS_COUNT)),
  ),
});
export type OpenAIMessage = Schema.Schema.Type<typeof OpenAIMessage>;

export const OpenAIChatCompletionBody = Schema.Struct(
  {
    model: BoundedModelId,
    messages: BoundedMessages(OpenAIMessage),
    stream: exactOptional(Schema.NullOr(Schema.Boolean)),
    temperature: exactOptional(Schema.NullOr(Schema.Number)),
    max_tokens: exactOptional(
      Schema.NullOr(PositiveSafeInt),
    ),
    max_completion_tokens: exactOptional(
      Schema.NullOr(PositiveSafeInt),
    ),
    top_p: exactOptional(Schema.NullOr(Schema.Number)),
    n: exactOptional(PositiveSafeInt),
    frequency_penalty: exactOptional(Schema.NullOr(Schema.Number)),
    presence_penalty: exactOptional(Schema.NullOr(Schema.Number)),
    logit_bias: exactOptional(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    ),
    logprobs: exactOptional(Schema.NullOr(Schema.Boolean)),
    top_logprobs: exactOptional(Schema.NullOr(SafeInt)),
    seed: exactOptional(Schema.NullOr(SafeInt)),
    stop: exactOptional(
      Schema.NullOr(
        Schema.Union(
          Schema.String.pipe(Schema.maxLength(200)),
          Schema.Array(Schema.String.pipe(Schema.maxLength(200))).pipe(
            Schema.maxItems(16),
          ),
        ),
      ),
    ),
    tools: exactOptional(BoundedTools),
    tool_choice: exactOptional(Schema.Unknown),
    parallel_tool_calls: exactOptional(Schema.Boolean),
    response_format: exactOptional(Schema.Unknown),
    reasoning_effort: exactOptional(
      Schema.NullOr(
        Schema.Literal("none", "minimal", "low", "medium", "high", "xhigh", "max"),
      ),
    ),
    verbosity: exactOptional(Schema.Literal("low", "medium", "high")),
    modalities: exactOptional(Schema.Array(Schema.Unknown)),
    store: exactOptional(Schema.NullOr(Schema.Boolean)),
    metadata: exactOptional(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    ),
    user: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
    web_search_options: exactOptional(Schema.Unknown),
    prediction: exactOptional(Schema.Unknown),
    audio: exactOptional(Schema.Unknown),
    moderation: exactOptional(Schema.Unknown),
    service_tier: exactOptional(Schema.Unknown),
    customerEmail: exactOptional(Email),
  },
  PassthroughRecord,
);
export type OpenAIChatCompletionBody = Schema.Schema.Type<
  typeof OpenAIChatCompletionBody
>;

// ---------------------------------------------------------------------------
// Anthropic messages
// ---------------------------------------------------------------------------

const AnthropicCacheControl = Schema.Struct(
  {
    type: Schema.Literal("ephemeral"),
    ttl: exactOptional(Schema.Literal("5m", "1h")),
  },
  PassthroughRecord,
);

/** Image/document source bag — base64, url, text, and content flavors. */
const AnthropicSource = Schema.Struct(
  {
    type: Schema.String.pipe(Schema.maxLength(64)),
    media_type: exactOptional(Schema.String.pipe(Schema.maxLength(128))),
    data: exactOptional(BoundedMediaData),
    url: exactOptional(Schema.String.pipe(Schema.maxLength(MAX_CHAT_MEDIA_BASE64_CHARS))),
    text: exactOptional(BoundedText),
    content: exactOptional(Schema.Unknown),
    title: exactOptional(Schema.String.pipe(Schema.maxLength(512))),
    context: exactOptional(Schema.String.pipe(Schema.maxLength(MAX_CHAT_TEXT_CHARS))),
    citations: exactOptional(Schema.Unknown),
  },
  PassthroughRecord,
);

/**
 * Permissive content block: `type` is an open string so replay of any
 * Anthropic block (text, image, document, tool_use, tool_result, thinking,
 * redacted_thinking, server_tool_use, *_tool_result, …) validates. Unknown
 * block fields survive via PassthroughRecord for faithful upstream replay.
 */
const AnthropicContentBlock = Schema.Struct(
  {
    type: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
    text: exactOptional(BoundedText),
    source: exactOptional(AnthropicSource),
    id: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
    name: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
    input: exactOptional(Schema.Unknown),
    tool_use_id: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
    content: exactOptional(Schema.Unknown),
    is_error: exactOptional(Schema.Boolean),
    thinking: exactOptional(BoundedText),
    signature: exactOptional(
      Schema.String.pipe(Schema.maxLength(MAX_CHAT_MEDIA_BASE64_CHARS)),
    ),
    cache_control: exactOptional(AnthropicCacheControl),
    citations: exactOptional(Schema.Unknown),
  },
  PassthroughRecord,
);

export const AnthropicMessage = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  content: Schema.Union(
    BoundedText,
    Schema.Array(AnthropicContentBlock).pipe(
      Schema.maxItems(MAX_CHAT_MESSAGES_COUNT),
    ),
  ),
});
export type AnthropicMessage = Schema.Schema.Type<typeof AnthropicMessage>;

export const AnthropicMessagesBody = Schema.Struct(
  {
    model: BoundedModelId,
    messages: BoundedMessages(AnthropicMessage),
    system: exactOptional(
      Schema.Union(
        BoundedText,
        Schema.Array(Schema.Unknown).pipe(
          Schema.maxItems(MAX_CHAT_MESSAGES_COUNT),
        ),
      ),
    ),
    stream: exactOptional(Schema.Boolean),
    /** Spec allows 0 (cache pre-warm without generation). */
    max_tokens: SafeInt.pipe(Schema.greaterThanOrEqualTo(0)),
    temperature: exactOptional(Schema.Number),
    top_p: exactOptional(Schema.Number),
    top_k: exactOptional(Schema.Number),
    stop_sequences: exactOptional(
      Schema.Array(Schema.String.pipe(Schema.maxLength(200))).pipe(
        Schema.maxItems(16),
      ),
    ),
    tools: exactOptional(BoundedTools),
    tool_choice: exactOptional(Schema.Unknown),
    thinking: exactOptional(
      Schema.Union(
        Schema.Struct({ type: Schema.Literal("disabled") }),
        Schema.Struct({
          type: Schema.Literal("enabled"),
          budget_tokens: Schema.Number.pipe(
            Schema.greaterThan(0),
            Schema.lessThanOrEqualTo(MAX_THINKING_BUDGET_TOKENS),
          ),
        }),
      ),
    ),
    metadata: exactOptional(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    ),
    service_tier: exactOptional(Schema.Literal("auto", "standard_only")),
    container: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
    mcp_servers: exactOptional(Schema.Array(Schema.Unknown)),
    betas: exactOptional(Schema.Array(Schema.Unknown)),
    customerEmail: exactOptional(Email),
  },
  PassthroughRecord,
);
export type AnthropicMessagesBody = Schema.Schema.Type<
  typeof AnthropicMessagesBody
>;

// ---------------------------------------------------------------------------
// Playground (admin panel)
// ---------------------------------------------------------------------------

const PlaygroundMessage = Schema.Struct({
  role: Schema.Literal("system", "developer", "user", "assistant", "tool"),
  content: exactOptional(
    Schema.NullOr(
    Schema.Union(
      BoundedText,
      Schema.Array(OpenAIContentPart).pipe(
        Schema.maxItems(MAX_CHAT_MESSAGES_COUNT),
      ),
    ),
  ),
  ),
  tool_call_id: exactOptional(Schema.String.pipe(Schema.maxLength(256))),
  tool_calls: exactOptional(
    Schema.Array(OpenAIToolCall).pipe(Schema.maxItems(MAX_CHAT_TOOLS_COUNT)),
  ),
});

export const PlaygroundChatBody = Schema.Struct(
  {
    model: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
    messages: BoundedMessages(PlaygroundMessage),
    stream: exactOptional(Schema.Boolean),
    temperature: exactOptional(Schema.Number),
    max_tokens: exactOptional(PositiveSafeInt),
    max_completion_tokens: exactOptional(PositiveSafeInt),
    top_p: exactOptional(Schema.Number),
    top_k: exactOptional(SafeInt.pipe(Schema.nonNegative())),
    frequency_penalty: exactOptional(Schema.Number),
    presence_penalty: exactOptional(Schema.Number),
    seed: exactOptional(SafeInt),
    stop: exactOptional(
      Schema.Union(
        Schema.String.pipe(Schema.maxLength(200)),
        Schema.Array(Schema.String.pipe(Schema.maxLength(200))).pipe(
          Schema.maxItems(16),
        ),
      ),
    ),
    response_format: exactOptional(Schema.Unknown),
    reasoning_effort: exactOptional(
      Schema.Literal("low", "medium", "high"),
    ),
    customerId: exactOptional(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
    ),
  },
  PassthroughRecord,
);
export type PlaygroundChatBody = Schema.Schema.Type<typeof PlaygroundChatBody>;
