import { workspaceKey } from "../shared/client/workspaces";
import { getSlackWebClient, getWorkspace } from "../shared/client/WebClient";
import { withSlackClient } from "../shared/withSlackClient";

type Input = {
  /** Slack team ID or unique workspace name. Ask the user to choose when ambiguous. */
  workspace?: string;
};

async function getUsers() {
  const slackWebClient = getSlackWebClient();
  const result = [];
  let cursor: string | undefined;
  do {
    const page = await slackWebClient.users.list({ team_id: getWorkspace().teamId, limit: 200, cursor });
    result.push(
      ...(page.members ?? []).map((u) => ({
        id: u.id,
        name: u.name,
        realName: u.real_name,
        status: u.profile?.status_text,
        timezone: u.tz_label,
      })),
    );
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return result.map((row) => ({ ...row, teamId: getWorkspace().teamId, workspace: workspaceKey(getWorkspace()) }));
}

export default async function run(input: Input) {
  return withSlackClient(input, getUsers);
}
