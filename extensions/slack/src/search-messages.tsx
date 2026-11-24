import {
  Action,
  ActionPanel,
  closeMainWindow,
  Color,
  Icon,
  launchCommand,
  LaunchType,
  List,
  showInFinder,
  showToast,
  Toast,
} from "@raycast/api";
import { usePromise, useCachedState } from "@raycast/utils";
import { format, formatDistanceToNow } from "date-fns";
import { type ReactElement, type ReactNode, useCallback, useRef, useState } from "react";
import * as emoji from "node-emoji";
import { SendMessage } from "./shared/SendMessage";

import { WorkspaceList, type RenderWorkspaceList } from "./shared/WorkspaceViews";
import {
  combinedWorkspaceResults,
  useConversationOptions,
  type ConversationOptions,
  type RenderRows,
} from "./shared/ConversationList";
import { orderMessageResults, type MessageRank, type MessageSort } from "./shared/client/conversationOrder";
import { type Workspace, workspaceKey } from "./shared/client/workspaces";
import { inWorkspace, getSlackWebClient } from "./shared/client/WebClient";
import { downloadSlackFile } from "./shared/client/downloadFile";
import { convertTimestampToDate, handleError } from "./shared/utils";
import { useWorkspaceMembers, type User } from "./shared/client";

import { openSlackLink } from "./shared/OpenInSlack";
import { nativeMessageLink } from "./shared/client/navigation";
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

