import { test, expect, describe } from "bun:test";
import type { ModelDoc } from "@tokenpanel/db";
import type { ChatRequest } from "../../../providers/index.ts";
import { gateReasoningForModel } from "../generation.ts";

function model(reasoning: boolean): ModelDoc {
  return { reasoning } as unknown as ModelDoc;
}

function request(reasoning?: ChatRequest["reasoning"]): ChatRequest {
  return {
    model: "m",
    messages: [],
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

describe("gateReasoningForModel", () => {
  test("drops reasoning effort for non-reasoning models", () => {
    const gated = gateReasoningForModel(
      request({ effort: "high" }),
      model(false),
    );
    expect(gated.reasoning).toBeUndefined();
  });

  test("keeps reasoning effort for reasoning-capable models", () => {
    const gated = gateReasoningForModel(request({ effort: "high" }), model(true));
    expect(gated.reasoning).toEqual({ effort: "high" });
  });

  test("passes through requests without reasoning untouched", () => {
    const req = request();
    expect(gateReasoningForModel(req, model(false))).toBe(req);
    expect(gateReasoningForModel(req, model(true))).toBe(req);
  });

  test("does not mutate the original request", () => {
    const req = request({ effort: "medium" });
    gateReasoningForModel(req, model(false));
    expect(req.reasoning).toEqual({ effort: "medium" });
  });
});
