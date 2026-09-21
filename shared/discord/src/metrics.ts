import { PermissionFlagsBits } from "discord-api-types/v10";

export interface ObservationPeriod {
  start: string;
  end: string;
}

export interface ScannedMessage {
  id: string;
  timestamp: string;
}

export type ChannelMessageScan =
  | {
      channelId: string;
      channelName: string;
      status: "complete" | "capped";
      messages: ScannedMessage[];
    }
  | {
      channelId: string;
      channelName: string;
      status: "unavailable";
      messages: [];
      reason: string;
    };

export interface UnavailableChannel {
  channelId: string;
  channelName: string;
  reason: string;
}

export interface MessageActivity {
  visibleMessageCount: number;
  ranking: Array<{
    channelId: string;
    channelName: string;
    visibleMessageCount: number;
    countIsLowerBound: boolean;
  }>;
  cappedChannels: string[];
  unavailableChannels: UnavailableChannel[];
}

export type LatestMessageObservation =
  | {
      channelId: string;
      channelName: string;
      status: "available";
      latestVisibleMessageAt: string | null;
    }
  | {
      channelId: string;
      channelName: string;
      status: "unavailable";
      reason: string;
    };

export interface InactiveChannels {
  inactive: Array<{
    channelId: string;
    channelName: string;
    latestVisibleMessageAt: string;
    inactiveForDays: number;
  }>;
  noVisibleMessages: Array<{
    channelId: string;
    channelName: string;
  }>;
  activeChannelCount: number;
  unavailableChannels: UnavailableChannel[];
}

interface RiskRole {
  id: string;
  name: string;
  permissions: string;
  managed: boolean;
}

interface RiskChannel {
  id: string;
  name: string;
  type: number;
  permission_overwrites?: Array<{
    id: string;
    type: number;
    allow: string;
    deny: string;
  }>;
}

export interface PermissionRisk {
  severity: "high" | "medium";
  subjectType: "role" | "channel";
  subjectId: string;
  subjectName: string;
  permission: string;
  explanation: string;
}

const MILLISECONDS_PER_DAY = 86_400_000;

const ROLE_RISK_PERMISSIONS: ReadonlyArray<{
  flag: bigint;
  name: string;
  severity: PermissionRisk["severity"];
}> = [
  {
    flag: PermissionFlagsBits.Administrator,
    name: "Administrator",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.ManageGuild,
    name: "ManageGuild",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.ManageRoles,
    name: "ManageRoles",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.ManageChannels,
    name: "ManageChannels",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.ManageWebhooks,
    name: "ManageWebhooks",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.BanMembers,
    name: "BanMembers",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.KickMembers,
    name: "KickMembers",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.ModerateMembers,
    name: "ModerateMembers",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.ManageMessages,
    name: "ManageMessages",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.ManageThreads,
    name: "ManageThreads",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.ManageEvents,
    name: "ManageEvents",
    severity: "high",
  },
  {
    flag: PermissionFlagsBits.MentionEveryone,
    name: "MentionEveryone",
    severity: "medium",
  },
  {
    flag: PermissionFlagsBits.ViewAuditLog,
    name: "ViewAuditLog",
    severity: "medium",
  },
];

const CHANNEL_RISK_PERMISSIONS = ROLE_RISK_PERMISSIONS.filter(
  ({ name }) =>
    name === "ManageChannels"
    || name === "ManageWebhooks"
    || name === "ManageMessages"
    || name === "MentionEveryone",
);

export function calculateMessageActivity(
  scans: readonly ChannelMessageScan[],
  period: ObservationPeriod,
): MessageActivity {
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  const ranking: MessageActivity["ranking"] = [];
  const cappedChannels: string[] = [];
  const unavailableChannels: UnavailableChannel[] = [];
  let visibleMessageCount = 0;

  for (const scan of scans) {
    if (scan.status === "unavailable") {
      unavailableChannels.push({
        channelId: scan.channelId,
        channelName: scan.channelName,
        reason: scan.reason,
      });
      continue;
    }

    const count = scan.messages.reduce((total, message) => {
      const timestamp = Date.parse(message.timestamp);
      return timestamp >= start && timestamp <= end ? total + 1 : total;
    }, 0);
    visibleMessageCount += count;
    if (scan.status === "capped") cappedChannels.push(scan.channelName);
    ranking.push({
      channelId: scan.channelId,
      channelName: scan.channelName,
      visibleMessageCount: count,
      countIsLowerBound: scan.status === "capped",
    });
  }

  ranking.sort(
    (left, right) =>
      right.visibleMessageCount - left.visibleMessageCount
      || left.channelName.localeCompare(right.channelName),
  );

  return {
    visibleMessageCount,
    ranking,
    cappedChannels,
    unavailableChannels,
  };
}

