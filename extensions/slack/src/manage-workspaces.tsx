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
import { useRef, useState } from "react";
import { accounts, addWorkspace, connectWorkspace, removeWorkspace } from "./shared/client/WebClient";
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
  const connecting = useRef(false);
  const [busy, setBusy] = useState(false);
  async function connect() {
    if (connecting.current) return;
    connecting.current = true;
    setBusy(true);
    try {
      const workspace = await connectWorkspace();
      await revalidate();
      await showToast(Toast.Style.Success, "Connected to " + workspace.teamName);
    } catch (error) {
      await showFailureToast(error, { title: "Could not connect workspace" });
    } finally {
      connecting.current = false;
      setBusy(false);
    }
  }
  const add = (
    <>
      <Action title="Connect with Slack" icon={Icon.Plus} onAction={connect} />
      <Action.Push title="Add with User Token" target={<Editor saved={revalidate} />} />
    </>
  );
  return (
    <List isLoading={isLoading || busy}>
      <List.EmptyView
        title="Connect a Slack Workspace"
        description="Choose Connect with Slack, then select your workspace in the browser."
        actions={<ActionPanel>{add}</ActionPanel>}
      />
      {data &&
        [...data.valid, ...data.disconnected].map((w) => (
          <List.Item
            key={w.teamId}
            title={w.teamName}
            subtitle={data.disconnected.includes(w) ? "Signed out · " + w.teamId : w.teamId}
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
                        await removeWorkspace(w);
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
