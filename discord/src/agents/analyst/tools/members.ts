import { defineTool } from "@flue/runtime";

import { memberRoleFilterSchema } from "#/discord";
import type { DiscordReader } from "#/discord";

export function createMemberLookupTool(
  reader: Pick<DiscordReader, "getMembersByRoles">,
) {
  return defineTool({
    name: "get_members_by_roles",
    description: [
      "Find current members of the configured Discord server by role names, IDs, or role mentions.",
      "allOf: must have EVERY listed role; anyOf: must have at least ONE listed role when nonempty;",
      "noneOf: must have NONE of the listed roles. All three conditions are combined with AND.",
      'Example: with Verified and Staff but without Muted means allOf=["Verified","Staff"], noneOf=["Muted"].',
      'Example: either Verified or Staff means anyOf=["Verified","Staff"].',
      "For only humans or only bots set memberType; otherwise include both.",
      "Use @everyone explicitly to list all members, or noneOf alone to find members missing roles.",
      "Requires Server Members (GUILD_MEMBERS) intent. No other guild or credentials can be supplied.",
      "Returns the matching-member count and at most 25 preview members. The preview limit does not limit the count.",
      "If previewTruncated is true, the preview is not the full member list. No export file is created.",
      "Use status and matchedCountIsLowerBound to distinguish a complete lookup from a partial scan.",
      "Unknown or ambiguous roles require clarification, not guessing.",
    ].join(" "),
    input: memberRoleFilterSchema,
    async run({ data, signal }) {
      const result = await reader.getMembersByRoles(data, signal);
      const { members, ...summary } = result;
      return JSON.stringify(
        {
          ...summary,
          membersPreview: members.slice(0, 25),
          previewTruncated: members.length > 25,
          matchedCountIsLowerBound: result.status === "partial",
        },
        null,
        2,
      );
    },
  });
}
