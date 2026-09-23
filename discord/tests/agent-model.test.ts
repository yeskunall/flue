import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  useModel: vi.fn<(model: string, options: { thinkingLevel: "low" }) => void>(),
  useResponseStart:
    vi.fn<(callback: () => { timestamp: string; model: string }) => void>(),
  useDiscordTools: vi.fn<(reader: unknown) => void>(),
  getDiscordReader: vi.fn<() => object>(() => ({})),
}));

vi.mock("@flue/runtime", () => ({
  useModel: hooks.useModel,
  useResponseStart: hooks.useResponseStart,
}));

vi.mock("#/agents/analyst/tools/discord.ts", () => ({
  useDiscordTools: hooks.useDiscordTools,
}));

vi.mock("#/discord/client", () => ({
  getDiscordReader: hooks.getDiscordReader,
}));

import { DiscordAnalyst } from "#/agents/analyst/agent.ts";

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

function getResponseMetadata() {
  const [createMetadata] = hooks.useResponseStart.mock.calls[0] as [
    () => { timestamp: string; model: string },
  ];
  return createMetadata();
}

describe("Discord analyst model selection", () => {
  test("uses the configured model for requests and response metadata", () => {
    process.env.MODEL = "  openrouter/moonshotai/kimi-k2.6  ";

    DiscordAnalyst();

    expect(hooks.useModel).toHaveBeenCalledWith(
      "openrouter/moonshotai/kimi-k2.6",
      { thinkingLevel: "low" },
    );
    expect(getResponseMetadata()).toMatchObject({
      model: "openrouter/moonshotai/kimi-k2.6",
      timestamp: expect.any(String),
    });
  });

  test("defaults to GPT-6 Luna when no model is configured", () => {
    DiscordAnalyst();

    expect(hooks.useModel).toHaveBeenCalledWith(
      "openrouter/openai/gpt-6-luna",
      {
        thinkingLevel: "low",
      },
    );
    expect(getResponseMetadata().model).toBe("openrouter/openai/gpt-6-luna");
  });

  test("re-reads the selection on each render for the next submission", () => {
    process.env.MODEL = "openrouter/openai/gpt-6-luna";
    DiscordAnalyst();

    process.env.MODEL = "openai/gpt-5.5";
    DiscordAnalyst();

    expect(hooks.useModel.mock.calls.map(([model]) => model)).toEqual([
      "openrouter/openai/gpt-6-luna",
      "openai/gpt-5.5",
    ]);
  });
});
