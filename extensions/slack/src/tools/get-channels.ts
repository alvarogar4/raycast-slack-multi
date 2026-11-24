import { workspaceKey } from "../shared/client/workspaces";
import { getSlackWebClient, getWorkspace } from "../shared/client/WebClient";
import { withSlackClient } from "../shared/withSlackClient";

type ResponseGetChannels = {
  id?: string;
  name?: string;
  purpose?: string;
  topic?: string;
};

type Input = {
  /** Slack team ID or unique workspace name. Ask the user to choose when ambiguous. */
  workspace?: string;
};

async function getChannels() {
  const slackWebClient = getSlackWebClient();
  const allChannels: ResponseGetChannels[] = [];
  let cursor: string | undefined = undefined;

  do {
    const response = await slackWebClient.conversations.list({
      exclude_archived: true,
      types: "public_channel,private_channel",
      team_id: getWorkspace().teamId,
      limit: 200,
      cursor: cursor,
    });

    if (response.error) {
      throw new Error(response.error);
    }

    const currentChannels =
      response.channels?.map((channel) => ({
        id: channel.id,
        name: channel.name,
        purpose: channel.purpose?.value,
        topic: channel.topic?.value,
      })) || [];

    allChannels.push(...currentChannels);
    cursor = response.response_metadata?.next_cursor;
  } while (cursor);

  return allChannels.map((row) => ({ ...row, teamId: getWorkspace().teamId, workspace: workspaceKey(getWorkspace()) }));
}

export default async function run(input: Input) {
  return withSlackClient(input, getChannels);
}
