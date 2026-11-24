import { Action, ActionPanel, Color, Form, Icon, Toast, closeMainWindow, showToast } from "@raycast/api";
import { usePromise } from "@raycast/utils";

import { SlackClient } from "./shared/client";
import { WorkspaceTarget, applyToWorkspaces } from "./shared/WorkspaceViews";
import { inWorkspace } from "./shared/client/WebClient";
import type { Workspace } from "./shared/client/workspaces";
import { handleError } from "./shared/utils";

function SetPresence({ targets }: { targets: Workspace[] }) {
  const {
    data: presence,
    isLoading,
    mutate,
  } = usePromise((w: Workspace) => inWorkspace(w, SlackClient.getPresence), [targets[0]], {
    execute: targets.length === 1,
  });

  let currentStatus = "";
  switch (presence) {
    case "online":
      currentStatus = "Online (Auto)";
      break;
    case "offline":
      currentStatus = "Offline (Auto)";
      break;
    case "forced-offline":
      currentStatus = "Offline (Manually)";
      break;
  }

  return (
    <Form
      navigationTitle={targets.length === 1 ? targets[0].teamName : "All Workspaces"}
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Submit"
            onSubmit={async ({ presence }) => {
              try {
                if (presence === "offline") {
                  await applyToWorkspaces(targets, () => SlackClient.setPresence("away"));
                  await closeMainWindow();
                  await showToast({ style: Toast.Style.Success, title: "Force offline" });
                } else {
                  await applyToWorkspaces(targets, () => SlackClient.setPresence("auto"));
                  await closeMainWindow();
                  await showToast({ style: Toast.Style.Success, title: "Auto" });
                }

                await mutate();
              } catch (error) {
                handleError(error, "Could not set presence");
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Current status"
        text={
          targets.length > 1
            ? targets.map((w) => w.teamName).join(", ")
            : `${presence === "online" ? "🟢" : "🔴"} ${currentStatus}`
        }
      />
      <Form.Separator />
      <Form.Dropdown
        id="presence"
        title="Set Presence"
        defaultValue={presence === "forced-offline" ? "auto" : "offline"}
      >
        <Form.Dropdown.Item
          value="offline"
          title="Force offline"
          icon={{ source: Icon.Exclamationmark, tintColor: Color.Red }}
        />
        <Form.Dropdown.Item value="auto" title="Auto" icon={Icon.CircleFilled} />
      </Form.Dropdown>
    </Form>
  );
}

export default function Command() {
  return <WorkspaceTarget allowAll>{(targets) => <SetPresence targets={targets} />}</WorkspaceTarget>;
}
