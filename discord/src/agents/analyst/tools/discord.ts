import { useTool } from "@flue/runtime";
import * as v from "valibot";

import { createMemberLookupTool } from "#/agents/analyst/tools/members.ts";
import type { DiscordReader } from "#/discord";

const recentDays = v.optional(
  v.pipe(
    v.number("The observation period must be a number of days."),
    v.integer("The observation period must use whole days."),
    v.minValue(1, "The observation period must be at least one day."),
    v.maxValue(30, "Message activity is limited to the most recent 30 days."),
  ),
  7,
);

export function useDiscordTools(reader: DiscordReader): void {
  useTool(createMemberLookupTool(reader));

  useTool({
    name: "get_server_overview",
    description:
      "Fetch the configured Discord server overview, including approximate member and presence counts. The guild is fixed by trusted server configuration and is not an input.",
    input: v.object({}),
    run: () => asToolJson(reader.getServerOverview()),
  });

  useTool({
    name: "get_server_structure",
    description:
      "Fetch channels, categories, roles, and active visible threads for the configured server. Also calculates high-impact permission configurations to review; these are risk indicators, not evidence of abuse.",
    input: v.object({}),
    run: () => asToolJson(reader.getServerStructure()),
  });

  useTool({
    name: "get_message_activity",
    description:
      "Count bot-visible messages by channel over a recent period. Counts are calculations from fetched message timestamps and may be lower bounds when a scan cap is reached.",
    input: v.object({
      days: recentDays,
    }),
    run: ({ data }) => asToolJson(reader.getMessageActivity(data.days)),
  });

  useTool({
    name: "get_inactive_channels",
    description:
      "Find channels whose latest bot-visible message is older than a threshold. This fetches only one latest visible message per channel and reports channels with unavailable history separately.",
    input: v.object({
      inactiveDays: v.optional(
        v.pipe(
          v.number("The inactivity threshold must be a number of days."),
          v.integer("The inactivity threshold must use whole days."),
          v.minValue(1, "The inactivity threshold must be at least one day."),
          v.maxValue(365, "The inactivity threshold is limited to 365 days."),
        ),
        30,
      ),
    }),
    run: ({ data }) =>
      asToolJson(reader.getInactiveChannels(data.inactiveDays)),
  });

  useTool({
    name: "get_upcoming_events",
    description:
      "Fetch upcoming scheduled events visible to the configured bot. Subscriber counts indicate interest, not attendance.",
    input: v.object({}),
    run: () => asToolJson(reader.getUpcomingEvents()),
  });

  useTool({
    name: "get_recent_audit_log",
    description:
      "Fetch recent moderation and administrative actions from the guild audit log. Requires View Audit Log and is limited to Discord’s roughly 45-day retention window.",
    input: v.object({
      days: v.optional(
        v.pipe(
          v.number("The audit period must be a number of days."),
          v.integer("The audit period must use whole days."),
          v.minValue(1, "The audit period must be at least one day."),
          v.maxValue(45, "Discord audit-log history is limited to 45 days."),
        ),
        7,
      ),
    }),
    run: ({ data }) => asToolJson(reader.getRecentAuditLog(data.days)),
  });
}

async function asToolJson(value: Promise<unknown>): Promise<string> {
  return JSON.stringify(await value, null, 2);
}
