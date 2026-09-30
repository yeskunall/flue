import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
    style: "warn",
    suspicious: "error",
  },
  ignorePatterns: ["**/dist/**"],
  overrides: [
    {
      files: [
        "discord/tests/member-lookup-integration.test.ts",
        "shared/discord/src/reader.ts",
        "shared/discord/tests/members.test.ts",
        "shared/discord/tests/reader.test.ts",
      ],
      rules: { "unicorn/no-null": "off" },
    },
    {
      files: ["**/*.test.ts"],
      rules: { "no-magic-numbers": "off" },
    },
  ],
  plugins: ["typescript", "unicorn", "oxc", "import", "vitest"],
  rules: {
    "import/consistent-type-specifier-style": ["warn", "prefer-top-level"],
    "import/no-named-export": "off",
    "no-array-constructor": "error",
    "no-case-declarations": "error",
    "no-constant-binary-expression": [
      "error",
      { checkRelationalComparisons: false },
    ],
    "no-duplicate-imports": ["warn", { allowSeparateTypeImports: true }],
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
    "no-magic-numbers": ["warn", { ignore: [0, 1, 2] }],
    "no-prototype-builtins": "error",
    "no-regex-spaces": "error",
    "no-unused-vars": ["error", { reportVarsOnlyUsedAsTypes: true }],
    "no-useless-assignment": "error",
    "no-var": "error",
    "one-var": ["warn", "never"],
    "prefer-const": "error",
    "prefer-rest-params": "error",
    "prefer-spread": "error",
    "sort-imports": ["warn", { ignoreDeclarationSort: true }],
    "sort-keys": ["warn", "asc", { allowLineSeparatedGroups: true }],
    "typescript/ban-ts-comment": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-namespace": "error",
    "typescript/no-require-imports": "error",
    "typescript/no-unsafe-function-type": "error",
    "vitest/no-importing-vitest-globals": "off",
    "vitest/prefer-lowercase-title": [
      "warn",
      { allowedPrefixes: ["DiscordReader", "Flue", "REST"] },
    ],
    "vitest/prefer-to-be-falsy": "off",
    "vitest/prefer-to-be-truthy": "off",
    "vitest/prefer-strict-boolean-matchers": "warn",
    "vitest/valid-expect": ["warn", { maxArgs: 2 }],
  },
});