export function calculateInactiveChannels(
  observations: readonly LatestMessageObservation[],
  options: { observedAt: string; thresholdDays: number },
): InactiveChannels {
  const observedAt = Date.parse(options.observedAt);
  const inactive: InactiveChannels["inactive"] = [];
  const noVisibleMessages: InactiveChannels["noVisibleMessages"] = [];
  const unavailableChannels: UnavailableChannel[] = [];
  let activeChannelCount = 0;

  for (const observation of observations) {
    if (observation.status === "unavailable") {
      unavailableChannels.push({
        channelId: observation.channelId,
        channelName: observation.channelName,
        reason: observation.reason,
      });
      continue;
    }
    if (observation.latestVisibleMessageAt === null) {
      noVisibleMessages.push({
        channelId: observation.channelId,
        channelName: observation.channelName,
      });
      continue;
    }

    const inactiveForDays = Math.floor(
      (observedAt - Date.parse(observation.latestVisibleMessageAt))
        / MILLISECONDS_PER_DAY,
    );
    if (inactiveForDays >= options.thresholdDays) {
      inactive.push({
        channelId: observation.channelId,
        channelName: observation.channelName,
        latestVisibleMessageAt: observation.latestVisibleMessageAt,
        inactiveForDays,
      });
    } else {
      activeChannelCount += 1;
    }
  }

  inactive.sort(
    (left, right) =>
      right.inactiveForDays - left.inactiveForDays
      || left.channelName.localeCompare(right.channelName),
  );

  return {
    inactive,
    noVisibleMessages,
    activeChannelCount,
    unavailableChannels,
  };
}

export function assessPermissionRisks(input: {
  guildId: string;
  roles: readonly RiskRole[];
  channels: readonly RiskChannel[];
}): PermissionRisk[] {
  const risks: PermissionRisk[] = [];

  for (const role of input.roles) {
    if (role.managed) continue;
    const permissions = BigInt(role.permissions);
    for (const riskPermission of ROLE_RISK_PERMISSIONS) {
      if (!hasPermission(permissions, riskPermission.flag)) continue;
      const isEveryone = role.id === input.guildId;
      risks.push({
        severity:
          isEveryone && riskPermission.severity === "high"
            ? "high"
            : riskPermission.severity,
        subjectType: "role",
        subjectId: role.id,
        subjectName: role.name,
        permission: riskPermission.name,
        explanation: isEveryone
          ? "The @everyone role grants a high-impact permission to every server member."
          : riskPermission.name === "Administrator"
            ? "This assignable role bypasses channel-specific permission checks. Review who can receive it."
            : "This assignable role grants a high-impact server permission. Review who can receive it.",
      });
    }
  }

  for (const channel of input.channels) {
    const everyoneOverwrite = channel.permission_overwrites?.find(
      overwrite => overwrite.type === 0 && overwrite.id === input.guildId,
    );
    if (!everyoneOverwrite) continue;
    const allowed = BigInt(everyoneOverwrite.allow);
    for (const riskPermission of CHANNEL_RISK_PERMISSIONS) {
      if (!hasPermission(allowed, riskPermission.flag)) continue;
      risks.push({
        severity: riskPermission.severity,
        subjectType: "channel",
        subjectId: channel.id,
        subjectName: channel.name,
        permission: riskPermission.name,
        explanation:
          "The @everyone channel override grants a high-impact permission to every server member.",
      });
    }
  }

  const severityOrder = { high: 0, medium: 1 } as const;
  return risks.toSorted(
    (left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity],
  );
}

function hasPermission(permissions: bigint, flag: bigint): boolean {
  return (permissions & flag) === flag;
}
