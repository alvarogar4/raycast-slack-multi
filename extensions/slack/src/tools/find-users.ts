import { workspaceKey } from "../shared/client/workspaces";
import { getSlackWebClient, getWorkspace } from "../shared/client/WebClient";
import { withSlackClient } from "../shared/withSlackClient";

type Input = {
  /** Slack team ID or unique workspace name. Ask the user to choose when ambiguous. */
  workspace?: string;
  /**
   * A name, display name, username, or email address to search for.
   */
  query: string;
};

async function findUsers(input: Input) {
  const query = input.query.trim().toLocaleLowerCase();
  if (!query) {
    throw new Error("Search query cannot be empty");
  }

  const slackWebClient = getSlackWebClient();
  const matches = [];
  let cursor: string | undefined;

  do {
    const response = await slackWebClient.users.list({ team_id: getWorkspace().teamId, limit: 200, cursor });

    if (response.error) {
      throw new Error(response.error);
    }

    for (const user of response.members ?? []) {
      if (!user.id || user.deleted || user.is_bot || user.is_workflow_bot || user.id === "USLACKBOT") {
        continue;
      }

      const searchableValues = [
        user.name,
        user.real_name,
        user.profile?.display_name,
        user.profile?.real_name,
        user.profile?.email,
      ].filter((value): value is string => Boolean(value));

      if (searchableValues.some((value) => value.toLocaleLowerCase().includes(query))) {
        matches.push({
          id: user.id,
          username: user.name,
          displayName: user.profile?.display_name,
          realName: user.profile?.real_name ?? user.real_name,
          email: user.profile?.email,
          status: user.profile?.status_text,
          timezone: user.tz_label,
          // Slack only provides 1024px for uploaded photos; default avatars and Gravatars stop at 512px.
          photoUrl: user.profile?.image_1024 ?? user.profile?.image_512,
          hasCustomPhoto: user.profile?.is_custom_image ?? false,
        });
      }
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return matches.map((row) => ({ ...row, teamId: getWorkspace().teamId, workspace: workspaceKey(getWorkspace()) }));
}

export default async function run(input: Input) {
  return withSlackClient(input, findUsers);
}
