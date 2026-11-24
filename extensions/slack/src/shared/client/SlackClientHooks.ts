import { handleError } from "../utils";
import { SlackClient, type User, type Channel, type Group } from "./SlackClient";
import { useCachedPromise, usePromise } from "@raycast/utils";
import { useMemo, useRef, useState } from "react";
import { createDirectoryUserSearch, directoryUsersToShow, mergeDirectorySearchResults } from "./directory";
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

export const useDirectorySearch = (workspace: Workspace, query: string) => {
  const userSearchAbortable = useRef<AbortController>(null);
  const channelSearchAbortable = useRef<AbortController>(null);
  const conversationSearchAbortable = useRef<AbortController>(null);
  const [preview, setPreview] = useState<{ query: string; users: User[] }>();

  const [partialChannels, setPartialChannels] = useState<{ query: string; rows: Channel[] }>();
  const [partialGroups, setPartialGroups] = useState<{ query: string; rows: Group[] }>();
  const userSearch = useMemo(
    () =>
      createDirectoryUserSearch(() => {
        const signal = userSearchAbortable.current?.signal;
        return inWorkspace(workspace, () =>
          SlackClient.searchDirectoryMembers(query, signal, (matched) => {
            if (signal?.aborted) return;
            setPreview({ query, users: matched });
          }),
        );
      }),
    [workspace, query],
  );

  const users = usePromise(
    (...args: [string]) => {
      // Keep the query in the hook arguments so each query starts a fresh execution.
      void args;
      return userSearch.getUsers();
    },
    [query],
    {
      abortable: userSearchAbortable,
      onError(error) {
        handleError(error, "Failed to search Slack users");
      },
    },
  );
  const channels = usePromise(
    (searchText: string) => {
      const signal = channelSearchAbortable.current?.signal;
      return inWorkspace(workspace, () =>
        SlackClient.searchConversations(searchText, signal, undefined, "channels", (rows) => {
          if (!signal?.aborted) setPartialChannels({ query: searchText, rows });
        }),
      );
    },
    [query],
    {
      abortable: channelSearchAbortable,
      onError(error) {
        handleError(error, "Failed to search Slack channels");
      },
    },
  );
  const conversations = usePromise(
    (searchText: string) => {
      const signal = conversationSearchAbortable.current?.signal;
      return inWorkspace(workspace, () =>
        SlackClient.searchConversations(searchText, signal, userSearch.getUserNames, "groups", (_, rows) => {
          if (!signal?.aborted) setPartialGroups({ query: searchText, rows });
        }),
      );
    },
    [query],
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
      (!channels.isLoading && !channels.error ? channels.data?.[0] : undefined) ??
        (partialChannels?.query === query ? partialChannels.rows : []),
      (!conversations.isLoading && !conversations.error ? conversations.data?.[1] : undefined) ??
        (partialGroups?.query === query ? partialGroups.rows : []),
    ]),
    error: channels.error || conversations.error || users.error,
    retry: async () => {
      await Promise.allSettled([channels.revalidate(), conversations.revalidate(), users.revalidate()]);
    },
    isLoading: users.isLoading || channels.isLoading || conversations.isLoading,
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
