import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useCachedState, usePromise } from "@raycast/utils";
import { Fragment, type ReactNode } from "react";
import { compareConversations, type ConversationRank, type ConversationSort } from "./client/conversationOrder";
import { workspaceKey, type Workspace } from "./client/workspaces";
import { readFavorites, saveFavorite } from "./client/favorites";
import type { RenderWorkspaceList } from "./WorkspaceViews";
import { handleError } from "./utils";

const sharedPreferences = { cacheNamespace: "slack-conversation-list" };

export function useConversationOptions(appFilter = true) {
  const [sort, setSort] = useCachedState<ConversationSort>("conversation-list-sort", "latest", sharedPreferences);
  const [showApps, setShowApps] = useCachedState("conversation-list-show-apps", false, sharedPreferences);
  const { data: favorites, revalidate } = usePromise(readFavorites);
  const actions = (id?: string) => (
    <ActionPanel.Section>
      {id && favorites && (
        <Action
          title={favorites.has(id) ? "Remove from Favorites" : "Add to Favorites"}
          icon={favorites.has(id) ? Icon.StarDisabled : Icon.Star}
          onAction={async () => {
            try {
              await saveFavorite(id, !favorites.has(id));
              await revalidate();
            } catch (error) {
              await handleError(error, "Could not update favorites");
            }
          }}
        />
      )}
      <ActionPanel.Submenu title="Sort Conversations" icon={Icon.ArrowDown}>
        <Action
          title="Latest Received Message"
          icon={sort === "latest" ? Icon.Checkmark : Icon.Clock}
          onAction={() => setSort("latest")}
        />
        <Action
          title="Name (A–Z)"
          icon={sort === "name" ? Icon.Checkmark : Icon.Text}
          onAction={() => setSort("name")}
        />
      </ActionPanel.Submenu>
      {appFilter && (
        <Action
          title={showApps ? "Hide App Conversations" : "Show App Conversations"}
          icon={Icon.AppWindow}
          onAction={() => setShowApps(!showApps)}
        />
      )}
    </ActionPanel.Section>
  );
  return { sort, showApps, actions, favorites };
}

export type ConversationOptions = ReturnType<typeof useConversationOptions>;
type ConversationRow = ConversationRank & { element: ReactNode };
export interface ConversationRows {
  rows: ConversationRow[];
  notice?: ReactNode;
  loading: boolean;
}
export type RenderRows = (source: ConversationRows) => ReactNode;

// Each workspace owns its hooks and actions. Collect their current rows in the same render before sorting.
export function combinedConversations(
  workspaces: Workspace[],
  options: ConversationOptions,
  renderList: RenderWorkspaceList,
  source: (workspace: Workspace, next: RenderRows) => ReactNode,
) {
  function collect(index: number, sources: ConversationRows[]): ReactNode {
    const w = workspaces[index];
    if (w)
      return <Fragment key={workspaceKey(w)}>{source(w, (rows) => collect(index + 1, [...sources, rows]))}</Fragment>;
    const rows = sources.flatMap((s) => s.rows).sort(compareConversations(options.sort));
    return renderList(
      <>
        {rows.map((row) => (
          <Fragment key={row.id}>{row.element}</Fragment>
        ))}
        {sources.map((s, i) => (
          <Fragment key={workspaceKey(workspaces[i])}>{s.notice}</Fragment>
        ))}
        {rows.length === 0 && sources.every((s) => !s.notice) && (
          <List.EmptyView
            title={sources.some((s) => s.loading) ? "Loading conversations…" : "No matching conversations"}
            actions={<ActionPanel>{options.actions()}</ActionPanel>}
          />
        )}
      </>,
      sources.some((s) => s.loading),
    );
  }
  return collect(0, []);
}
