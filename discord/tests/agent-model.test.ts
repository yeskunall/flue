import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type {
  ResponseStartContext,
  useModel,
  useResponseStart,
} from "@flue/runtime";
import {
  resetModelsForTests,
  resolveModel,
  setProvider,
} from "@flue/runtime/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MODEL, DiscordAnalyst } from "#/agents/analyst/agent.ts";
import type getDiscordReader from "#/discord/client";

const hooks = vi.hoisted(() => ({
  useDiscordTools: vi.fn<(reader: unknown) => void>(),
  useModel: vi.fn<typeof useModel>(),
  useResponseStart: vi.fn<typeof useResponseStart>(),
}));

vi.mock(import("@flue/runtime"), () => ({
  useModel: hooks.useModel,
  useResponseStart: hooks.useResponseStart,
}));

vi.mock(import("#/agents/analyst/tools/discord.ts"), () => ({
  default: hooks.useDiscordTools,
}));

vi.mock(import("#/discord/client"), () => ({
  default: () => ({}) as ReturnType<typeof getDiscordReader>,
}));

const originalModel = process.env.MODEL;

describe("discord analyst model selection", () => {
  // oxlint-disable-next-line vitest/no-hooks
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MODEL;
  });

  // oxlint-disable-next-line vitest/no-hooks
  afterEach(() => {
    if (originalModel === undefined) {
      delete process.env.MODEL;
    } else {
      process.env.MODEL = originalModel;
    }
  });

  it("passes the trimmed MODEL or default model to both runtime hooks", () => {
    expect.hasAssertions();
    const configuredModel = "openai/gpt-5.5";
    process.env.MODEL = ` ${configuredModel} `;

    // This named component is invoked as a function, not as a constructor.
    // oxlint-disable-next-line new-cap
    DiscordAnalyst();

    delete process.env.MODEL;
    // oxlint-disable-next-line new-cap
    DiscordAnalyst();

    expect(hooks.useModel.mock.calls).toStrictEqual([
      [configuredModel, { thinkingLevel: "low" }],
      [DEFAULT_MODEL, { thinkingLevel: "low" }],
    ]);
    expect(
      hooks.useResponseStart.mock.calls.map(([createMetadata]) =>
        createMetadata({} as ResponseStartContext),
      ),
    ).toStrictEqual([
      {
        model: configuredModel,
        timestamp: expect.any(String),
      },
      {
        model: DEFAULT_MODEL,
        timestamp: expect.any(String),
      },
    ]);
  });
});

describe("Flue model resolution", () => {
  // oxlint-disable-next-line vitest/no-hooks
  beforeEach(() => {
    resetModelsForTests();
    setProvider(openrouterProvider());
    setProvider(openaiProvider());
  });

  // oxlint-disable-next-line vitest/no-hooks
  afterEach(resetModelsForTests);

  it("resolves the default model through the installed provider catalog", () => {
    expect.hasAssertions();
    expect(resolveModel(DEFAULT_MODEL)).toMatchObject({
      id: "openai/gpt-6-luna",
      provider: "openrouter",
    });
  });

  it("resolves a configured OpenAI model through the installed provider catalog", () => {
    expect.hasAssertions();
    expect(resolveModel("openai/gpt-5.5")).toMatchObject({
      id: "gpt-5.5",
      provider: "openai",
    });
  });
});
