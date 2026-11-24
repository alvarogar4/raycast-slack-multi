import { confirmationWorkspace } from "../shared/client/workspaces";
import { accounts } from "../shared/client/WebClient";
import { Tool } from "@raycast/api";
import { getSlackWebClient } from "../shared/client/WebClient";
import { normalizeChannelName, parseChannelId, renameChannel } from "../shared/client/renameChannel";
import { withSlackClient } from "../shared/withSlackClient";

type Input = {
  /** Current workspace identifier (team ID and registration). Use the identifier returned by a workspace lookup, or retry using the identifier supplied when choosing a team ID. */
  workspace?: string;
  /**
   * The ID of the Slack channel to rename. Channel IDs start with C or G and can be found with Get Channels.
   *
   * @example "C12345678"
   */
  channel: string;
  /**
   * The new channel name, without the leading #. Slack channel names are lowercase and use hyphens instead of
   * spaces; uppercase letters and spaces are converted automatically. Maximum 80 characters.
   *
   * @example "project-launch"
   */
  name: string;
};

export const confirmation: Tool.Confirmation<Input> = async (input) => {
  const workspace = confirmationWorkspace(await accounts.list(), input.workspace);
  const channel = parseChannelId(input.channel);
  const name = normalizeChannelName(input.name);
  return {
    message: `Rename this channel to #${name}?`,
    info: [
      { name: "Workspace", value: workspace.teamName + " (" + workspace.teamId + ")" },
      { name: "Channel", value: channel },
      { name: "New Name", value: `#${name}` },
    ],
  };
};

async function renameChannelTool(input: Input) {
  const slackWebClient = getSlackWebClient();
  return renameChannel(input.channel, input.name, (args) => slackWebClient.conversations.rename(args));
}

export default async function run(input: Input) {
  return withSlackClient(input, renameChannelTool, "confirmed");
}
