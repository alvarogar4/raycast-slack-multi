import { performDirectMessageAction } from "./client/directMessage";
import { getSlackWebClient, inWorkspace } from "./client/WebClient";
import { handleError } from "./utils";

import type { Workspace } from "./client/workspaces";

export function directMessageAction(
  workspace: Workspace,
  userId: string,
  conversationId: string | undefined,
  action: (id: string) => Promise<void>,
) {
  return performDirectMessageAction(
    userId,
    conversationId,
    (args) => inWorkspace(workspace, () => getSlackWebClient().conversations.open(args)),
    action,
    (error) => handleError(error, "Failed to open Slack direct message"),
  );
}
