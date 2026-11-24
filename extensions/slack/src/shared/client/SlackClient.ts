import { Icon, Image } from "@raycast/api";
import { withCache } from "@raycast/utils";
import { incomingTimestamp } from "./conversationOrder";
import { memberDirectoryFreshMs } from "./memberDirectoryRefresh";
import { handleError } from "../utils";
import { getWorkspace, getSlackWebClient, inWorkspace } from "./WebClient";
import { workspaceKey, type Workspace } from "./workspaces";
import type { SlackMember } from "./slackTypes";
import { formatRelative } from "date-fns";
import { Profile } from "@slack/web-api/dist/types/response/UsersProfileGetResponse";
import { collectPaginatedResults } from "./pagination";
import { getDirectorySearchPageSize } from "./directory";
import { searchConversationDirectory, searchUserNames } from "./conversationSearch";
import { directoryConversation, toChannel, toGroup } from "./conversation";
import type { Channel, Group } from "./conversation";
import { isMemberDirectoryScanError, memberSearchFields, searchMemberDirectory } from "./memberSearch";
import { isAppMember, memberDisplayName, toUserName } from "./member";
import { getMemberPage } from "./memberDirectoryCache";
import { getConversationPage, getMemberChannelPage } from "./channelDirectoryCache";
import type { ConversationPage, ConversationPageOptions } from "./channelDirectoryCache";

export type { Channel, Group } from "./conversation";

interface Item {
  id: string;
  teamId: string;
  name: string;
  icon: Image.ImageLike;
}

export interface User extends Item {
  username: string;
  conversationId: string | undefined;
  title: string;
  statusEmoji: string | undefined;
  statusText: string | undefined;
  statusExpiration: string;
  timezone: string;
  icon: string | { source: string; mask: Image.Mask };
}

export type PresenceStatus = "online" | "offline" | "forced-offline";
export interface SnoozeStatus {
  nextDndEnd: Date | undefined;
  snoozeEnd: Date | undefined;
}

export type FavoriteUser = User & { searchFields: Array<string | undefined> };

export interface DirectMessageProfiles {
  names: ReadonlyMap<string, string>;
  apps: ReadonlySet<string>;
  inactive: ReadonlySet<string>;
  favoriteUsers: FavoriteUser[];
}

export interface Message {
  receivedAt: Date;
  message: string;
  senderId: string;
  incoming?: boolean;
}
export interface UnreadChannelInfo {
  conversationId: string;
  directUserId?: string;
  messageHistory: Message[];
}

const sortNames = (a: string, b: string) => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

const pageSize = 200;
const maxSearchResultsPerType = 100;

function toUser(member: SlackMember): User | undefined {
  const { id, name: username, profile, team_id: teamId, tz } = member;
  const userName = toUserName(member);

  if (!id || !userName || !teamId) return undefined;
  const [, displayName] = userName;

  let statusExpiration = "";
  if (profile?.status_expiration) {
    const date = new Date(profile.status_expiration * 1000);
    if (!isNaN(date.getTime())) {
      statusExpiration = `Until ${formatRelative(date, new Date(), { weekStartsOn: 1 })}`;
    }
  }

  return {
    id,
    name: displayName,
    icon: profile?.image_24 ? { source: profile.image_24, mask: Image.Mask.Circle } : Icon.Person,
    teamId,
    username: username ?? "",
    title: profile?.title ?? "",
    statusEmoji: profile?.status_emoji || undefined,
    statusText: profile?.status_text?.replace(/&amp;/g, "&") || undefined,
    statusExpiration,
    conversationId: undefined,
    timezone: tz ?? "",
  };
}

/**
 * Member pages come from a shared, cached users.list scan. The cursor is the index of the next cached page, so a
 * search can start reading matches while later pages are still loading.
 */
const createMemberPageLoader = () => async (cursor?: string) => {
  const slackWebClient = getSlackWebClient();
  const index = Number(cursor ?? 0);
  const page = await getMemberPage(
    workspaceKey(getWorkspace()),
    async (nextCursor) => {
      const response = await slackWebClient.users.list({
        team_id: getWorkspace().teamId,
        limit: getDirectorySearchPageSize(),
        cursor: nextCursor,
      });
      return { items: response.members ?? [], nextCursor: response.response_metadata?.next_cursor };
    },
    index,
  );
  return {
    items: page.items,
    nextCursor: page.hasMore ? String(index + 1) : undefined,
    error: page.error,
  };
};

