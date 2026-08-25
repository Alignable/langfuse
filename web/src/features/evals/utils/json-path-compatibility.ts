const stripJsonPathStringLiterals = (selector: string): string => {
  let quote: "'" | '"' | "`" | null = null;
  let isEscaped = false;

  // Ignore expression-like text inside quoted property names to avoid false warnings.
  return [...selector]
    .map((character) => {
      if (quote) {
        if (isEscaped) {
          isEscaped = false;
        } else if (character === "\\") {
          isEscaped = true;
        } else if (character === quote) {
          quote = null;
        }

        return " ";
      }

      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        return " ";
      }

      return character;
    })
    .join("");
};

export function getJsonPathCompatibilityWarning(
  selector: string | null | undefined,
): string | null {
  if (!selector) return null;

  const selectorWithoutStrings = stripJsonPathStringLiterals(selector);

  // ALIGNABLE FORK: filter ([?...]) and script ([(...)]) expressions ARE
  // supported now that JSONPath runs with eval:"native". Only the negative
  // single-index limitation remains (jsonpath-plus needs a slice like [-1:]).
  if (/\[\s*-\d+\s*\]/u.test(selectorWithoutStrings)) {
    return "Negative array indices (for example, [-1]) are not supported. Use a slice such as [-1:] instead.";
  }

  return null;
}
