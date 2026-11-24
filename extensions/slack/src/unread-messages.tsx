import { Action, ActionPanel, Color, Icon, List, LocalStorage, showToast, Toast, useNavigation } from "@raycast/api";
import { isEqual } from "lodash";
import { useEffect, useRef, useState } from "react";
import { convertSlackEmojiToUnicode } from "./shared/utils";

import { Message, SlackClient, useChannels, User, useUnreadConversations } from "./shared/client";
import {
  combinedConversations,
  useConversationOptions,
  type ConversationOptions,
  type RenderRows,
} from "./shared/ConversationList";
import { favoriteId } from "./shared/client/favorites";
import { WorkspaceList } from "./shared/WorkspaceViews";
import { type Workspace, workspaceKey } from "./shared/client/workspaces";
import { inWorkspace } from "./shared/client/WebClient";
import { handleError, timeDifference } from "./shared/utils";
import { OpenChannelInSlack, useSlackApp } from "./shared/OpenInSlack";

// Storage writes run one after another across screen instances, so the newest selection is always written last
// and a reopened configuration never races a write still in flight from the previous one.
let storageQueue: Promise<void> = Promise.resolve();

function UnreadRows({
  workspace,
  query,
  children,
  options,
}: {
  workspace: Workspace;
  query: string;
  options: ConversationOptions;
  children: RenderRows;
}) {
  const conversationsStorageKey = "unread:" + workspaceKey(workspace);
  const [selectedConversations, setSelectedConversations] = useState<string[]>();

  const { isAppInstalled, isLoading } = useSlackApp();
  const { data, members, isLoading: isLoadingChannels, error: channelsError } = useChannels(workspace);

  const [users, channels, groups] = data ?? [];

  const {
    data: unread,
    error: unreadError,
    revalidate: retryUnread,
    isLoading: isLoadingUnreadConversations,
    mutate,
  } = useUnreadConversations(workspace, selectedConversations);

  const unreadConversations = unread?.conversations;
  const setConversations = async () => {
    let conversations: string[] | undefined;
    const apply = storageQueue.then(async () => {
      const item = await LocalStorage.getItem(conversationsStorageKey);
      const storedConversations = item ? (JSON.parse(item as string) as string[]).sort() : [];
      let next = storedConversations;

      // unselect conversations that don't exist anymore
      if (users && channels && groups && !channelsError) {
        next = next.filter(
          (id: string) =>
            !!members.data?.imPeers.has(id) ||
            !!channels.find((channel) => channel.id === id) ||
            !!groups.find((group) => group.id === id),
        );

        // Only write back when something was removed, so a stale read can't overwrite a newer selection
        if (next.length !== storedConversations.length) {
          await LocalStorage.setItem(conversationsStorageKey, JSON.stringify(next));
        }
      }

      conversations = next;
    });
    storageQueue = apply.catch(async (error) => {
      await handleError(error, "Could not save the selected conversations");
    });
    await storageQueue;
    if (!conversations) return false;
    if (!selectedConversations || !isEqual(selectedConversations, conversations)) {
      setSelectedConversations(conversations);
    }
    return true;
  };

  const refreshConversations = async () => {
    if (!(await setConversations())) return;
    await mutate();
  };

  useEffect(() => {
    setConversations();
  }, []);

  const markConversationAsRead = async (conversationId: string, actionTriggeredManually?: boolean): Promise<void> => {
    try {
      await mutate(
        inWorkspace(workspace, () => SlackClient.markAsRead(conversationId)),
        {
          optimisticUpdate(data) {
            return (
              data && { ...data, conversations: data.conversations.filter((c) => c.conversationId !== conversationId) }
            );
          },
        },
      );

      if (actionTriggeredManually) {
        showToast({
          style: Toast.Style.Success,
          title: `Marked as read`,
        });
      }
    } catch (error) {
      if (actionTriggeredManually) {
        await handleError(error, "Could not mark conversation as read");
      }
    }
  };

  const loading = !selectedConversations || isLoadingUnreadConversations || isLoadingChannels || isLoading;
  const settledEmpty =
    !!selectedConversations?.length &&
    !isLoadingUnreadConversations &&
    !unreadError &&
    unread?.failed.length === 0 &&
    unread.conversations.length === 0;
  const notices = [];
  if (unreadError || unread?.failed.length)
    notices.push({
      id: workspaceKey(workspace) + "/retry-unread",
      element: (
        <List.Item
          title="Could not read all followed conversations"
          subtitle={unread?.failed.join(", ")}
          accessories={[{ tag: workspace.teamName }]}
          actions={
            <ActionPanel>
              <Action title="Retry" onAction={retryUnread} />
              <Action.Push
                title="Configure"
                target={
                  <Configuration
                    storageKey={conversationsStorageKey}
                    data={data}
                    showApps={options.showApps}
                    refreshConversations={refreshConversations}
                  />
                }
              />
              {options.actions()}
            </ActionPanel>
          }
        />
      ),
    });
  if (selectedConversations?.length === 0)
    notices.push({
      id: workspaceKey(workspace) + "/configure-unread",
      element: (
        <List.Item
          icon={Icon.Gear}
          actions={
            <ActionPanel>
              <Action.Push
                icon={Icon.Gear}
                title="Configure"
                target={
                  <Configuration
                    storageKey={conversationsStorageKey}
                    data={data}
                    showApps={options.showApps}
                    refreshConversations={refreshConversations}
                  />
                }
              />
              {options.actions()}
            </ActionPanel>
          }
          title="Select Conversations"
          accessories={[{ tag: workspace.teamName }]}
          subtitle="Choose up to 30 conversations to follow"
        />
      ),
    });
  if (settledEmpty)
    notices.push({
      id: workspaceKey(workspace) + "/no-unread",
      element: (
        <List.Item
          actions={
            <ActionPanel>
              <Action.Push
                icon={Icon.Gear}
                title="Configure"
                target={
                  <Configuration
                    storageKey={conversationsStorageKey}
                    data={data}
                    showApps={options.showApps}
                    refreshConversations={refreshConversations}
                  />
                }
              />
              {options.actions()}
            </ActionPanel>
          }
          title="No Unread Messages Found"
          accessories={[{ tag: workspace.teamName }]}
        />
      ),
    });
  const rows = (unreadConversations ?? []).flatMap((unreadConversation) => {
    const peer = unreadConversation.directUserId ?? members.data?.imPeers.get(unreadConversation.conversationId);
    if (
      unreadConversation.conversationId.startsWith("D") &&
      !options.showApps &&
      (!peer || !members.data?.usersById.has(peer))
    )
      return [];
    const conversation =
      users?.find((user) => user.conversationId === unreadConversation.conversationId) ??
      channels?.find((channel) => channel.id === unreadConversation.conversationId) ??
      groups?.find((group) => group.id === unreadConversation.conversationId);

    const incoming = unreadConversation.messageHistory.find(
      (message) => message.incoming ?? message.senderId !== workspace.userId,
    );
    const preview = incoming ?? unreadConversation.messageHistory[0];
    const name = conversation?.name ?? (peer && members.data?.apps.get(peer)) ?? unreadConversation.conversationId;
    if (query && ![name, preview.message].some((value) => value?.toLowerCase().includes(query.toLowerCase())))
      return [];
    const id = workspaceKey(workspace) + "/" + unreadConversation.conversationId;
    const pin = conversation
      ? favoriteId(workspace, conversation)
      : peer
        ? workspaceKey(workspace) + "/" + peer
        : unreadConversation.conversationId.startsWith("D")
          ? undefined
          : id;
    const favorite = !!pin && options.favorites?.has(pin);
    return [
      {
        id,
        name,
        favorite,
        latest: incoming ? new Date(incoming.receivedAt).getTime() / 1000 : 0,
        element: (
          <List.Item
            id={id}
            title={name}
            subtitle={convertSlackEmojiToUnicode(preview.message)}
            icon={conversation?.icon}
            accessories={[
              { tag: workspace.teamName },
              ...(favorite ? [{ icon: Icon.Star, tooltip: "Favorite" }] : []),
              { text: timeDifference(new Date(preview.receivedAt)) },
              { icon: Icon.Message, text: `${unreadConversation.messageHistory.length}` },
            ]}
            actions={
              <ActionPanel>
                <OpenChannelInSlack
                  workspaceId={workspace.teamId}
                  channelId={unreadConversation.conversationId}
                  isAppInstalled={isAppInstalled}
                  onAction={() => markConversationAsRead(unreadConversation.conversationId)}
                />
                <Action
                  shortcut={{ modifiers: ["cmd", "shift"], key: "enter" }}
                  title="Mark as Read"
                  icon={Icon.Checkmark}
                  onAction={() => markConversationAsRead(unreadConversation.conversationId, true)}
                />

                <Action.Push
                  title="Show Unread Messages"
                  icon={Icon.Sidebar}
                  shortcut={{ modifiers: ["cmd"], key: "m" }}
                  target={
                    <UnreadMessagesConversation
                      conversationName={conversation?.name ?? ""}
                      messageHistory={unreadConversation.messageHistory}
                      users={users}
                    />
                  }
                />
                <Action.Push
                  title="Configure Command"
                  icon={Icon.Gear}
                  shortcut={{ modifiers: ["opt"], key: "c" }}
                  target={
                    <Configuration
                      storageKey={conversationsStorageKey}
                      data={data}
                      showApps={options.showApps}
                      refreshConversations={refreshConversations}
                    />
                  }
                />
                {options.actions(pin)}
              </ActionPanel>
            }
          />
        ),
      },
    ];
  });
  if (members.error)
    notices.push({
      id: workspaceKey(workspace) + "/retry-members",
      element: (
        <List.Item
          title="Could not load direct message profiles"
          accessories={[{ tag: workspace.teamName }]}
          actions={
            <ActionPanel>
              <Action title="Retry" onAction={members.revalidate} />
              {options.actions()}
            </ActionPanel>
          }
        />
      ),
    });
  return children({ rows, loading, notices });
}