function toConversationCursorPage(page: ConversationPage, index: number) {
  return {
    items: page.items,
    nextCursor: page.hasMore ? String(index + 1) : undefined,
    error: page.error,
    savedAt: page.savedAt,
  };
}

/**
 * Channel pages come from a shared, cached conversations.list scan. The cursor is the page index, so a search can
 * filter locally as pages arrive instead of restarting a full directory walk on each keystroke.
 */
export async function loadConversationDirectoryPage(
  cursor?: string,
  options?: ConversationPageOptions,
  slackWebClient = getSlackWebClient(),
) {
  const index = Number(cursor ?? 0);
  const page = await getConversationPage(
    workspaceKey(getWorkspace()),
    async (nextCursor) => {
      const response = await slackWebClient.conversations.list({
        team_id: getWorkspace().teamId,
        exclude_archived: true,
        types: "public_channel,private_channel,mpim,im",
        limit: getDirectorySearchPageSize(),
        cursor: nextCursor,
      });
      return {
        items: (response.channels ?? []).map((c) => directoryConversation(c, getWorkspace().teamId)),
        nextCursor: response.response_metadata?.next_cursor,
      };
    },
    index,
    options,
  );
  return toConversationCursorPage(page, index);
}

/** Pages of the channels the signed-in user belongs to, from a shared, cached users.conversations scan. */
export async function loadMemberChannelDirectoryPage(cursor?: string) {
  const slackWebClient = getSlackWebClient();
  const index = Number(cursor ?? 0);
  const page = await getMemberChannelPage(
    workspaceKey(getWorkspace()),
    async (nextCursor) => {
      const response = await slackWebClient.users.conversations({
        team_id: getWorkspace().teamId,
        exclude_archived: true,
        types: "public_channel,private_channel",
        limit: getDirectorySearchPageSize(),
        cursor: nextCursor,
      });
      return {
        items: (response.channels ?? []).map((c) => directoryConversation(c, getWorkspace().teamId)),
        nextCursor: response.response_metadata?.next_cursor,
      };
    },
    index,
  );
  return toConversationCursorPage(page, index);
}

// Some Slack Connect peers are visible in DMs but absent from this workspace's users.list.
const lookupDirectMessageProfile = withCache(
  async (workspace: Workspace, user: string) =>
    inWorkspace(workspace, async () => {
      try {
        const { user: member } = await getSlackWebClient().users.info({ user });
        return member?.id === user
          ? { name: memberDisplayName(member), app: isAppMember(member), inactive: !!member.deleted }
          : null;
      } catch (error) {
        const code = (error as { data?: { error?: string } })?.data?.error;
        if (
          code === "access_denied" ||
          code === "user_not_found" ||
          code === "user_not_visible" ||
          code === "users_not_found"
        )
          return null;
        throw error;
      }
    }),
  { maxAge: memberDirectoryFreshMs },
);

export class SlackClient {
  public static async getUsers(): Promise<User[]> {
    return (await SlackClient.getUsersWithApps()).users;
  }

