import { workspaceKey } from "../shared/client/workspaces";
import { getWorkspace, getSlackWebClient } from "../shared/client/WebClient";
import { withSlackClient } from "../shared/withSlackClient";

type Input = {
  /** Slack team ID or unique workspace name. Ask the user to choose when ambiguous. */
  workspace?: string;
};

async function getEmojis() {
  const slackWebClient = getSlackWebClient();
  const emojis = await slackWebClient.emoji.list();

  if (emojis.error) {
    throw new Error(emojis.error);
  }

  return { teamId: getWorkspace().teamId, workspace: workspaceKey(getWorkspace()), emojis: emojis.emoji };
}

export default async function run(input: Input) {
  return withSlackClient(input, getEmojis);
}
