import { describe, expect, it } from "vitest";
import {
  evalConfigFormSchema,
  getJsonPathCompatibilityWarning,
} from "./evaluator-form-utils";

describe("getJsonPathCompatibilityWarning", () => {
  it.each([
    {
      selector: "$.items[-1]",
      expected:
        "Negative array indices (for example, [-1]) are not supported. Use a slice such as [-1:] instead.",
    },
  ])("warns about unsupported selector $selector", ({ selector, expected }) => {
    expect(getJsonPathCompatibilityWarning(selector)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "$.items[0]",
    "$.items[-1:]",
    // ALIGNABLE FORK: filter and script expressions are supported under eval:"native"
    "$.items[?(@.status === 'active')]",
    "$.items[?@.status]",
    "$.items[(@.length - 1)]",
    "$[‘items’][?@.a]",
    "$['property[-1]']",
    "$['property[?(@.active)]']",
    "$['property[(@.length - 1)]']",
    '$["Don’t"]',
    "$['it’s'].a",
    "$.Don’t",
    "$[‘items’]",
  ])("does not warn about supported selector %s", (selector) => {
    expect(getJsonPathCompatibilityWarning(selector)).toBeNull();
  });
});

describe("evalConfigFormSchema", () => {
  it("blocks configurations with unsupported JSONPath selectors", () => {
    const result = evalConfigFormSchema.safeParse({
      scoreName: "Correctness",
      target: "trace",
      filter: [],
      mapping: [
        {
          templateVariable: "input",
          langfuseObject: "trace",
          objectName: null,
          selectedColumnId: "input",
          jsonSelector: "$.items[-1]",
        },
      ],
      sampling: 1,
      delay: 0,
      timeScope: ["NEW"],
      runOnLive: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["mapping", 0, "jsonSelector"],
          message:
            "Negative array indices (for example, [-1]) are not supported. Use a slice such as [-1:] instead.",
        }),
      );
    }
  });

  // A target switch nulls selectedColumnId but keeps jsonSelector, hiding the
  // JsonPath input and the only place its warning could render.
  it("ignores unsupported selectors on columns that have no JsonPath input", () => {
    const result = evalConfigFormSchema.safeParse({
      scoreName: "Correctness",
      target: "event",
      filter: [],
      mapping: [
        {
          templateVariable: "input",
          langfuseObject: "event",
          objectName: null,
          selectedColumnId: null,
          jsonSelector: "$.items[?@.status]",
        },
      ],
      sampling: 1,
      delay: 0,
      timeScope: ["NEW"],
      runOnLive: true,
    });

    expect(result.success).toBe(true);
  });
});
