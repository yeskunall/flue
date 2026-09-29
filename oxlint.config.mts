import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
    style: "warn",
    suspicious: "error",
  },
  ignorePatterns: ["**/dist/**"],
  plugins: ["typescript", "unicorn", "oxc", "import", "vitest"],
  rules: {
    "import/consistent-type-specifier-style": ["warn", "prefer-top-level"],
    "no-array-constructor": "error",
    "no-case-declarations": "error",
    "no-constant-binary-expression": [
      "error",
      { checkRelationalComparisons: false },
    ],
    "no-empty": "error",
    "no-fallthrough": "error",
    "no-irregular-whitespace": [
      "error",
      {
        skipJSXText: false,
        skipRegExps: false,
        skipTemplates: false,
      },
    ],
    "no-prototype-builtins": "error",
    "no-regex-spaces": "error",
    "no-unused-vars": ["error", { reportVarsOnlyUsedAsTypes: true }],
    "no-useless-assignment": "error",
    "no-var": "error",
    "one-var": ["warn", "never"],
    "prefer-const": "error",
    "prefer-rest-params": "error",
    "prefer-spread": "error",
    "sort-keys": ["warn", "asc", { allowLineSeparatedGroups: true }],
    "typescript/ban-ts-comment": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-namespace": "error",
    "typescript/no-require-imports": "error",
    "typescript/no-unsafe-function-type": "error",
    "vitest/valid-expect": ["warn", { maxArgs: 2 }],
  },
});
