import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LLMAdapter } from "@langfuse/shared";

vi.mock("@/src/utils/api", () => ({
  api: {
    llmApiKey: {
      all: {
        useQuery: () => ({ data: { data: [] } }),
      },
    },
  },
}));

vi.mock("@/src/hooks/useProjectIdFromURL", () => ({
  default: () => "project-1",
}));

import { useModelParams } from "./useModelParams";

describe("useModelParams", () => {
  it("hydrates providerOptions (reasoning effort) from a judge-model config that nests them under `modelParams`", () => {
    // Shape the eval JudgeModelConfigurationDialog passes: config nested
    // under `modelParams`.
    const { result } = renderHook(() =>
      useModelParams(undefined, {
        initialModel: {
          provider: "openai-connection",
          model: "gpt-5.6-luna",
          adapter: LLMAdapter.OpenAI,
          modelParams: {
            providerOptions: { reasoning_effort: "high" },
          },
        },
      }),
    );

    expect(result.current.modelParams.providerOptions).toEqual({
      value: { reasoning_effort: "high" },
      enabled: true,
    });
  });
});
