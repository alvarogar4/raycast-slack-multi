import { Action, ActionPanel, Color, Icon, List, showInFinder, showToast, Toast } from "@raycast/api";
import { useCachedPromise, useCachedState } from "@raycast/utils";
import { format, formatDistanceToNow } from "date-fns";
import { useState } from "react";
import * as emoji from "node-emoji";
import { SendMessage } from "./shared/SendMessage";

import { WorkspaceList } from "./shared/WorkspaceViews";
import { type Workspace, workspaceKey } from "./shared/client/workspaces";
import { inWorkspace, getSlackWebClient } from "./shared/client/WebClient";
import { downloadSlackFile } from "./shared/client/downloadFile";
import { convertTimestampToDate, handleError } from "./shared/utils";
import { useChannels, type User } from "./shared/client";
import { SearchMessagesArguments } from "@slack/web-api";

import { matchesAllWords } from "./shared/client/pagination";

type MatchFile = {
  id?: string;
  name?: string;
  title?: string;
  url_private_download?: string;
  url_private?: string;
};

async function downloadAttachment(file: MatchFile) {
  const url = file.url_private_download ?? file.url_private;
  if (!url) {
    await showToast({ style: Toast.Style.Failure, title: "Attachment has no downloadable URL" });
    return;
  }

  const toast = await showToast({ style: Toast.Style.Animated, title: "Downloading attachment" });
  try {
    const { path } = await downloadSlackFile({ url, filename: file.name ?? file.title ?? file.id ?? "attachment" });
    toast.style = Toast.Style.Success;
    toast.title = "Attachment downloaded";
    toast.message = path;
    await showInFinder(path);
  } catch (error) {
    toast.hide();
    await handleError(error, "Could not download attachment");
  }
}

