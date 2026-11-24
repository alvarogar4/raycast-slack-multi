import { workspaceKey } from "../shared/client/workspaces";
import { getSlackWebClient, getWorkspace } from "../shared/client/WebClient";
import { withSlackClient } from "../shared/withSlackClient";

type Input = {
  /** Slack team ID or unique workspace name. Ask the user to choose when ambiguous. */
  workspace?: string;
  /**
   * A Slack conversation ID or user ID. Conversation IDs start with C, D, or G. User IDs start with U or W and are resolved to a direct-message conversation.
   *
   * @example "C12345678"
   */
  conversation: string;
};

const CONVERSATION_ID_PATTERN = /^[CDG][A-Z0-9]{8,}$/;
const USER_ID_PATTERN = /^[UW][A-Z0-9]{8,}$/;

async function getHuddleLink(input: Input) {
  const conversation = input.conversation.trim().toUpperCase();
  const slackWebClient = getSlackWebClient();
  let channel: string;

  if (CONVERSATION_ID_PATTERN.test(conversation)) {
    channel = conversation;
  } else if (USER_ID_PATTERN.test(conversation)) {
    const openResponse = await slackWebClient.conversations.open({ users: conversation });

    if (openResponse.error) {
      throw new Error(openResponse.error);
    }
    if (!openResponse.channel?.id) {
      throw new Error("Slack did not return a direct message conversation ID");
    }
    channel = openResponse.channel.id;
  } else {
    throw new Error("Conversation must be a Slack conversation ID or user ID");
  }

  const conversationResponse = await slackWebClient.conversations.info({ channel });

  if (conversationResponse.error) {
    throw new Error(conversationResponse.error);
  }
  if (!conversationResponse.channel) {
    throw new Error("Slack did not return conversation info");
  }
  const workspaceId = getWorkspace().teamId;

  return {
    workspaceId,
    channel,
    url: `https://app.slack.com/huddle/${workspaceId}/${channel}`,
  };
}

export default async function run(input: Input) {
  return withSlackClient(input, async (input) => {
    const output = await getHuddleLink(input);
    const source = { teamId: getWorkspace().teamId, workspace: workspaceKey(getWorkspace()) };
    return { ...output, ...source };
  });
}