  public static async getUsersWithApps() {
    const apps = new Map([["USLACKBOT", "Slackbot"]]);
    const imPeers = new Map<string, string>();
    const slackWebClient = getSlackWebClient();
    const users = await collectPaginatedResults({
      loadPage: async (cursor) => {
        const response = await slackWebClient.users.list({ team_id: getWorkspace().teamId, limit: pageSize, cursor });
        const members = response.members ?? [];
        for (const member of members)
          if (member.id && isAppMember(member)) apps.set(member.id, memberDisplayName(member) ?? member.id);
        return { items: members, nextCursor: response.response_metadata?.next_cursor };
      },
      transform: toUser,
      matches: () => true,
      maxResults: Number.POSITIVE_INFINITY,
      scanAllPages: true,
    });

    const usersById = new Map(users.map((user) => [user.id, user]));
    let cursor: string | undefined;
    do {
      const response = await slackWebClient.conversations.list({
        team_id: getWorkspace().teamId,
        exclude_archived: true,
        types: "im",
        limit: pageSize,
        cursor,
      });
      for (const conversation of response.channels ?? []) {
        if (conversation.id && conversation.user) imPeers.set(conversation.id, conversation.user);
        const user = conversation.user ? usersById.get(conversation.user) : undefined;
        if (user) user.conversationId = conversation.id;
      }
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return { users: users.sort((a, b) => sortNames(a.name, b.name)), usersById, apps, imPeers };
  }

  public static async getChannels(): Promise<Channel[]> {
    const slackWebClient = getSlackWebClient();
    const channels = await collectPaginatedResults({
      loadPage: async (cursor) => {
        const response = await slackWebClient.conversations.list({
          team_id: getWorkspace().teamId,
          exclude_archived: true,
          types: "public_channel,private_channel",
          limit: pageSize,
          cursor,
        });
        return {
          items: (response.channels ?? []).map((c) => directoryConversation(c, getWorkspace().teamId)),
          nextCursor: response.response_metadata?.next_cursor,
        };
      },
      transform: toChannel,
      matches: () => true,
      maxResults: Number.POSITIVE_INFINITY,
      scanAllPages: true,
    });

    return channels.sort((a, b) => sortNames(a.name, b.name));
  }

  public static async getGroups(users: User[]): Promise<Group[]> {
    const slackWebClient = getSlackWebClient();
    const userNames = new Map(users.map((user) => [user.username, user.name]));
    const groups = await collectPaginatedResults({
      loadPage: async (cursor) => {
        const response = await slackWebClient.conversations.list({
          team_id: getWorkspace().teamId,
          exclude_archived: true,
          types: "mpim",
          limit: pageSize,
          cursor,
        });
        return {
          items: (response.channels ?? []).map((c) => directoryConversation(c, getWorkspace().teamId)),
          nextCursor: response.response_metadata?.next_cursor,
        };
      },
      transform: (conversation) => toGroup(conversation, userNames),
      matches: () => true,
      maxResults: Number.POSITIVE_INFINITY,
      scanAllPages: true,
    });

    return groups.sort((a, b) => sortNames(a.name, b.name));
  }

  public static async getDirectMessageProfiles(
    signal: AbortSignal | undefined,
    onPage: (profiles: DirectMessageProfiles) => void,
    favoritePeers: readonly string[] = [],
  ) {
    const names = new Map<string, string>();
    const apps = new Set(["USLACKBOT"]);
    const inactive = new Set<string>();
    const favoriteIds = new Set(favoritePeers);
    const favoriteUsers: FavoriteUser[] = [];
    const snapshot = () => ({
      names: new Map(names),
      apps: new Set(apps),
      inactive: new Set(inactive),
      favoriteUsers: [...favoriteUsers],
    });
    const load = createMemberPageLoader();
    let cursor: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await load(cursor);
      signal?.throwIfAborted();
      for (const member of page.items) {
        const name = memberDisplayName(member);
        if (member.id && name) names.set(member.id, name);
        if (member.id && favoriteIds.has(member.id)) {
          const user = toUser(member);
          if (user) favoriteUsers.push({ ...user, searchFields: memberSearchFields(member, user.name) });
        }
        if (member.id && member.deleted) inactive.add(member.id);
        if (member.id && isAppMember(member)) apps.add(member.id);
      }
      cursor = page.nextCursor;
      if (cursor || page.error) onPage(snapshot());
      if (page.error) throw page.error;
    } while (cursor);
    onPage(snapshot());
    const visited = new Set<string>();
    do {
      signal?.throwIfAborted();
      const page = await loadConversationDirectoryPage(cursor);
      for (const dm of page.items) {
        signal?.throwIfAborted();
        if (!dm.is_im || !dm.user || names.has(dm.user) || visited.has(dm.user)) continue;
        visited.add(dm.user);
        const profile = await lookupDirectMessageProfile(getWorkspace(), dm.user);
        signal?.throwIfAborted();
        if (profile) {
          if (profile.name) names.set(dm.user, profile.name);
          if (profile.app) apps.add(dm.user);
          if (profile.inactive) inactive.add(dm.user);
          onPage(snapshot());
        }
      }
      if (page.error) throw page.error;
      cursor = page.nextCursor;
    } while (cursor);
    return snapshot();
  }

