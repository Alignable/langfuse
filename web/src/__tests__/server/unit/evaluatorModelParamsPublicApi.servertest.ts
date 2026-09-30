import { describe, it, expect } from "vitest";
import { EvalTemplateType } from "@langfuse/shared";
import {
  CreateEvaluatorBody,
  EvaluatorVersion,
} from "@/src/features/public-api/types/evaluation/evaluators";
import {
  toEvaluatorServiceDefinition,
  toPublicEvaluatorVersion,
} from "@/src/features/public-api/server/evaluation/evaluationAdapters";

// Alignable fork delta port onto v4.32: evaluator judge model sampling params
// (modelParams) must round-trip through the GA evaluator public API. These are
// the three behaviours the fork depends on.
describe("evaluator modelParams public API (Alignable fork delta)", () => {
  const modelParams = {
    temperature: 0.42,
    max_tokens: 256,
  };

  // Change 1 (contract): the public API input accepts modelParams, and the
  // strict schema still rejects genuinely unknown keys.
  describe("input contract", () => {
    it("accepts modelParams on the create body", () => {
      const parsed = CreateEvaluatorBody.parse({
        type: "llm_as_judge",
        name: "judge",
        prompt: "Rate {{input}}",
        modelConfig: { provider: "openai", model: "gpt-4", modelParams },
        outputDefinition: { dataType: "BOOLEAN" },
      });
      expect(parsed.type).toBe("llm_as_judge");
      if (parsed.type !== "llm_as_judge") throw new Error("unreachable");
      expect(parsed.modelConfig?.modelParams).toMatchObject(modelParams);
    });

    it("still rejects unknown keys inside modelConfig (strict preserved)", () => {
      const result = CreateEvaluatorBody.safeParse({
        type: "llm_as_judge",
        name: "judge",
        prompt: "Rate {{input}}",
        modelConfig: {
          provider: "openai",
          model: "gpt-4",
          bogusKey: "nope",
        },
        outputDefinition: { dataType: "BOOLEAN" },
      });
      expect(result.success).toBe(false);
    });

    it("treats modelParams as optional (provider/model only still valid)", () => {
      const parsed = CreateEvaluatorBody.parse({
        type: "llm_as_judge",
        name: "judge",
        prompt: "Rate {{input}}",
        modelConfig: { provider: "openai", model: "gpt-4" },
        outputDefinition: { dataType: "BOOLEAN" },
      });
      if (parsed.type !== "llm_as_judge") throw new Error("unreachable");
      expect(parsed.modelConfig?.modelParams).toBeUndefined();
    });
  });

  // Change 2 (write path): caller-supplied modelParams are persisted. On v4.32
  // this is handled natively by the internal EvaluatorDefinitionInputSchema
  // transform, so the old evaluator-service write fix was intentionally NOT
  // ported. This proves that decision was correct.
  it("persists modelParams through toEvaluatorServiceDefinition (native write path)", () => {
    // Mirror the real handler: the body is parsed first (which transforms the
    // prompt string into chat messages), then handed to the adapter.
    const body = CreateEvaluatorBody.parse({
      type: "llm_as_judge",
      name: "judge",
      prompt: "Rate {{input}}",
      modelConfig: { provider: "openai", model: "gpt-4", modelParams },
      outputDefinition: { dataType: "BOOLEAN" },
    });
    const definition = toEvaluatorServiceDefinition(body);

    expect(definition.type).toBe(EvalTemplateType.LLM_AS_JUDGE);
    if (definition.type !== EvalTemplateType.LLM_AS_JUDGE) {
      throw new Error("unreachable");
    }
    expect(definition.provider).toBe("openai");
    expect(definition.model).toBe("gpt-4");
    expect(definition.modelParams).toMatchObject(modelParams);
  });

  // Change 3 (read path): persisted modelParams are surfaced on the read
  // adapter output (feeds both EvaluatorVersion and Evaluator responses).
  it("surfaces persisted modelParams via toPublicEvaluatorVersion", () => {
    const version = {
      id: "version-1",
      version: 1,
      createdAt: new Date(),
      createdByUser: { id: "user-1", name: "Tester" },
      promptMessages: [{ role: "user", content: "Rate {{input}}" }],
      vars: ["input"],
      variableMapping: null,
      provider: "openai",
      model: "gpt-4",
      modelParams,
      outputDefinition: {
        dataType: "BOOLEAN",
        reasoning: { description: "" },
        score: { description: "" },
      },
    };

    const result = toPublicEvaluatorVersion(
      EvalTemplateType.LLM_AS_JUDGE,
      version as unknown as Parameters<typeof toPublicEvaluatorVersion>[1],
    );

    expect(result.type).toBe("llm_as_judge");
    if (result.type !== "llm_as_judge") throw new Error("unreachable");
    expect(result.modelConfig?.modelParams).toMatchObject(modelParams);

    // The output validates against the public schema (proves the contract
    // change accepts modelParams on the read surface too).
    const reparsed = EvaluatorVersion.parse(result);
    if (reparsed.type !== "llm_as_judge") throw new Error("unreachable");
    expect(reparsed.modelConfig?.modelParams).toMatchObject(modelParams);
  });
});
