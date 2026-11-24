import { rm } from "node:fs/promises";
import { afterAll, expect, it, vi } from "vitest";
import type { AdapterConfig } from "@slack/web-api/dist/WebClient";
import { LaunchType } from "@raycast/api";
import { environment, oauthTokens, OAuth, LocalStorage } from "./raycast";
import {
  accounts,
  addWorkspace,
  connectWorkspace,
  removeWorkspace,
  getSlackWebClient,
  inWorkspace,
} from "../src/shared/client/WebClient";
import { SlackClient } from "../src/shared/client/SlackClient";
import { confirmationWorkspace, workspaceKey } from "../src/shared/client/workspaces";
import SetStatus from "../src/set-status";
import send from "../src/tools/send-message";
import getEmojis from "../src/tools/get-emojis";
import { clearFailedMemberLoad } from "../src/shared/client/memberDirectoryCache";
import { clearFailedConversationLoad } from "../src/shared/client/channelDirectoryCache";
import channelMentions from "../src/tools/search-channel-mentions";
import getHuddleLink from "../src/tools/get-huddle-link";
import readResource from "../src/read-resource";
import { SendMessage } from "../src/shared/SendMessage";

const { browserLogin } = vi.hoisted(() => ({ browserLogin: vi.fn<() => Promise<string>>() }));
vi.mock("@raycast/utils", () => ({
  OAuthService: {
    slack: () => ({
      async authorize(this: { client: InstanceType<typeof OAuth.PKCEClient> }) {
        const token = await browserLogin();
        await this.client.setTokens({ accessToken: token });
        return token;
      },
    }),
  },
  showFailureToast: vi.fn(),
  useCachedPromise: () => ({
    data: { status_text: "private cached text", status_emoji: ":private:", status_expiration: 123 },
  }),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => [initial, vi.fn()],
  useMemo: (calculate: () => unknown) => calculate(),
  useCallback: (fn: unknown) => fn,
  useEffect: vi.fn(),
  useRef: (value: unknown) => ({ current: value }),
}));

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn<AdapterConfig>() }));
vi.mock("@slack/web-api", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@slack/web-api")>();
  return {
    ...sdk,
    WebClient: class extends sdk.WebClient {
      constructor(token?: string, options?: ConstructorParameters<typeof sdk.WebClient>[1]) {
        super(token, { ...options, adapter: dispatch, retryConfig: { retries: 0 } });
      }
    },
  };
});

let directoryRecovered = false;
const calls: { team: string; method: string }[] = [];
dispatch.mockImplementation(async (config) => {
  const team = String(config.headers.Authorization).split("-").pop() ?? "";
  const method = String(config.url).split("/").pop() ?? "";
  const args = new URLSearchParams(String(config.data));
  calls.push({ team, method });
  let data: Record<string, unknown> = { ok: true };
  switch (method) {
    case "auth.test":
      if (team === "TINVALID1") {
        expect([...oauthTokens.values()]).not.toContain("xoxp-fixture-TINVALID1");
        data = { ok: false, error: "invalid_auth" };
        break;
      }
      data = { ok: true, team_id: team, team, user_id: "U00000001" };
      break;
    case "users.list":
    case "conversations.list":
      if (team === "TRETRY001") {
        const cursor = args.get("cursor");
        const items =
          method === "users.list"
            ? {
                members: [
                  {
                    id: cursor ? "U00000002" : "U00000001",
                    team_id: team,
                    name: cursor ? "member-two" : "member-one",
                    real_name: cursor ? "member-two" : "member-one",
                  },
                ],
              }
            : { channels: [{ id: cursor ? "C00000002" : "C00000001", name: cursor ? "two" : "one", is_member: true }] };
        data =
          cursor && !directoryRecovered
            ? { ok: false, error: "internal_error" }
            : { ok: true, ...items, response_metadata: { next_cursor: cursor ? "" : "next" } };
        break;
      }
      expect(args.get("team_id")).toBe(team);
      data = {
        ok: true,
        channels: [{ id: "CSHARED001", name: team, shared_team_ids: ["TPARTNER1"], is_member: true }],
      };
      break;
    case "conversations.info":
      data = {
        ok: true,
        channel: {
          id: args.get("channel"),
          name: team,
          connected_team_ids: ["TPARTNER1"],
          last_read: args.get("channel") === "CUNKNOWN1" ? undefined : "1",
        },
      };
      break;
    case "conversations.history":
      data =
        args.get("channel") === "CBROKEN01"
          ? { ok: false, error: "channel_not_found" }
          : { ok: true, messages: [{ ts: "2.100", text: "hello", user: "U00000001" }] };
      break;
    case "emoji.list":
      data = { ok: true, emoji: { shared: "https://example.org/" + team } };
      break;
    case "users.info":
      data = { ok: true, user: { id: "U00000001", team_id: "TPARTNER1", name: "visitor" } };
      break;
    case "chat.postMessage":
      data = { ok: true, channel: "CSHARED001", ts: "2.100" };
      break;
    case "chat.getPermalink":
      data = { ok: true, permalink: "https://example.slack.com/archives/CSHARED001/p2100" };
      break;
    default:
      throw new Error("Unexpected test API method " + method);
  }
  return { status: 200, statusText: "OK", request: { path: "/api/" + method }, headers: {}, config, data };
});

