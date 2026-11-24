// This filename should be named `switch-to-channel.tsx` or something similar
// but it's kept as `search.tsx` as changing the command's name will cause users to lose their keywords and aliases
import {
  ActionPanel,
  Action,
  Icon,
  List,
  Clipboard,
  Detail,
  useNavigation,
  showToast,
  Toast,
  showHUD,
  getPreferenceValues,
} from "@raycast/api";

import { User, useDirectorySearch, type Channel, type Group } from "./shared/client";
import { useState } from "react";
import { WorkspaceList } from "./shared/WorkspaceViews";
import { inWorkspace, getSlackWebClient } from "./shared/client/WebClient";
import { type Workspace, workspaceKey } from "./shared/client/workspaces";
import { handleError } from "./shared/utils";
import { useCachedState, useFrecencySorting } from "@raycast/utils";
import { OpenChannelInSlack, OpenChatInSlack, useSlackApp } from "./shared/OpenInSlack";
import { getStatusEmoji, getTimezoneMetadata } from "./shared/client/presentation";
import { SendMessage } from "./shared/SendMessage";
import { directMessageAction } from "./shared/directMessageAction";
import {
  isSlackUserId,
  mergeVisitedDirectoryItems,
  rememberVisitedDirectoryItem,
  visitedDirectoryItemsCacheKey,
  visitedDirectoryItemsForWorkspace,
} from "./shared/client/directory";

type OpenChannelItem = User | Channel | Group;

const { displayExtraMetadata } = getPreferenceValues<Preferences.Search>();

function searchItemAccessories(
  statusEmoji: string | undefined,
  statusText: string | undefined,
  statusExpiration: string | null,
  timezone: string,
) {
  const searchMetadata: List.Item.Accessory[] = [];
  const icon = getStatusEmoji(statusEmoji);
  if (icon || statusText) {
    searchMetadata.push({
      icon,
      text: statusText ?? "",
      tooltip: statusExpiration ? String(statusExpiration) : undefined,
    });
  }

  if (displayExtraMetadata) {
    const metadata = getTimezoneMetadata(timezone);
    if (metadata) {
      searchMetadata.push({ icon: Icon.Globe, text: metadata.name });
      if (metadata.offset) searchMetadata.push({ icon: Icon.Clock, text: metadata.offset });
    }
  }

  return searchMetadata;
}

function CopyIdAction({ id }: { id: string }) {
  return (
    <Action.CopyToClipboard
      title="Copy ID to Clipboard"
      content={id}
      shortcut={{
        macOS: { modifiers: ["cmd", "shift"], key: "c" },
        Windows: { modifiers: ["ctrl", "shift"], key: "c" },
      }}
    />
  );
}