function FromActions({
  users,
  meInfo,
  query,
  setQuery,
}: {
  users?: User[];
  meInfo?: User;
  query: string;
  setQuery: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  // Each message has an action panel. Materialize authors only in the opened submenu,
  // and cap its rows so large workspaces do not serialize the full directory per message.
  const choices = isOpen
    ? users?.filter((user) => matchesAllWords([user.name, user.username], searchText)).slice(0, 100)
    : [];
  return (
    <>
      <Action
        title="From Me Only"
        icon={meInfo?.icon ?? Icon.Person}
        shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
        onAction={() => setQuery(query ? `from:me ${query}` : "from:me ")}
      />
      <ActionPanel.Submenu
        icon={Icon.Person}
        title="From"
        shortcut={{ modifiers: ["cmd", "shift"], key: "u" }}
        onOpen={() => setIsOpen(true)}
        onSearchTextChange={setSearchText}
        filtering={false}
      >
        {choices?.map((user) => (
          <Action
            key={user.id}
            title={user.name}
            icon={user.icon}
            onAction={() => setQuery(query ? `from:<@${user.id}> ${query}` : `from:<@${user.id}> `)}
          />
        ))}
      </ActionPanel.Submenu>
    </>
  );
}

function MessageRows({
  workspace,
  query,
  setQuery,
}: {
  workspace: Workspace;
  query: string;
  setQuery: (s: string) => void;
}) {
  const [sortType, setSortType] = useCachedState<SearchMessagesArguments["sort"]>(
    "search-sort-type:" + workspaceKey(workspace),
    "timestamp",
  );

  const { data: channels } = useChannels(workspace);
  const users = channels?.[0];

  const meInfo = users?.find((u) => u.id === workspace.userId);

  const { data, isLoading } = useCachedPromise(
    (w: Workspace, query: string, sort: SearchMessagesArguments["sort"]) =>
      inWorkspace(w, async () => {
        const webClient = getSlackWebClient();

        const results = await webClient.search.messages({
          query,
          sort,
        });

        return results.messages?.matches ?? [];
      }),
    [workspace, query, sortType],
    {
      onError(error) {
        handleError(error);
      },
      execute: query.length > 0,
      keepPreviousData: false,
    },
  );

  const sortOptions: { title: string; sort: SearchMessagesArguments["sort"] }[] = [
    { title: "Newest", sort: "timestamp" },
    { title: "Most Relevant", sort: "score" },
  ];

  return (
    <List.Section title={workspace.teamName} subtitle={isLoading ? "Searching…" : undefined}>
      {query &&
        data?.map((m) => {
          if (!m.text || !m.ts) return null;
          const user = users?.find((u) => u.id === m.user);
          const files = ((m as { files?: MatchFile[] }).files ?? []).filter((file) => file.id);
          const date = convertTimestampToDate(m.ts);
          if (!Number.isFinite(date.getTime())) return null;
          const text = emoji.emojify(m.text);
          const formattedDate = format(date, "EEEE dd MMMM yyyy 'at' HH:mm");
          return (
            <List.Item
              key={m.iid}
              icon={{ value: user?.icon ?? Icon.Person, tooltip: user?.name ?? "Unknown user" }}
              title={text}
              accessories={[{ tag: workspace.teamName }, { date, tooltip: formattedDate }]}
              detail={
                <List.Item.Detail
                  markdown={text}
                  metadata={
                    <List.Item.Detail.Metadata>
                      {m.type === "message" && m.channel ? (
                        <List.Item.Detail.Metadata.Label
                          title="Channel Name"
                          icon={Icon.Hashtag}
                          text={m.channel.name}
                        />
                      ) : null}

                      {user ? <List.Item.Detail.Metadata.Label title="From" icon={user.icon} text={user.name} /> : null}

                      <List.Item.Detail.Metadata.Label
                        title="Posted"
                        icon={Icon.Clock}
                        text={formatDistanceToNow(date)}
                      />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  {m.permalink ? <Action.OpenInBrowser url={m.permalink} title="Open Message" /> : null}

                  {m.permalink ? (
                    <Action.CopyToClipboard
                      content={m.permalink}
                      title="Copy Message URL"
                      shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                    />
                  ) : null}

                  {user && (
                    <Action.Push
                      title={`Message ${user.name}`}
                      icon={Icon.Message}
                      target={<SendMessage workspace={workspace} recipient={user.id} recipientName={user.name} />}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
                    />
                  )}

                  {files.length === 1 ? (
                    <Action
                      title="Download Attachment"
                      icon={Icon.Download}
                      shortcut={{
                        macOS: { modifiers: ["cmd", "shift"], key: "d" },
                        Windows: { modifiers: ["ctrl", "shift"], key: "d" },
                      }}
                      onAction={() => inWorkspace(workspace, () => downloadAttachment(files[0]))}
                    />
                  ) : files.length > 1 ? (
                    <ActionPanel.Submenu
                      title="Download Attachment"
                      icon={Icon.Download}
                      shortcut={{
                        macOS: { modifiers: ["cmd", "shift"], key: "d" },
                        Windows: { modifiers: ["ctrl", "shift"], key: "d" },
                      }}
                    >
                      {files.map((file, index) => (
                        <Action
                          key={file.id ?? index}
                          title={file.name ?? file.title ?? file.id ?? "Attachment"}
                          icon={Icon.Download}
                          onAction={() => inWorkspace(workspace, () => downloadAttachment(file))}
                        />
                      ))}
                    </ActionPanel.Submenu>
                  ) : null}

                  <ActionPanel.Section>
                    <ActionPanel.Submenu
                      title="Sort by"
                      icon={Icon.ArrowUp}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
                    >
                      {sortOptions.map((s) => (
                        <Action
                          key={s.sort}
                          autoFocus={sortType === s.sort}
                          icon={sortType === s.sort ? { source: Icon.CheckCircle, tintColor: Color.Green } : undefined}
                          title={s.title}
                          onAction={() => setSortType(s.sort)}
                        />
                      ))}
                    </ActionPanel.Submenu>

                    {m.channel?.name && (
                      <Action
                        title="Search in This Channel"
                        onAction={() => setQuery("in:" + m.channel?.name + " " + query)}
                      />
                    )}
                    <FromActions users={users} meInfo={meInfo} query={query} setQuery={setQuery} />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          );
        })}
    </List.Section>
  );
}

export default function Search() {
  return (
    <WorkspaceList placeholder="Search messages (in:channel, from:me…)" detail>
      {(workspace, query, setQuery) => <MessageRows {...{ workspace, query, setQuery }} />}
    </WorkspaceList>
  );
}