afterAll(async () => {
  await rm(environment.supportPath, { recursive: true, force: true });
});

it("isolates simultaneous SDK directory scans and follow-up sends for the same Slack ID", async () => {
  const [a, b] = await Promise.all(["TALPHA001", "TBRAVO001"].map((team) => addWorkspace("xoxp-fixture-" + team)));
  const scan = (w: typeof a) =>
    inWorkspace(w, () => SlackClient.searchConversations("", undefined, undefined, "channels"));
  const [first, second] = await Promise.all([scan(a), scan(b)]);
  expect(first[0][0].name).toBe(a.teamId);
  expect(second[0][0].name).toBe(b.teamId);
  const count = calls.filter((c) => c.method === "conversations.list").length;
  await Promise.all([scan(a), scan(b)]);
  expect(calls.filter((c) => c.method === "conversations.list")).toHaveLength(count);
  await expect(send({ recipient: "CSHARED001", text: "fixture" })).rejects.toThrow(/Choose a workspace/);
  await send({ workspace: workspaceKey(b), recipient: "CSHARED001", text: "fixture" });
  expect(calls.filter((c) => c.method === "chat.postMessage")).toEqual([
    { method: "chat.postMessage", team: b.teamId },
  ]);
});

it("uses the source workspace for external mentions, Huddles and failed unread conversations", async () => {
  const w = await addWorkspace("xoxp-fixture-TORIGIN01");
  const info = await readResource({
    uri: "slack://users/TPARTNER1/U00000001?workspace=" + w.teamId + "&registration=" + w.registration,
  });
  expect(JSON.parse(info.text)).toMatchObject({
    teamId: w.teamId,
    workspace: workspaceKey(w),
    url: "slack://user?team=TORIGIN01&id=U00000001",
  });
  const huddle = await getHuddleLink({ workspace: w.teamId, conversation: "CSHARED001" });
  expect(huddle.url).toBe("https://app.slack.com/huddle/TORIGIN01/CSHARED001");
  const unread = await inWorkspace(w, () =>
    SlackClient.getUnreadConversations(["CSHARED001", "CBROKEN01", "CUNKNOWN1"]),
  );
  expect(unread.conversations.map((c) => c.conversationId)).toEqual(["CSHARED001"]);
  expect(unread.failed).toEqual(["CBROKEN01", "CUNKNOWN1"]);
  const legacy = "slack://channels/TPARTNER1/CSHARED001?workspace=" + w.teamId + "&registration=" + w.registration;
  expect(JSON.parse((await readResource({ uri: legacy })).text).workspace).toBe(workspaceKey(w));
  await expect(readResource({ uri: legacy.replace("channels/TPARTNER1", "channels/TUNKNOWN1") })).rejects.toThrow(
    /different workspace/,
  );
  const mentions = await channelMentions({ workspace: workspaceKey(w), query: w.teamName });
  expect(JSON.parse((await readResource(mentions[0])).text)).toMatchObject({
    teamId: w.teamId,
    workspace: workspaceKey(w),
  });
});

it("rejects later requests on an already-acquired SDK client and confirmations from a replaced registration", async () => {
  const w = await addWorkspace("xoxp-fixture-TREVOKE01");
  const client = await inWorkspace(w, getSlackWebClient);
  const selector = workspaceKey(w);
  expect(confirmationWorkspace(await accounts.list(), selector)).toEqual(w);
  await accounts.remove(w);
  const replacement = await addWorkspace("xoxp-fixture-TREVOKE01");
  expect(workspaceKey(replacement)).not.toBe(selector);
  const before = calls.length;
  await expect(client.conversations.info({ channel: "CSHARED001" })).rejects.toThrow(/Workspace changed/);
  expect(calls).toHaveLength(before);
  expect(() => confirmationWorkspace([replacement], selector)).toThrow();
});

it("keeps an expired scheduled message in the composer", async () => {
  const w = await addWorkspace("xoxp-fixture-TSCHED001");
  const composer = SendMessage({ workspace: w, recipient: "CSHARED001", recipientName: "fixture" });
  const before = calls.length;
  await composer.props.actions.props.children.props.onSubmit({
    sendNow: false,
    scheduledTime: new Date(0),
    message: "fixture",
  });
  expect(calls).toHaveLength(before);
});

