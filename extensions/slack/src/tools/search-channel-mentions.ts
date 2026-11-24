import { loadConversationDirectoryPage, loadMemberChannelDirectoryPage } from "../shared/client/SlackClient";
import { searchChannelMentions } from "../shared/client/channelMentions";
import { workspaceMentions } from "../shared/withSlackClient";

type Input = {
  /** Slack team ID or unique workspace name. Ask the user to choose when ambiguous. */
  workspace?: string;
  /** What the user typed in the Channels mention search, empty for the default list. */
  query: string;
};

async function searchChannels(input: Input) {
  return searchChannelMentions(input.query, {
    loadMemberChannelsPage: loadMemberChannelDirectoryPage,
    loadChannelsPage: loadConversationDirectoryPage,
  });
}

export default async function run(input: Input) {
  return workspaceMentions(input, searchChannels);
}