export function DirectoryRows({
  workspace,
  searchText,
  compose = false,
}: {
  workspace: Workspace;
  searchText: string;
  compose?: boolean;
}) {
  const { push } = useNavigation();
  const workspaceId = workspace.teamId;
  const [joined, setJoined] = useState<ReadonlySet<string>>(new Set());
  const [recentItems, setRecentItems] = useCachedState<OpenChannelItem[]>(
    visitedDirectoryItemsCacheKey(workspaceKey(workspace)),
    [],
  );
  const { isAppInstalled } = useSlackApp();
  const { data, isLoading: loading, error, retry } = useDirectorySearch(workspace, searchText);

  const people = new Map(data?.[0].map((person) => [person.id, person]));
  const items = data?.flat().map((item) => {
    if ("directUserId" in item && item.directUserId) {
      const person = people.get(item.directUserId);
      return { ...item, name: person?.name ?? item.name, icon: person?.icon ?? Icon.Person };
    }
    return item;
  });
  const channels = mergeVisitedDirectoryItems(
    items,
    visitedDirectoryItemsForWorkspace(recentItems, workspaceKey(workspace)),
    searchText,
  );

  const {
    data: recents,
    visitItem,
    resetRanking,
  } = useFrecencySorting(channels, {
    key: (item) => item.id,
    namespace: workspaceKey(workspace),
  });

  const rememberVisit = (item: OpenChannelItem) => {
    setRecentItems((items) => rememberVisitedDirectoryItem(items, item));
    return visitItem(item);
  };

  return (
    <List.Section title={workspace.teamName} subtitle={loading ? "Loading…" : undefined}>
      {error && (
        <List.Item
          title="Could not load the full directory"
          accessories={[{ tag: workspace.teamName }]}
          actions={
            <ActionPanel>
              <Action title="Retry" onAction={retry} />
            </ActionPanel>
          }
        />
      )}
      {recents.map((item) => {
        const isUser = isSlackUserId(item.id);
        const notJoined = "notJoined" in item && item.notJoined && !joined.has(item.id);

        const composer = <SendMessage workspace={workspace} recipient={item.id} recipientName={item.name} />;
        if (compose)
          return (
            <List.Item
              key={item.id}
              title={item.name}
              icon={item.icon}
              accessories={[{ tag: workspace.teamName }, ...(notJoined ? [{ tag: "Not joined" }] : [])]}
              actions={
                <ActionPanel>
                  <Action.Push title="Compose Message" target={composer} />
                </ActionPanel>
              }
            />
          );
        if (isUser) {
          const {
            id: userId,
            name,
            icon,
            title,
            statusEmoji,
            statusText,
            statusExpiration,
            conversationId,
            timezone,
          } = item as User;
          return (
            <List.Item
              key={userId}
              title={name}
              subtitle={displayExtraMetadata ? title : undefined}
              icon={icon}
              accessories={[
                { tag: workspace.teamName },
                ...searchItemAccessories(statusEmoji, statusText, statusExpiration, timezone),
              ]}
              actions={
                <ActionPanel>
                  <OpenChatInSlack
                    workspace={workspace}
                    {...{ workspaceId, userId, isAppInstalled, conversationId, onAction: () => rememberVisit(item) }}
                  />

                  <Action.Push
                    title="Send Message"
                    icon={Icon.Message}
                    target={composer}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
                  />

                  {workspaceId &&
                    (isAppInstalled ? (
                      <Action.CreateQuicklink
                        quicklink={{
                          name: `Open Chat with ${name}`,
                          link: `slack://user?team=${workspaceId}&id=${userId}`,
                        }}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
                      />
                    ) : (
                      <Action
                        title="Create Quicklink"
                        icon={Icon.Link}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
                        onAction={() =>
                          directMessageAction(workspace, userId, conversationId, async (id) => {
                            const link = `https://app.slack.com/client/${workspaceId}/${id}`;
                            push(
                              <Detail
                                markdown={`Create a Quicklink to open this Slack conversation in your browser.`}
                                actions={
                                  <ActionPanel>
                                    <Action.CreateQuicklink quicklink={{ name: `Open Chat with ${name}`, link }} />
                                  </ActionPanel>
                                }
                              />,
                            );
                          })
                        }
                      />
                    ))}

                  {workspaceId && (
                    <Action
                      title="Copy Huddle Link"
                      icon={Icon.Clipboard}
                      onAction={() =>
                        directMessageAction(workspace, userId, conversationId, async (id) => {
                          await Clipboard.copy(`https://app.slack.com/huddle/${workspaceId}/${id}`);
                          await showHUD("Copied Huddle link");
                        })
                      }
                      shortcut={{ modifiers: ["cmd", "shift"], key: "." }}
                    />
                  )}

                  <CopyIdAction id={userId} />

                  <ActionPanel.Section>
                    <Action
                      icon={Icon.ArrowCounterClockwise}
                      title="Reset Ranking"
                      onAction={() => resetRanking(item)}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          );
        } else {
          const { id: channelId, name, icon } = item;

          return (
            <List.Item
              key={channelId}
              accessories={[{ tag: workspace.teamName }, ...(notJoined ? [{ tag: "Not joined" }] : [])]}
              title={name}
              icon={icon}
              actions={
                <ActionPanel>
                  <OpenChannelInSlack
                    {...{ workspaceId, channelId, isAppInstalled, onAction: () => rememberVisit(item) }}
                  />

                  {workspaceId && (
                    <Action.CreateQuicklink
                      quicklink={{
                        name: `Open #${name} Channel`,
                        ...(isAppInstalled
                          ? {
                              link: `slack://channel?team=${workspaceId}&id=${channelId}`,
                            }
                          : { link: `https://app.slack.com/client/${workspaceId}/${channelId}` }),
                      }}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
                    />
                  )}

                  {notJoined && (
                    <Action
                      title="Join Channel"
                      icon={Icon.Plus}
                      onAction={async () => {
                        try {
                          await inWorkspace(workspace, () =>
                            getSlackWebClient().conversations.join({ channel: channelId }),
                          );
                          setJoined((previous) => new Set([...previous, channelId]));
                          await showToast(Toast.Style.Success, "Joined #" + name);
                        } catch (error) {
                          await handleError(error, "Could not join channel");
                        }
                      }}
                    />
                  )}
                  <Action.Push title="Send Message" target={composer} />
                  <CopyIdAction id={channelId} />

                  <ActionPanel.Section>
                    <Action
                      icon={Icon.ArrowCounterClockwise}
                      title="Reset Ranking"
                      onAction={() => resetRanking(item)}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          );
        }
      })}
    </List.Section>
  );
}

export default function Search() {
  return (
    <WorkspaceList placeholder="Find a channel or person">
      {(workspace, searchText) => <DirectoryRows workspace={workspace} searchText={searchText} />}
    </WorkspaceList>
  );
}