  public static async searchUsers(query: string, signal?: AbortSignal): Promise<User[]> {
    return (await SlackClient.searchDirectoryMembers(query, signal)).users;
  }

  public static async searchDirectoryMembers(
    query: string,
    signal?: AbortSignal,
    onUsers?: (users: User[]) => void,
    onPartialError?: (error: Error) => void,
  ) {
    const finish = (result: { users: User[]; userNames: ReadonlyMap<string, string> }) => {
      result.users.sort((a, b) => sortNames(a.name, b.name));
      return result;
    };
    try {
      return finish(
        await searchMemberDirectory({
          query,
          maxResults: maxSearchResultsPerType,
          toUser,
          loadPage: createMemberPageLoader(),
          signal,
          onProgress: (partial) => {
            onUsers?.([...partial.users].sort((a, b) => sortNames(a.name, b.name)));
          },
        }),
      );
    } catch (error) {
      if (!isMemberDirectoryScanError<User>(error)) throw error;
      if (onPartialError)
        onPartialError(error.failure instanceof Error ? error.failure : new Error(String(error.failure)));
      else await handleError(error.failure, "Could not load the full member directory");
      return finish(error.partial);
    }
  }

  public static async searchConversations(
    query: string,
    signal?: AbortSignal,
    loadUserNames?: () => Promise<ReadonlyMap<string, string>>,
    types: "channels" | "groups" | "all" = "all",
    onPage?: (channels: Channel[], groups: Group[]) => void,
  ): Promise<[Channel[], Group[]]> {
    const [channels, groups] = await searchConversationDirectory({
      query,
      maxResultsPerType: Infinity,
      onPage,
      scanAllPages: true,
      types,
      loadUserNames:
        loadUserNames ??
        (async () => {
          try {
            return await searchUserNames({
              query,
              maxResults: maxSearchResultsPerType,
              loadPage: createMemberPageLoader(),
              signal,
            });
          } catch (error) {
            if (!isMemberDirectoryScanError(error)) throw error;
            await handleError(error.failure, "Could not load the full member directory");
            return error.partial.userNames;
          }
        }),
      loadConversationsPage: (cursor) => loadConversationDirectoryPage(cursor),
      signal,
    });

    return [channels.sort((a, b) => sortNames(a.name, b.name)), groups.sort((a, b) => sortNames(a.name, b.name))];
  }

  public static async getPresence(): Promise<PresenceStatus> {
    const slackWebClient = getSlackWebClient();

    const presence = await slackWebClient.users.getPresence({});

    if (presence.manual_away) {
      return "forced-offline";
    }

    return presence.presence === "away" ? "offline" : "online";
  }

  public static async setPresence(status: "away" | "auto"): Promise<void> {
    const slackWebClient = getSlackWebClient();

    await slackWebClient.users.setPresence({ presence: status });
  }

  public static async getSnoozeStatus(): Promise<SnoozeStatus> {
    const slackWebClient = getSlackWebClient();

    const dndInfo = await slackWebClient.dnd.info({});
    const snooze_endtime = (dndInfo as unknown as { snooze_endtime: number | undefined }).snooze_endtime;

    const nextDndEnd = dndInfo.next_dnd_end_ts ? new Date(dndInfo.next_dnd_end_ts * 1000) : undefined;
    const snoozeEnd = snooze_endtime ? new Date(snooze_endtime * 1000) : undefined;
    return { nextDndEnd, snoozeEnd };
  }

  public static async setSnooze(minutes: number): Promise<void> {
    const slackWebClient = getSlackWebClient();

    await slackWebClient.dnd.setSnooze({ num_minutes: minutes });
  }

  public static async endSnooze(): Promise<void> {
    const slackWebClient = getSlackWebClient();

    await slackWebClient.dnd.endSnooze({});
  }

