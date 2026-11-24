import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useCachedState, usePromise } from "@raycast/utils";
import { cloneElement, Fragment, type ReactElement, type ReactNode, useState } from "react";
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
type ListRow = { id: string; element: ReactElement<List.Item.Props> };
type ConversationRow = ConversationRank & ListRow;
export interface ConversationRows {
  rows: ConversationRow[];
  notice?: ReactElement<List.Item.Props>;
  loading: boolean;
}
export type RenderRows = (source: ConversationRows) => ReactNode;

export function directorySelection(
  rows: ListRow[],
  scope: string,
  chosen: string | null,
  choose: (id: string | null) => void,
) {
  const ids = rows.map((row) => scope + "/" + row.id);
  const hasChoice = chosen !== null && ids.includes(chosen);
  // A delayed native callback for the former first result must never look like an arrow press.
  const automaticId = !hasChoice && ids.length ? "first/" + ids[0] : undefined;
  let movedWithinRender = false;
  const items = rows.map(({ element }, index) => {
    const id = index === 0 && automaticId ? automaticId : ids[index];
    return cloneElement(element, { id, key: id });
  });
  return {
    items,
    hasChoice,
    selection: {
      selectedItemId: hasChoice ? chosen : automaticId,
      onSelectionChange(id: string | null) {
        if (id && ids.includes(id)) {
          movedWithinRender = true;
          choose(id);
        } else if (movedWithinRender && id === automaticId) {
          // Up can return to the first row before React commits the preceding Down.
          choose(ids[0]);
        }
      },
    },
  };
}

function DirectoryList({
  rows,
  scope,
  loading,
  empty,
  renderList,
}: {
  rows: ListRow[];
  scope: string;
  loading: boolean;
  empty: ReactNode;
  renderList: RenderWorkspaceList;
}) {
  const [chosen, choose] = useState<string | null>(null);
  const { items, hasChoice, selection } = directorySelection(rows, scope, chosen, choose);
  if (chosen !== null && !hasChoice) choose(null);
  return renderList(items.length ? items : empty, loading, selection);
}

// Each workspace owns its hooks and actions. Collect their current rows in the same render before sorting.
export function combinedConversations(
  workspaces: Workspace[],
  options: ConversationOptions,
  renderList: RenderWorkspaceList,
  source: (workspace: Workspace, next: RenderRows) => ReactNode,
  directoryQuery?: string,
) {
  function collect(index: number, sources: ConversationRows[]): ReactNode {
    const w = workspaces[index];
    if (w)
      return <Fragment key={workspaceKey(w)}>{source(w, (rows) => collect(index + 1, [...sources, rows]))}</Fragment>;
    const rows = sources.flatMap((s) => s.rows).sort(compareConversations(options.sort));
    const notices = sources.flatMap((s, i) =>
      s.notice ? [{ id: s.notice.props.id ?? workspaceKey(workspaces[i]) + "/notice", element: s.notice }] : [],
    );
    const items = [...rows, ...notices];
    const loading = sources.some((s) => s.loading);
    const empty = (
      <List.EmptyView
        title={loading ? "Loading conversations…" : "No matching conversations"}
        actions={<ActionPanel>{options.actions()}</ActionPanel>}
      />
    );
    if (directoryQuery !== undefined) {
      const scope = JSON.stringify([directoryQuery, ...workspaces.map(workspaceKey)]);
      return <DirectoryList rows={items} {...{ scope, loading, empty, renderList }} />;
    }
    return renderList(
      items.length ? items.map(({ id, element }) => <Fragment key={id}>{element}</Fragment>) : empty,
      loading,
    );
  }
  return collect(0, []);
}
