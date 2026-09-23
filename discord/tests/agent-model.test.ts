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

const originalModel = process.env.DISCORD_ANALYST_MODEL;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DISCORD_ANALYST_MODEL;
});

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.DISCORD_ANALYST_MODEL;
  } else {
    process.env.DISCORD_ANALYST_MODEL = originalModel;
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
    process.env.DISCORD_ANALYST_MODEL = "  openrouter/moonshotai/kimi-k2.6  ";

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

  test("defaults to Claude Haiku when no model is configured", () => {
    DiscordAnalyst();

    expect(hooks.useModel).toHaveBeenCalledWith("anthropic/claude-haiku-4-5", {
      thinkingLevel: "low",
    });
    expect(getResponseMetadata().model).toBe("anthropic/claude-haiku-4-5");
  });

  test("re-reads the selection on each render for the next submission", () => {
    process.env.DISCORD_ANALYST_MODEL = "anthropic/claude-haiku-4-5";
    DiscordAnalyst();

    process.env.DISCORD_ANALYST_MODEL = "openai/gpt-5.5";
    DiscordAnalyst();

    expect(hooks.useModel.mock.calls.map(([model]) => model)).toEqual([
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5.5",
    ]);
  });
});