  public static async getUnreadConversations(conversationIds: string[]) {
    const slackWebClient = getSlackWebClient();

    if (conversationIds.length > 30) {
      throw new Error("Too many conversations");
    }

    const histories = await Promise.allSettled(
      conversationIds.map(async (id) => {
        const info = await slackWebClient.conversations.info({ channel: id });
        const oldest = info.channel?.last_read;
        if (!oldest || !/^\d+(\.\d+)?$/.test(oldest)) throw new Error("Conversation read marker is unavailable");
        const { messages } = await slackWebClient.conversations.history({ channel: id, oldest });
        const messageHistory: Message[] = (messages ?? []).flatMap((m) => {
          const text =
            m.text && m.text !== "This content can't be displayed."
              ? m.text
              : m.blocks?.map((block) => block.text?.text).join("\n\n\n\n\n\n\n\n");
          const senderId = m.user ?? m.bot_id;
          if (!m.ts || !text || !senderId) return [];
          return [
            {
              receivedAt: new Date(Number(m.ts) * 1000),
              message: text,
              senderId,
              incoming: !!incomingTimestamp(m, getWorkspace().userId),
            },
          ];
        });
        const channel = info.channel;
        const directUserId =
          channel && "user" in channel && typeof channel.user === "string" ? channel.user : undefined;
        return { conversationId: id, directUserId, messageHistory };
      }),
    );
    const failed = conversationIds.filter((_, i) => histories[i].status === "rejected");
    const unreadConversations = histories
      .flatMap((result) => (result.status === "fulfilled" && result.value.messageHistory.length ? [result.value] : []))
      .sort(
        (a, b) =>
          new Date(b.messageHistory[0].receivedAt).getTime() - new Date(a.messageHistory[0].receivedAt).getTime(),
      );

    return { conversations: unreadConversations, failed };
  }

  public static async markAsRead(conversationId: string): Promise<void> {
    const slackWebClient = getSlackWebClient();

    await slackWebClient.conversations.mark({ channel: conversationId, ts: `${new Date().getTime() / 1000}` });
  }

  public static async getMe() {
    const slackWebClient = getSlackWebClient();

    const authResponse = await slackWebClient.auth.test();

    const id = authResponse.user_id;
    const username = authResponse.user;
    const teamId = authResponse.team_id;
    return { id, username, teamId };
  }

  public static async getUserProfileById(userId: string): Promise<Profile> {
    const slackWebClient = getSlackWebClient();
    const result = await slackWebClient.users.profile.get({
      user: userId,
    });

    if (!result.profile) {
      throw new Error(`${userId} does not have a profile.`);
    }

    return result.profile;
  }

  public static async getWorkspaceEmojis() {
    const slackWebClient = getSlackWebClient();
    const { emoji: rawEmojis } = await slackWebClient.emoji.list();

    if (!rawEmojis) {
      return {};
    }

    const resolveAlias = (name: string, visited = new Set()): string | null => {
      if (visited.has(name)) return null;

      const value = rawEmojis[name];
      if (!value) return null;

      return value.startsWith("alias:")
        ? resolveAlias(value.replace("alias:", ""), new Set([...visited, name]))
        : value;
    };

    return Object.fromEntries(
      Object.keys(rawEmojis)
        .map((key) => [key, resolveAlias(key)] as const)
        .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => [`:${key}:`, value] as const),
    );
  }

  public static async setStatus({
    statusText,
    emoji,
    expiration,
    originProfile,
  }: {
    statusText?: string;
    emoji?: string;
    expiration?: number;
    originProfile?: Profile;
  }) {
    const slackWebClient = getSlackWebClient();

    const profile = {
      status_text: originProfile?.status_text,
      status_emoji: originProfile?.status_emoji,
      status_expiration: originProfile?.status_expiration,
    };

    if (statusText !== undefined) {
      profile.status_text = statusText;
    }

    if (emoji !== undefined) {
      profile.status_emoji = emoji;
    }

    if (expiration !== undefined) {
      profile.status_expiration = expiration;
    }

    const result = await slackWebClient.users.profile.set({
      profile: profile,
    });

    return result.profile;
  }
}