it("never seeds a bulk status form with the single workspace's cached text and emoji", async () => {
  const targets = await Promise.all(["TSTATUS01", "TSTATUS02"].map((team) => addWorkspace("xoxp-fixture-" + team)));
  const command = SetStatus({
    arguments: { statusText: "", emoji: "", expiration: "" },
    launchType: LaunchType.UserInitiated,
  });
  const entry = command.props.children(targets);
  const view = entry.type(entry.props);
  const form = view.props.children[1].props.children[0].props.actions.props.children.props.target;
  expect(form.props.formInitialValues).toMatchObject({ statusText: "", emoji: "keep", duration: "keep" });
});

it("keeps two browser logins independent through cancellation, duplicates and removal", async () => {
  browserLogin.mockResolvedValueOnce("xoxp-fixture-TOAUTH001").mockResolvedValueOnce("xoxp-fixture-TOAUTH002");
  const a = await connectWorkspace();
  const b = await connectWorkspace();
  expect(JSON.parse((await LocalStorage.getItem("workspace:" + a.teamId))!)).toEqual({ ...a, auth: "oauth" });
  const both = new Map(oauthTokens);
  expect(both.size).toBe(2);
  browserLogin.mockResolvedValueOnce("xoxp-fixture-TINVALID1");
  await expect(connectWorkspace()).rejects.toThrow(/invalid_auth/);
  browserLogin.mockRejectedValueOnce(new Error("Cancelled"));
  await expect(connectWorkspace()).rejects.toThrow("Cancelled");
  browserLogin.mockResolvedValueOnce("xoxp-fixture-TOAUTH001");
  await expect(connectWorkspace()).rejects.toThrow(/already connected/);
  expect(oauthTokens).toEqual(both);
  for (const w of [a, b]) {
    expect(await getEmojis({ workspace: workspaceKey(w) })).toMatchObject({
      workspace: workspaceKey(w),
      teamId: w.teamId,
      emojis: { shared: "https://example.org/" + w.teamId },
    });
  }
  const client = await inWorkspace(a, getSlackWebClient);
  const cachedMessages = new Map([
    [workspaceKey(a), "private message"],
    [workspaceKey(b), "other message"],
  ]);
  oauthTokens.delete("slack-workspace-" + a.registration);
  expect((await accounts.list()).map((w) => cachedMessages.get(workspaceKey(w))).filter(Boolean)).toEqual([
    "other message",
  ]);
  expect((await accounts.inspect()).disconnected).toContainEqual(a);
  const before = calls.length;
  await expect(client.emoji.list()).rejects.toThrow(/Sign-in expired/);
  expect(calls).toHaveLength(before);
  browserLogin.mockResolvedValueOnce("xoxp-fixture-TOAUTH001");
  const reconnected = await connectWorkspace();
  expect(reconnected.registration).not.toBe(a.registration);
  await expect(removeWorkspace(a)).rejects.toThrow(/Workspace changed/);
  await removeWorkspace(reconnected);
  await removeWorkspace(b);
  expect(oauthTokens.size).toBe(0);
});

it("requires an original workspace and registration on every mention read", async () => {
  const w = await addWorkspace("xoxp-fixture-TPARTNER1");
  const uri = "slack://users/TPARTNER1/U00000001";
  const before = calls.length;
  for (const query of ["", "?workspace=" + w.teamId, "?registration=" + w.registration]) {
    await expect(readResource({ uri: uri + query })).rejects.toThrow(/Select the Slack mention again/);
  }
  expect(calls).toHaveLength(before);
});

it("retries partial member and channel directories with the same query", async () => {
  const w = await addWorkspace("xoxp-fixture-TRETRY001");
  const partial = vi.fn();
  const members = () =>
    inWorkspace(w, () => SlackClient.searchDirectoryMembers("member", undefined, undefined, partial));
  const channels = () => channelMentions({ workspace: workspaceKey(w), query: "two" });
  expect((await members()).users.map((u) => u.name)).toEqual(["member-one"]);
  expect(partial).toHaveBeenCalledOnce();
  await expect(channels()).rejects.toThrow(/Could not search/);
  await expect(channels()).rejects.toThrow(/Could not search/);
  directoryRecovered = true;
  clearFailedMemberLoad(workspaceKey(w));
  clearFailedConversationLoad(workspaceKey(w));
  expect((await members()).users.map((u) => u.name)).toEqual(["member-one", "member-two"]);
  expect((await channels()).map((c) => c.title)).toEqual(["#two · " + w.teamName]);
});
