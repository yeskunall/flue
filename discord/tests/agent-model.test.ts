import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
  resetModelsForTests,
  resolveModel,
  setProvider,
} from "@flue/runtime/internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  useModel: vi.fn<(model: string, options: { thinkingLevel: "low" }) => void>(),
  useResponseStart:
    vi.fn<(callback: () => { timestamp: string; model: string }) => void>(),
  useDiscordTools: vi.fn<(reader: unknown) => void>(),
}));

vi.mock("@flue/runtime", () => ({
  useModel: hooks.useModel,
  useResponseStart: hooks.useResponseStart,
}));

vi.mock("#/agents/analyst/tools/discord.ts", () => ({
  useDiscordTools: hooks.useDiscordTools,
}));

vi.mock("#/discord/client", () => ({
  getDiscordReader: () => ({}),
}));

import { DEFAULT_MODEL, DiscordAnalyst } from "#/agents/analyst/agent.ts";

const originalModel = process.env.MODEL;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MODEL;
});

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.MODEL;
  } else {
    process.env.MODEL = originalModel;
  }
});

describe("Discord analyst model selection", () => {
  test("passes the trimmed MODEL or default model to both runtime hooks", () => {
    const configuredModel = "openai/gpt-5.5";
    process.env.MODEL = ` ${configuredModel} `;

    DiscordAnalyst();

    delete process.env.MODEL;
    DiscordAnalyst();

    expect(hooks.useModel.mock.calls).toEqual([
      [configuredModel, { thinkingLevel: "low" }],
      [DEFAULT_MODEL, { thinkingLevel: "low" }],
    ]);
    expect(
      hooks.useResponseStart.mock.calls.map(([createMetadata]) =>
        createMetadata(),
      ),
    ).toEqual([
      {
        timestamp: expect.any(String),
        model: configuredModel,
      },
      {
        timestamp: expect.any(String),
        model: DEFAULT_MODEL,
      },
    ]);
  });
});

describe("Flue model resolution", () => {
  beforeEach(() => {
    resetModelsForTests();
    setProvider(openrouterProvider());
    setProvider(openaiProvider());
  });

  afterEach(resetModelsForTests);

  test("resolves the default model through the installed provider catalog", () => {
    expect(resolveModel(DEFAULT_MODEL)).toMatchObject({
      id: "openai/gpt-6-luna",
      provider: "openrouter",
    });
  });

  test("resolves a configured OpenAI model through the installed provider catalog", () => {
    expect(resolveModel("openai/gpt-5.5")).toMatchObject({
      id: "gpt-5.5",
      provider: "openai",
    });
  });
});