export async function openSearchMessage(workspace: Workspace, timestamp: string, channel?: string, permalink?: string) {
  try {
    await openSlackLink(nativeMessageLink(workspace.teamId, timestamp, channel, permalink), async () => {
      if (permalink || !channel) return permalink;
      const result = await inWorkspace(workspace, () =>
        getSlackWebClient().chat.getPermalink({ channel, message_ts: timestamp }),
      );
      return result.permalink;
    });
    await closeMainWindow();
  } catch (error) {
    await handleError(error, "Could not open message");
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

type MessageRow = MessageRank & { element: ReactElement<List.Item.Props> };

function isGrantRejected(error: unknown) {
  const code = (error as { data?: { error?: string } } | null)?.data?.error;
  return (
    code === "invalid_auth" ||
    code === "token_revoked" ||
    code === "token_expired" ||
    code === "account_inactive" ||
    code === "not_authed"
  );
}

export function searchMessagePages(
  workspace: Workspace,
  query: string,
  sort: MessageSort,
  onGrantRejected?: () => void,
) {
  return async ({ page }: { page: number }) =>
    inWorkspace(workspace, async () => {
      const response = await getSlackWebClient().search.messages({
        query,
        sort,
        sort_dir: "desc",
        count: 20,
        page: page + 1,
      });
      const messages = response.messages;
      const pageCount =
        messages?.pagination?.page_count ?? messages?.paging?.pages ?? Math.ceil((messages?.total ?? 0) / 20);
      const hasMore = page + 1 < pageCount;
      return {
        data: [{ query, sort, workspace: workspaceKey(workspace), matches: messages?.matches ?? [], hasMore }],
        hasMore,
      };
    }).catch((error: unknown) => {
      // usePromise discards late failures for superseded queries. A rejected grant covers every query in this workspace.
      if (isGrantRejected(error)) onGrantRejected?.();
      throw error;
    });
}

function MessageRows({
  workspace,
  query,
  setQuery,
  sort,
  sortMenu,
  options,
  children,
}: {
  workspace: Workspace;
  query: string;
  setQuery: (s: string) => void;
  sort: MessageSort;
  sortMenu: ReactNode;
  options: ConversationOptions;
  children: RenderRows<MessageRow>;
}) {
  const members = useWorkspaceMembers(workspace);
  const directory = members.data;
  const users = directory?.users;
  const meInfo = directory?.usersById.get(workspace.userId);
  // Message text stays in this command instance and is refreshed with the active credential.
  const [rejected, setRejected] = useState(false);
  const rejectGrant = useCallback(() => setRejected(true), []);
  const reconnect = rejected || isGrantRejected(members.error);
  const { data, isLoading, error, revalidate, pagination } = usePromise(
    searchMessagePages,
    [workspace, query, sort, rejectGrant],
    {
      onError: (error) => void handleError(error),
      execute: !!query.trim() && !reconnect,
    },
  );
  const pages =
    !query.trim() || error || reconnect
      ? []
      : (data ?? []).filter((p) => p.query === query && p.sort === sort && p.workspace === workspaceKey(workspace));
  const lastPage = pages[pages.length - 1];
  const requestedPage = useRef<typeof lastPage>(undefined);
  const matches = pages.flatMap((page) => page.matches);
  const seen = new Set<string>();
  const rows = matches.flatMap((m, position) => {
    if (!m.text || !m.ts) return [];
    const channel = m.channel;
    const channelId = channel?.id;
    const direct = channel?.is_im || channelId?.startsWith("D");
    const peer = direct ? channel?.user || (channelId && directory?.imPeers.get(channelId)) : undefined;
    if (!options.showApps && direct && (!peer || !directory?.usersById.has(peer))) return [];
    const conversation = direct ? peer : channelId;
    const pin = conversation ? workspaceKey(workspace) + "/" + conversation : undefined;
    const favorite = pin && options.favorites?.has(pin);
    const id =
      workspaceKey(workspace) + "/" + (channelId || m.permalink || m.iid || channel?.name || "message") + "/" + m.ts;
    if (seen.has(id)) return [];
    seen.add(id);
    const user = m.user ? directory?.usersById.get(m.user) : undefined;
    const files = (m.files ?? []).filter((file) => file.id);
    const date = convertTimestampToDate(m.ts);
    if (!Number.isFinite(date.getTime())) return [];
    const timestamp = m.ts;
    const text = emoji.emojify(m.text);
    const formattedDate = format(date, "EEEE dd MMMM yyyy 'at' HH:mm");
    return [
      {
        id,
        timestamp: Number(m.ts),
        position,
        score: m.score,
        element: (
          <List.Item
            icon={{ value: user?.icon ?? Icon.Person, tooltip: user?.name ?? "Unknown user" }}
            title={text}
            accessories={[
              { tag: workspace.teamName },
              ...(favorite ? [{ icon: Icon.Star, tooltip: "Favorite conversation" }] : []),
              { date, tooltip: formattedDate },
            ]}
            detail={
              <List.Item.Detail
                markdown={text}
                metadata={
                  <List.Item.Detail.Metadata>
                    {m.type === "message" && m.channel ? (
                      <List.Item.Detail.Metadata.Label title="Channel Name" icon={Icon.Hashtag} text={m.channel.name} />
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
                {channelId || m.permalink ? (
                  <Action
                    title="Open Message"
                    icon={Icon.Message}
                    onAction={() => openSearchMessage(workspace, timestamp, channelId, m.permalink)}
                  />
                ) : null}

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
                  {m.channel?.name && (
                    <Action
                      title="Search in This Channel"
                      onAction={() => setQuery("in:" + m.channel?.name + " " + query)}
                    />
                  )}
                  <FromActions users={users} meInfo={meInfo} query={query} setQuery={setQuery} />
                </ActionPanel.Section>
                {options.actions(pin, sortMenu)}
              </ActionPanel>
            }
          />
        ),
      },
    ];
  });
  const notices = [];
  function notice(key: string, title: string, action: string, run: () => void) {
    return {
      id: workspaceKey(workspace) + "/" + key,
      element: (
        <List.Item
          title={title}
          accessories={[{ tag: workspace.teamName }]}
          actions={
            <ActionPanel>
              <Action title={action} onAction={run} />
              {options.actions(undefined, sortMenu)}
            </ActionPanel>
          }
        />
      ),
    };
  }
  if (reconnect)
    notices.push(
      notice("reconnect", "Reconnect this workspace to search messages", "Manage Workspaces", () =>
        launchCommand({ name: "manage-workspaces", type: LaunchType.UserInitiated }),
      ),
    );
  else if (query.trim() && error)
    notices.push(notice("retry-search", "Could not search messages", "Retry", revalidate));
  const hasDirect = matches.some(({ channel }) => channel?.is_im || channel?.id?.startsWith("D"));
  if (hasDirect && !options.showApps && members.error)
    notices.push(notice("retry-members", "Could not load direct message profiles", "Retry", members.revalidate));
  if (lastPage?.hasMore && pagination && !isLoading)
    notices.push(
      notice("more-search", "Load more messages", "Load More", () => {
        if (requestedPage.current === lastPage) return;
        requestedPage.current = lastPage;
        pagination.onLoadMore();
      }),
    );
  return children({
    rows,
    loading: !reconnect && !!query.trim() && (isLoading || (hasDirect && !options.showApps && members.isLoading)),
    notices,
  });
}

function MessageSearch({
  workspaces,
  query,
  renderList,
  searchWorkspace,
}: {
  workspaces: Workspace[];
  query: string;
  renderList: RenderWorkspaceList;
  searchWorkspace: (workspace: Workspace, query: string) => void;
}) {
  const options = useConversationOptions();
  // Preserve saved single-workspace preferences. All Workspaces has one shared sort.
  const [sort, setSort] = useCachedState<MessageSort>(
    "search-sort-type:" + (workspaces.length === 1 ? workspaceKey(workspaces[0]) : "all"),
    "timestamp",
  );
  const sortMenu = (
    <ActionPanel.Submenu title="Sort by" icon={Icon.ArrowUp}>
      {(["timestamp", "score"] as const).map((value) => (
        <Action
          key={value}
          title={value === "timestamp" ? "Newest" : "Most Relevant"}
          icon={sort === value ? { source: Icon.CheckCircle, tintColor: Color.Green } : undefined}
          onAction={() => setSort(value)}
        />
      ))}
    </ActionPanel.Submenu>
  );
  return combinedWorkspaceResults<MessageRow>(
    workspaces,
    query,
    renderList,
    (workspace, next) => (
      <MessageRows
        {...{ workspace, query, sort, sortMenu, options }}
        setQuery={(text) => searchWorkspace(workspace, text)}
      >
        {next}
      </MessageRows>
    ),
    (rows) => (sort === "score" && workspaces.length === 1 ? rows : orderMessageResults(rows, sort)),
    (loading) => (
      <List.EmptyView
        title={!query.trim() ? "Search Slack messages" : loading ? "Searching messages…" : "No matching messages"}
        actions={<ActionPanel>{options.actions(undefined, sortMenu)}</ActionPanel>}
      />
    ),
  );
}

export default function Search() {
  return (
    <WorkspaceList
      placeholder="Search messages (in:channel, from:me…)"
      detail
      merged={(workspaces, query, renderList, searchWorkspace) => (
        <MessageSearch
          key={JSON.stringify(workspaces.map(workspaceKey))}
          {...{ workspaces, query, renderList, searchWorkspace }}
        />
      )}
    />
  );
}
