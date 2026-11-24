import { Action, ActionPanel, Detail, environment, Icon, List, launchCommand, LaunchType } from "@raycast/api";
import { useCachedState, usePromise } from "@raycast/utils";
import { type ReactNode, useState } from "react";
import { accounts, inWorkspace } from "./client/WebClient";
import { selectedWorkspaces, type Workspace } from "./client/workspaces";

function Setup({ loading }: { loading: boolean }) {
  return (
    <Detail
      isLoading={loading}
      markdown={
        loading
          ? ""
          : "## Connect a Slack workspace\n\nChoose Connect with Slack, select your workspace in the browser, then reopen this command."
      }
      actions={
        !loading ? (
          <ActionPanel>
            <Action
              title="Connect with Slack"
              onAction={() => launchCommand({ name: "connect-workspace", type: LaunchType.UserInitiated })}
            />
          </ActionPanel>
        ) : undefined
      }
    />
  );
}

export type RenderWorkspaceList = (
  rows: ReactNode,
  loading: boolean,
  selection?: Pick<List.Props, "selectedItemId" | "onSelectionChange">,
) => ReactNode;

export function WorkspaceList({
  detail,
  merged,
  placeholder,
}: {
  merged: (
    workspaces: Workspace[],
    query: string,
    renderList: RenderWorkspaceList,
    searchWorkspace: (w: Workspace, text: string) => void,
  ) => ReactNode;
  detail?: boolean;
  placeholder: string;
}) {
  const { data, isLoading } = usePromise(accounts.list);
  const [filter, setFilter] = useCachedState(environment.commandName + "-workspace", "all");
  const [query, setQuery] = useState("");
  if (!data?.length) return <Setup loading={isLoading} />;
  const value = data.some((w) => w.teamId === filter) ? filter : "all";
  const renderList: RenderWorkspaceList = (rows, loading, selection) => (
    <List
      {...selection}
      isLoading={loading}
      filtering={false}
      throttle
      searchText={query}
      onSearchTextChange={setQuery}
      searchBarPlaceholder={placeholder}
      isShowingDetail={detail}
      searchBarAccessory={
        <List.Dropdown tooltip="Workspace" value={value} onChange={setFilter}>
          <List.Dropdown.Item value="all" title="All Workspaces" />
          {data.map((w) => (
            <List.Dropdown.Item key={w.teamId} value={w.teamId} title={w.teamName} />
          ))}
        </List.Dropdown>
      }
    >
      {rows}
    </List>
  );
  return merged(selectedWorkspaces(data, value), query, renderList, (w, text) => {
    setFilter(w.teamId);
    setQuery(text);
  });
}

export function WorkspaceTarget({
  children,
  allowAll = false,
  action,
}:
  | { children: (targets: Workspace[]) => ReactNode; allowAll?: boolean; action?: never }
  | { action: (workspace: Workspace) => ReactNode; children?: never; allowAll?: false }) {
  const { data, isLoading } = usePromise(accounts.list);
  const [last, remember] = useCachedState(environment.commandName + "-target", "all");
  if (!data?.length) return <Setup loading={isLoading} />;
  if (data.length === 1 && children) return <>{children(data)}</>;
  const choices = [
    ...(allowAll ? [{ id: "all", name: "All Workspaces", targets: data }] : []),
    ...data.map((w) => ({ id: w.teamId, name: w.teamName, targets: [w] })),
  ];
  return (
    <List
      navigationTitle="Choose Workspace"
      selectedItemId={choices.some((c) => c.id === last) ? last : choices[0].id}
      onSelectionChange={(id) => {
        if (id) remember(id);
      }}
    >
      {choices.map(({ id, name, targets }) => (
        <List.Item
          key={id}
          id={id}
          title={name}
          subtitle={choices.some((choice) => choice.id !== id && choice.name === name) ? id : undefined}
          keywords={[id]}
          icon={Icon.Building}
          actions={
            <ActionPanel>
              {action ? action(targets[0]) : <Action.Push title="Choose Workspace" target={<>{children(targets)}</>} />}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

export async function applyToWorkspaces(targets: Workspace[], action: (w: Workspace) => Promise<unknown>) {
  const results = await Promise.allSettled(targets.map((w) => inWorkspace(w, () => action(w))));
  const failures = targets.flatMap((w, i) => (results[i].status === "rejected" ? [w.teamName] : []));
  if (failures.length)
    throw new Error(
      `Failed in ${failures.join(", ")}. Succeeded in ${targets.length - failures.length} of ${targets.length} workspaces.`,
    );
}