function UnreadMessagesConversation({
  conversationName,
  messageHistory,
  users,
}: {
  conversationName: string;
  messageHistory: Message[];
  users?: User[];
}) {
  return (
    <List navigationTitle={`Unread Messages — ${conversationName}`} isShowingDetail>
      {messageHistory.map((message, index) => {
        const user = users?.find((u) => u.id === message.senderId);
        return (
          <List.Item
            key={index}
            icon={user?.icon}
            title={user?.name ?? ""}
            subtitle={timeDifference(new Date(message.receivedAt))}
            detail={<List.Item.Detail markdown={convertSlackEmojiToUnicode(message.message)} />}
          />
        );
      })}
    </List>
  );
}

type ConfigurationProps = {
  showApps: boolean;
  storageKey: string;
  data: ReturnType<typeof useChannels>["data"];
  refreshConversations: () => Promise<void>;
};

function Configuration({
  data,
  refreshConversations,
  storageKey: conversationsStorageKey,
  showApps,
}: ConfigurationProps) {
  const { pop } = useNavigation();
  // Leave only after pending writes finish, so reopening configuration reads the latest selection
  const done = async () => {
    await storageQueue;
    pop();
  };
  const [selectedConversations, setSelectedConversations] = useState<string[]>([]);
  // The latest selection, so toggles made before a re-render build on each other
  const latestSelection = useRef<string[]>([]);
  const saveCount = useRef(0);
  const hasEdited = useRef(false);
  const [users, channels, groups, members] = data ?? [];
  const directMessages = [
    ...(users ?? []).flatMap(({ conversationId, name, icon }) =>
      conversationId ? [{ conversationId, name, icon }] : [],
    ),
    ...(showApps && members
      ? [...members.imPeers].flatMap(([conversationId, peer]) => {
          const name = members.apps.get(peer);
          return name ? [{ conversationId, name, icon: Icon.AppWindow }] : [];
        })
      : []),
  ];

  useEffect(() => {
    let cancelled = false;
    void storageQueue
      .then(() => LocalStorage.getItem(conversationsStorageKey))
      .then((item) => {
        if (cancelled || hasEdited.current || !item) return;
        latestSelection.current = JSON.parse(item as string);
        setSelectedConversations(latestSelection.current);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleConversation = (id: string) => {
    const currentSelection = latestSelection.current;
    let updatedSelectedConversations: string[] | undefined;
    if (currentSelection.includes(id)) {
      updatedSelectedConversations = currentSelection.filter((x) => x !== id);
    } else if (currentSelection.length < 30) {
      updatedSelectedConversations = [...currentSelection, id];
    } else {
      showToast({
        style: Toast.Style.Failure,
        title: "Limit reached",
        message: "Unselect a conversation first to select a new one.",
      });
    }

    if (updatedSelectedConversations) {
      latestSelection.current = updatedSelectedConversations;
      setSelectedConversations(updatedSelectedConversations);
      hasEdited.current = true;
      // Persist on its own queue. The Slack refresh reads that write back, but must not sit on the queue:
      // Done waits for writes only, and a slow refresh must not delay the next selection.
      const selection = JSON.stringify(updatedSelectedConversations);
      const saveId = ++saveCount.current;
      const write = storageQueue.then(() => LocalStorage.setItem(conversationsStorageKey, selection));
      storageQueue = write.catch(async (error) => {
        await handleError(error, "Could not save the selected conversations");
      });
      void write
        .then(
          () => {
            if (saveId !== saveCount.current) return;
            return refreshConversations();
          },
          () => undefined,
        )
        .catch(async (error) => {
          await handleError(error, "Could not refresh conversations");
        });
    }
  };

  const sections = [
    { title: "Channels", conversations: channels },
    { title: "Groups", conversations: groups },
  ];

  return (
    <List navigationTitle="Unread Messages — Configuration">
      <List.Section title="Direct Messages">
        {directMessages.map(({ name, icon, conversationId }) => {
          const isConversationSelected = selectedConversations.includes(conversationId);
          return (
            <List.Item
              key={conversationId}
              title={name}
              icon={isConversationSelected ? { source: Icon.Checkmark, tintColor: Color.Green } : Icon.Circle}
              accessories={[{ icon }]}
              actions={
                <ActionPanel>
                  <Action
                    icon={Icon.Eye}
                    title={isConversationSelected ? "Unselect" : "Observe Conversation"}
                    onAction={() => toggleConversation(conversationId)}
                  />
                  <Action icon={Icon.Check} title="Done" onAction={done} />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>

      {sections.map(({ title, conversations }) => (
        <List.Section key={title} title={title}>
          {conversations?.map(({ id, name, icon }) => {
            const isConversationSelected = selectedConversations.includes(id);
            return (
              <List.Item
                key={id}
                title={name}
                icon={isConversationSelected ? { source: Icon.Checkmark, tintColor: Color.Green } : Icon.Circle}
                accessories={[{ icon }]}
                actions={
                  <ActionPanel>
                    <Action
                      icon={Icon.Eye}
                      title={isConversationSelected ? "Unselect" : "Observe Conversation"}
                      onAction={() => toggleConversation(id)}
                    />
                    <Action icon={Icon.Check} title="Done" onAction={done} />
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      ))}
    </List>
  );
}

export default function UnreadMessages() {
  const options = useConversationOptions();
  return (
    <WorkspaceList
      placeholder="Filter unread conversations"
      merged={(workspaces, query, renderList) =>
        combinedConversations(
          workspaces,
          options,
          renderList,
          (workspace, next) => <UnreadRows {...{ workspace, query, options }}>{next}</UnreadRows>,
          query,
        )
      }
    />
  );
}
