import { handleError } from "../utils";
import { SlackClient, type User, type Channel, type Group, type DirectMessageProfiles } from "./SlackClient";
import { useCachedPromise, usePromise } from "@raycast/utils";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createDirectoryUserSearch, directoryUsersToShow, mergeDirectorySearchResults } from "./directory";
import { clearFailedMemberLoad, memberDirectoryRevision, subscribeMemberDirectory } from "./memberDirectoryCache";
import { clearFailedConversationLoad } from "./channelDirectoryCache";
import { workspaceKey } from "./workspaces";
import { inWorkspace } from "./WebClient";
import type { Workspace } from "./workspaces";

export const useChannels = (workspace: Workspace) =>
  usePromise(
    (w: Workspace) =>
      inWorkspace(w, async () => {
        const users = await SlackClient.getUsers();
        const channels = await SlackClient.getChannels();
        const groups = await SlackClient.getGroups(users);
        return [users, channels, groups] as const;
      }),
    [workspace],
    {
      onError(error) {
        handleError(error, "Failed to load channels");
      },
    },
  );

export const useDirectorySearch = (workspace: Workspace, query: string, favoritePeers: string[]) => {
  const [attempt, setAttempt] = useState(0);
  const revision = useSyncExternalStore(subscribeMemberDirectory, () =>
    memberDirectoryRevision(workspaceKey(workspace)),
  );
  const [memberFailure, setMemberFailure] = useState<{ query: string; attempt: number; error: Error }>();
  const userSearchAbortable = useRef<AbortController>(null);
  const channelSearchAbortable = useRef<AbortController>(null);
  const conversationSearchAbortable = useRef<AbortController>(null);
  const [preview, setPreview] = useState<{ query: string; users: User[] }>();

  const [partialChannels, setPartialChannels] = useState<Channel[]>([]);
  const [partialProfiles, setPartialProfiles] = useState<DirectMessageProfiles>({
    names: new Map(),
    apps: new Set(["USLACKBOT"]),
    favoriteUsers: [],
    inactive: new Set(),
  });
  const peerAbortable = useRef<AbortController>(null);
  const [partialGroups, setPartialGroups] = useState<{ query: string; rows: Group[] }>();
  const userSearch = useMemo(
    () =>
      createDirectoryUserSearch(
        () => {
          const signal = userSearchAbortable.current?.signal;
          return inWorkspace(workspace, () =>
            SlackClient.searchDirectoryMembers(
              query,
              signal,
              (matched) => {
                if (signal?.aborted) return;
                setPreview({ query, users: matched });
              },
              (error) => {
                if (!signal?.aborted) setMemberFailure({ query, attempt, error });
              },
            ),
          );
        },
        () => userSearchAbortable.current?.signal,
      ),
    [workspace, query, attempt],
  );

  const users = usePromise(
    (...args: [string, number]) => {
      // Keep the query in the hook arguments so each query starts a fresh execution.
      void args;
      return userSearch.getUsers();
    },
    [query, attempt],
    {
      abortable: userSearchAbortable,
      onError(error) {
        handleError(error, "Failed to search Slack users");
      },
    },
  );
  const peerNames = usePromise(
    ({
      workspace,
      favoritePeers,
    }: {
      workspace: Workspace;
      attempt: number;
      revision: number;
      favoritePeers: string[];
    }) => {
      const signal = peerAbortable.current?.signal;
      return inWorkspace(workspace, () =>
        SlackClient.getDirectMessageProfiles(signal, setPartialProfiles, favoritePeers),
      );
    },
    [{ workspace, attempt, revision, favoritePeers }],
    {
      abortable: peerAbortable,
      onError(error) {
        handleError(error, "Could not load direct message names");
      },
    },
  );
  const channels = usePromise(
    ({ workspace }: { workspace: Workspace; attempt: number; query: string }) => {
      const signal = channelSearchAbortable.current?.signal;
      return inWorkspace(workspace, () =>
        SlackClient.searchConversations("", signal, undefined, "channels", (rows) => {
          if (!signal?.aborted) setPartialChannels(rows);
        }),
      );
    },
    [{ workspace, attempt, query }],
    {
      abortable: channelSearchAbortable,
      onError(error) {
        handleError(error, "Failed to search Slack channels");
      },
    },
  );
  const conversations = usePromise(
    ({ query: searchText }: { query: string; attempt: number }) => {
      const signal = conversationSearchAbortable.current?.signal;
      return inWorkspace(workspace, () =>
        SlackClient.searchConversations(searchText, signal, userSearch.getUserNames, "groups", (_, rows) => {
          if (!signal?.aborted) setPartialGroups({ query: searchText, rows });
        }),
      );
    },
    [{ query, attempt }],
    {
      abortable: conversationSearchAbortable,
      onError(error) {
        handleError(error, "Failed to search Slack conversations");
      },
    },
  );

  const shownUsers = directoryUsersToShow(query, users.isLoading, preview, users.data);

  return {
    data: mergeDirectorySearchResults(shownUsers, [
      (!channels.isLoading && !channels.error ? channels.data?.[0] : undefined) ?? partialChannels,
      (!conversations.isLoading && !conversations.error ? conversations.data?.[1] : undefined) ??
        (partialGroups?.query === query ? partialGroups.rows : []),
    ]),
    peerNames: (peerNames.data ?? partialProfiles).names,
    apps: (peerNames.data ?? partialProfiles).apps,
    favoriteUsers: (peerNames.data ?? partialProfiles).favoriteUsers,
    inactive: (peerNames.data ?? partialProfiles).inactive,
    loadingNames: peerNames.isLoading,
    error:
      peerNames.error ||
      channels.error ||
      conversations.error ||
      users.error ||
      (memberFailure?.query === query && memberFailure.attempt === attempt ? memberFailure.error : undefined),
    retry: () => {
      const key = workspaceKey(workspace);
      clearFailedMemberLoad(key);
      clearFailedConversationLoad(key);
      setAttempt((value) => value + 1);
    },
    isLoading: peerNames.isLoading || users.isLoading || channels.isLoading || conversations.isLoading,
  };
};

export const useUnreadConversations = (workspace: Workspace, conversationIds: string[] | undefined) =>
  useCachedPromise(
    (w: Workspace, ids: string[]) => inWorkspace(w, () => SlackClient.getUnreadConversations(ids)),
    [workspace, conversationIds ?? []],
    {
      onError(error) {
        handleError(error, "Failed to load unread messages");
      },
    },
  );
