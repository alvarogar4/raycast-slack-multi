import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Form,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { showFailureToast, usePromise } from "@raycast/utils";
import { accounts, addWorkspace } from "./shared/client/WebClient";
import type { Workspace } from "./shared/client/workspaces";

function Editor({ workspace, saved }: { workspace?: Workspace; saved: () => Promise<unknown> }) {
  const { pop } = useNavigation();
  async function submit(values: { name: string; token: string }) {
    try {
      if (workspace) await accounts.rename(workspace, values.name);
      else await addWorkspace(values.token);
      await saved();
      pop();
      await showToast(Toast.Style.Success, workspace ? "Workspace renamed" : "Workspace connected");
    } catch (error) {
      await showFailureToast(error, { title: "Could not save workspace" });
    }
  }
  return (
    <Form
      navigationTitle={workspace ? "Rename Workspace" : "Add Workspace"}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Workspace" onSubmit={submit} />
        </ActionPanel>
      }
    >
      {workspace ? (
        <Form.TextField id="name" title="Name" defaultValue={workspace.teamName} />
      ) : (
        <Form.PasswordField id="token" title="Slack User Token" placeholder="xoxp-…" />
      )}
    </Form>
  );
}

export default function ManageWorkspaces() {
  const { data, isLoading, revalidate } = usePromise(accounts.inspect);
  const add = <Action.Push title="Add Workspace" icon={Icon.Plus} target={<Editor saved={revalidate} />} />;
  return (
    <List isLoading={isLoading}>
      <List.EmptyView
        title="Connect a Slack Workspace"
        description="Add the user token from your workspace’s Slack app."
        actions={<ActionPanel>{add}</ActionPanel>}
      />
      {data?.valid.map((w) => (
        <List.Item
          key={w.teamId}
          title={w.teamName}
          subtitle={w.teamId}
          actions={
            <ActionPanel>
              {add}
              <Action.Push title="Rename Workspace" target={<Editor workspace={w} saved={revalidate} />} />
              <Action
                title="Remove Workspace"
                style={Action.Style.Destructive}
                icon={Icon.Trash}
                onAction={async () => {
                  if (
                    await confirmAlert({
                      title: `Remove ${w.teamName}?`,
                      primaryAction: { title: "Remove", style: Alert.ActionStyle.Destructive },
                    })
                  ) {
                    try {
                      await accounts.remove(w);
                      await revalidate();
                    } catch (error) {
                      await showFailureToast(error);
                    }
                  }
                }}
              />
            </ActionPanel>
          }
        />
      ))}
      {data?.invalid.map((id) => (
        <List.Item
          key={id}
          title="Unreadable workspace"
          subtitle={id}
          actions={
            <ActionPanel>
              <Action
                title="Remove Unreadable Entry"
                style={Action.Style.Destructive}
                onAction={async () => {
                  if (await confirmAlert({ title: "Remove unreadable workspace " + id + "?" })) {
                    try {
                      await accounts.removeInvalid(id);
                      await revalidate();
                    } catch (error) {
                      await showFailureToast(error);
                    }
                  }
                }}
              />
              {add}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
