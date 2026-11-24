import { Form, ActionPanel, Action, showToast, Toast, showHUD, PopToRootType } from "@raycast/api";
import { useState } from "react";
import type { Workspace } from "./client/workspaces";

import { getSlackWebClient, inWorkspace } from "./client/WebClient";
import { handleError } from "./utils";

interface FormValues {
  message: string;
  scheduledTime: Date | null;
  sendNow: boolean;
}

interface SendMessageProps {
  workspace: Workspace;
  recipient: string;
  recipientName: string;
}

export function SendMessage({ workspace, recipient, recipientName }: SendMessageProps) {
  const [sendNow, setSendNow] = useState(true);
  async function handleSubmit(values: FormValues) {
    if (values.message.trim() === "") {
      await showToast({
        style: Toast.Style.Failure,
        title: "Invalid message",
        message: "Please enter a message",
      });
      return;
    }

    try {
      await inWorkspace(workspace, async () => {
        const client = getSlackWebClient();
        const messageParams = {
          channel: recipient,
          text: values.message,
        };

        if (!values.sendNow) {
          if (!values.scheduledTime || !(values.scheduledTime.getTime() > Date.now()))
            throw new Error("Choose a future time to schedule this message.");
          await client.chat.scheduleMessage({
            ...messageParams,
            post_at: Math.floor(values.scheduledTime.getTime() / 1000),
          });
          await showHUD(`Message scheduled to ${recipientName} for ${values.scheduledTime.toLocaleString()}`, {
            popToRootType: PopToRootType.Immediate,
          });
        } else {
          // Send now
          await client.chat.postMessage(messageParams);
          await showHUD(`Message to ${recipientName} sent successfully`, { popToRootType: PopToRootType.Immediate });
        }
      });
    } catch (error) {
      handleError(error);
    }
  }

  return (
    <Form
      navigationTitle={workspace.teamName}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Send Message" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description title="Send to" text={recipientName + " · " + workspace.teamName} />
      <Form.TextArea id="message" title="Message" placeholder="Type your message here..." enableMarkdown />
      <Form.Checkbox id="sendNow" label="Send Now" defaultValue={true} onChange={setSendNow} />
      {!sendNow && (
        <Form.DatePicker id="scheduledTime" title="Schedule Send" defaultValue={new Date(Date.now() + 30 * 60_000)} />
      )}
    </Form>
  );
}
