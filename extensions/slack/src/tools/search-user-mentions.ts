import { SlackClient } from "../shared/client/SlackClient";
import { toUserMentions } from "../shared/client/userMentions";
import { workspaceMentions } from "../shared/withSlackClient";

type Input = {
  /** Slack team ID or unique workspace name. Ask the user to choose when ambiguous. */
  workspace?: string;
  /** What the user typed in the Users mention search, empty for the default list. */
  query: string;
};

async function searchUserMentions(input: Input) {
  return toUserMentions(await SlackClient.searchUsers(input.query));
}

export default async function run(input: Input) {
  return workspaceMentions(input, searchUserMentions);
}
