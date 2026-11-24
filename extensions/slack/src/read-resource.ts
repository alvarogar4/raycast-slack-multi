import { getSlackWebClient, accounts, inWorkspace, getWorkspace } from "./shared/client/WebClient";
import { readChannelMention } from "./shared/client/channelMentions";
import { readUserMention } from "./shared/client/userMentions";
import { resolveWorkspace } from "./shared/client/workspaces";

type Input = {
  /** The URI of a person or channel selected from Slack's Users or Channels mention search. */
  uri: string;
};

async function readResource({ uri }: Input) {
  const client = getSlackWebClient();
  if (uri.startsWith("slack://users/")) {
    return readUserMention(uri, (user) => client.users.info({ user }), getWorkspace());
  }
  if (uri.startsWith("slack://channels/")) {
    return readChannelMention(
      uri,
      (channel) => client.conversations.info({ channel, include_num_members: true }),
      getWorkspace(),
    );
  }
  throw new Error("Unsupported Slack mention URI.");
}

export default async function read({ uri }: Input) {
  const url = new URL(uri);
  const w = resolveWorkspace(
    await accounts.list(),
    url.searchParams.get("workspace") ?? url.pathname.split("/")[1],
    true,
  );
  const registration = url.searchParams.get("registration");
  if (registration && registration !== w.registration) throw new Error("Workspace changed. Select the mention again.");
  url.search = "";
  return inWorkspace(w, () => readResource({ uri: url.toString() }));
}
