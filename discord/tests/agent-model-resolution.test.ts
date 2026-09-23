import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { describe, expect, test } from "vitest";

import { DEFAULT_MODEL } from "#/agents/analyst/model.ts";

const models = createModels();
models.setProvider(openrouterProvider());

function resolveModel(model: string) {
  const slash = model.indexOf("/");
  const providerId = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  return models.getModel(providerId, modelId);
}

describe("Discord analyst model resolution", () => {
  test("DEFAULT_MODEL resolves against the bundled OpenRouter catalog", () => {
    const resolved = resolveModel(DEFAULT_MODEL);

    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe("openai/gpt-6-luna");
    expect(resolved?.provider).toBe("openrouter");
  });
});
