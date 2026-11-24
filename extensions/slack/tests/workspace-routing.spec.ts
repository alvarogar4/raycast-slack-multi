import { rm } from "node:fs/promises";
import { afterAll, expect, it, vi } from "vitest";
import type { AdapterConfig } from "@slack/web-api/dist/WebClient";
import { environment } from "./raycast";
import { accounts, addWorkspace, getSlackWebClient, inWorkspace } from "../src/shared/client/WebClient";
import { SlackClient } from "../src/shared/client/SlackClient";
import { confirmationWorkspace, workspaceKey } from "../src/shared/client/workspaces";
import SetStatus from "../src/set-status";
import send from "../src/tools/send-message";
import getHuddleLink from "../src/tools/get-huddle-link";
import readResource from "../src/read-resource";
import { SendMessage } from "../src/shared/SendMessage";

vi.mock("@raycast/utils", () => ({
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

const calls: { team: string; method: string }[] = [];
dispatch.mockImplementation(async (config) => {
  const team = String(config.headers.Authorization).split("-").pop() ?? "";
  const method = String(config.url).split("/").pop() ?? "";
  const args = new URLSearchParams(String(config.data));
  calls.push({ team, method });
  let data: Record<string, unknown> = { ok: true };
  switch (method) {
    case "auth.test":
      data = { ok: true, team_id: team, team, user_id: "U00000001" };
      break;
    case "conversations.list":
      expect(args.get("team_id")).toBe(team);
      data = {
        ok: true,
        channels: [{ id: "CSHARED001", name: team, shared_team_ids: ["TPARTNER1"], is_member: true }],
      };
      break;
    case "conversations.info":
      data = { ok: true, channel: { id: args.get("channel"), internal_team_ids: ["TPARTNER1", team], last_read: "1" } };
      break;
    case "conversations.history":
      data =
        args.get("channel") === "CBROKEN01"
          ? { ok: false, error: "channel_not_found" }
          : { ok: true, messages: [{ ts: "2.100", text: "hello", user: "U00000001" }] };
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
  const unread = await inWorkspace(w, () => SlackClient.getUnreadConversations(["CSHARED001", "CBROKEN01"]));
  expect(unread.conversations.map((c) => c.conversationId)).toEqual(["CSHARED001"]);
  expect(unread.failed).toEqual(["CBROKEN01"]);
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
  const command = SetStatus({ arguments: {}, launchType: "userInitiated" });
  const entry = command.props.children(targets);
  const view = entry.type(entry.props);
  const form = view.props.children[1].props.children[0].props.actions.props.children.props.target;
  expect(form.props.formInitialValues).toMatchObject({ statusText: "", emoji: "keep", duration: "keep" });
});
