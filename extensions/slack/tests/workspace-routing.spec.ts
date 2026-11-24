import { runInNewContext } from "node:vm";
import { readFile, rm } from "node:fs/promises";
import { afterAll, expect, it, vi } from "vitest";
import type { AdapterConfig } from "@slack/web-api/dist/WebClient";
import { LaunchType, List } from "@raycast/api";
import { createElement } from "react";
import SearchMessages, { openSearchMessage, searchMessagePages } from "../src/search-messages";
import { environment, oauthTokens, OAuth, LocalStorage, getApplications, open, showHUD } from "./raycast";
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
import { favoriteId, readFavorites, saveFavorite } from "../src/shared/client/favorites";
import { loadConversationActivity } from "../src/shared/client/conversationActivity";
import { namedDirectoryRows } from "../src/search";
import { orderMessageResults } from "../src/shared/client/conversationOrder";
import OpenUnreadMessages from "../src/open-unread-messages";
import { directorySelection } from "../src/shared/ConversationList";
import send from "../src/tools/send-message";
import getEmojis from "../src/tools/get-emojis";
import {
  clearFailedMemberLoad,
  getMemberPage,
  memberDirectoryRevision,
  subscribeMemberDirectory,
} from "../src/shared/client/memberDirectoryCache";
import { clearFailedConversationLoad } from "../src/shared/client/channelDirectoryCache";
import channelMentions from "../src/tools/search-channel-mentions";
import getHuddleLink from "../src/tools/get-huddle-link";
import readResource from "../src/read-resource";
import { SendMessage } from "../src/shared/SendMessage";

const { browserLogin, readPromise, unreadMenu } = vi.hoisted(() => ({
  browserLogin: vi.fn<() => Promise<string>>(),
  readPromise: vi.fn(),
  unreadMenu: vi.fn(),
}));

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
  withCache: (fn: unknown) => fn,
  usePromise: readPromise,
  runAppleScript: unreadMenu,
  runPowerShellScript: unreadMenu,
  useCachedState: (_key: string, initial: unknown) => [initial, vi.fn()],
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

let rejectOldSearch: () => void;
const pendingGrant = new Promise<void>((resolve) => {
  rejectOldSearch = resolve;
});
let directoryRecovered = false;
let failReplyRefresh = false;
const calls: { team: string; method: string }[] = [];
dispatch.mockImplementation(async (config) => {
  const team = String(config.headers.Authorization).split("-").pop() ?? "";
  const method = String(config.url).split("/").pop() ?? "";
  const args = new URLSearchParams(String(config.data));
  calls.push({ team, method });
  if (team === "TQUEUE429" && method === "conversations.list")
    return { status: 429, statusText: "rate limited", headers: { "retry-after": "1" }, config, data: {} };
  let data: Record<string, unknown> = { ok: true };
  switch (method) {
    case "search.messages": {
      if (team === "TREVOKE" && args.get("query") === "old") {
        await pendingGrant;
        data = { ok: false, error: "token_revoked" };
        break;
      }
      const second = args.get("page") === "2";
      data = {
        ok: true,
        messages: {
          paging: { pages: 2 },
          matches: [
            { channel: { id: second ? "C2" : "C1" }, ts: second ? "70" : "100", user: "UPEER" },
            { channel: { id: "C1" }, ts: "200", user: "U00000001" },
          ],
        },
      };
      break;
    }
    case "conversations.replies":
      if (team === "TORDERBASE") {
        if (failReplyRefresh) data = { ok: false, error: "missing_scope" };
        else
          data = args.get("cursor")
            ? { ok: true, messages: [{ ts: "115", user: "UPEER" }] }
            : {
                ok: true,
                messages: [{ ts: "112", user: "U00000001" }],
                has_more: true,
                response_metadata: { next_cursor: "replies-2" },
              };
        break;
      }
      data = {
        ok: true,
        messages: [
          { ts: "115", user: "UPEER" },
          { ts: "125", user: "U00000001" },
        ],
      };
      break;
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
      if (team.startsWith("TORDER")) {
        const count = team === "TORDERBASE" ? 3 : 300;
        data = {
          ok: true,
          channels: Array.from({ length: count }, (_, i) => ({
            id: "C" + (i + 1),
            name: "channel" + i,
            is_member: true,
          })),
        };
        break;
      }
      if (team === "TDIRECT01" || team === "TDIRECT02") {
        const cursor = args.get("cursor");
        const peer = {
          id: "U00000101",
          name: "peer",
          team_id: team,
          real_name: "Late Member " + team,
          profile: { email: "late@example.org" },
        };
        const items =
          method === "users.list"
            ? {
                members: cursor
                  ? [
                      peer,
                      { id: "UDELETED1", name: "former", team_id: team, deleted: true },
                      { id: "UBOT00101", name: "bot", is_bot: true, profile: { display_name: "Support Bot" } },
                    ]
                  : Array.from({ length: 100 }, (_, i) => ({ id: "UMEMBER" + i, name: "member" + i, team_id: team })),
              }
            : {
                channels: [
                  { id: "C00000001", name: "general" },
                  { id: "D00000001", is_im: true, user: peer.id },
                  { id: "D00000002", is_im: true, user: "UBOT00101" },
                  { id: "D00000003", is_im: true, user: "UUNKNOWN1" },
                  { id: "D00000004", is_im: true, user: "UEXTERNAL" },
                ],
              };
        data = {
          ok: true,
          ...items,
          response_metadata: { next_cursor: method === "users.list" && !cursor ? "next" : "" },
        };
        break;
      }
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
          user: args.get("channel") === "DORDEREVT" ? "UPEER" : undefined,
          connected_team_ids: ["TPARTNER1"],
          last_read: args.get("channel") === "CUNKNOWN1" ? undefined : "1",
        },
      };
      break;
    case "conversations.history":
      if (args.get("channel") === "DORDEREVT") {
        data = {
          ok: true,
          messages: [
            { ts: "100", user: "UPEER", subtype: "channel_join", text: "joined" },
            { ts: "90", user: "UPEER", text: "hello" },
          ],
        };
        break;
      }
      if (team.startsWith("TORDER")) {
        data =
          team === "TORDERDENY"
            ? { ok: false, error: "missing_scope" }
            : {
                ok: true,
                messages:
                  args.get("channel") === "C1"
                    ? [
                        { ts: "110", user: "UPEER" },
                        { ts: "90", user: "UPEER", latest_reply: "125" },
                      ]
                    : [{ ts: "20", user: "UPEER" }],
              };
        break;
      }
      data =
        args.get("channel") === "CBROKEN01"
          ? { ok: false, error: "channel_not_found" }
          : { ok: true, messages: [{ ts: "2.100", text: "hello", user: "U00000001" }] };
      break;
    case "emoji.list":
      data = { ok: true, emoji: { shared: "https://example.org/" + team } };
      break;
    case "users.info":
      if (args.get("user") === "UEXTERNAL") {
        data = { ok: true, user: { id: "UEXTERNAL", profile: { display_name: "External Guest" } } };
        break;
      }
      if (args.get("user") === "UUNKNOWN1") {
        data = { ok: false, error: "access_denied" };
        break;
      }
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

it("merges Slack message timestamps and relevance ranks from different workspaces", () => {
  const a = { id: "a/C1/12.000001", timestamp: 12.000001, score: 4, position: 0 };
  const b = { id: "b/C1/12.000002", timestamp: 12.000002, score: 6, position: 0 };
  const c = { id: "a/C2/10", timestamp: 10, score: 5, position: 1 };
  expect(orderMessageResults([a, c, b], "timestamp")).toEqual([b, a, c]);
  expect(orderMessageResults([a, c, b], "score")).toEqual([b, c, a]);
  const missing = { ...a, score: undefined };
  expect(orderMessageResults([missing, c, b], "score")).toEqual([b, c, missing]);
});

it("renders mixed search results, keeps additional pages reachable, and isolates a failed workspace", () => {
  const teams = ["A", "B"].map((name) => ({ teamId: "T" + name, teamName: name, userId: "U1", registration: name }));
  let rejectFirst = false;
  let directoryFailed = false;
  let directoryRevoked = false;
  let appsOnly = false;
  const loadMore = vi.fn();
  const retryMembers = vi.fn();
  const channel = { id: "C1", name: "general" };
  const app = { id: "D1", is_im: true, user: "UBOT" };
  readPromise.mockImplementation((fn, args) => {
    if (!args) return { data: new Set() };
    const [w, query, sort] = args;
    if (fn !== searchMessagePages)
      return directoryFailed
        ? {
            error: directoryRevoked ? { data: { error: "invalid_auth" } } : new Error("temporarily unavailable"),
            revalidate: retryMembers,
          }
        : {
            data: {
              users: [],
              usersById: new Map(),
              apps: new Map([["UBOT", "Bot"]]),
              imPeers: new Map([["D1", "UBOT"]]),
            },
          };
    const matches =
      w.teamId === "TA"
        ? [
            { channel, text: "newest", ts: "30.000001" },
            { channel: app, text: "hidden app", ts: "50" },
            { channel, text: "oldest", ts: "10" },
          ]
        : [{ channel, text: "middle", ts: "20" }];
    return {
      data: [
        {
          workspace: workspaceKey(w),
          hasMore: w.teamId === "TA",
          query,
          sort,
          matches: appsOnly && w.teamId === "TA" ? matches.filter((m) => m.channel.id === "D1") : matches,
        },
      ],
      error: rejectFirst && w.teamId === "TA" ? new Error("invalid_auth") : undefined,
      pagination: { hasMore: false, onLoadMore: loadMore },
    };
  });
  const elements = () => {
    const merged = SearchMessages().props.merged(teams, "query", (rows: unknown) => rows, vi.fn());
    const first = merged.type(merged.props).props.children;
    const second = first.type(first.props).props.children;
    const list = second.type(second.props);
    return list.type(list.props);
  };
  const render = () => elements().map((item: ReturnType<typeof createElement<List.Item.Props>>) => item.props.title);
  const more = elements().at(-1).props.actions.props.children[0].props.onAction;
  more();
  more();
  expect(loadMore).toHaveBeenCalledTimes(1);
  expect(render()).toEqual(["newest", "middle", "oldest", "Load more messages"]);
  appsOnly = true;
  expect(render()).toEqual(["middle", "Load more messages"]);
  appsOnly = false;
  rejectFirst = true;
  expect(render()).toEqual(["middle", "Could not search messages"]);
  rejectFirst = false;
  directoryFailed = true;
  expect(render()).toEqual([
    "newest",
    "middle",
    "oldest",
    "Could not load direct message profiles",
    "Load more messages",
  ]);
  directoryRevoked = true;
  expect(render()).toEqual([
    "Reconnect this workspace to search messages",
    "Reconnect this workspace to search messages",
  ]);
  readPromise.mockReset();
});

it("requests the next Slack page in the original workspace", async () => {
  const w = await addWorkspace("xoxp-fixture-TPAGEUI");
  const load = searchMessagePages(w, "query", "timestamp");
  const first = await load({ page: 0 });
  const second = await load({ page: 1 });
  expect(first.hasMore).toBe(true);
  expect(second.hasMore).toBe(false);
  expect(first.data[0].workspace).toBe(workspaceKey(w));
  expect(second.data[0].matches[0].channel?.id).toBe("C2");
});

it("reports a late rejection to the owning workspace after its newer query succeeds", async () => {
  const w = await addWorkspace("xoxp-fixture-TREVOKE");
  const rejected = vi.fn();
  const old = searchMessagePages(w, "old", "timestamp", rejected)({ page: 1 });
  await searchMessagePages(w, "new", "timestamp", rejected)({ page: 0 });
  expect(rejected).not.toHaveBeenCalled();
  rejectOldSearch();
  await expect(old).rejects.toThrow("token_revoked");
  expect(rejected).toHaveBeenCalledOnce();
});

it("opens search matches in Slack and resolves a missing browser permalink in the originating workspace", async () => {
  const w = await addWorkspace("xoxp-fixture-TOPENMSG");
  getApplications.mockResolvedValue([{ name: "Slack", path: "/Applications/Slack.app" }]);
  await openSearchMessage(
    w,
    "123.000045",
    "C1",
    "https://example.slack.com/archives/C1/p123000045?thread_ts=120.000001",
  );
  expect(open).toHaveBeenLastCalledWith("slack://channel?team=TOPENMSG&id=C1&message=123.000045&thread_ts=120.000001");
  getApplications.mockResolvedValue([]);
  open.mockRejectedValueOnce(new Error("No handler for slack://"));
  await openSearchMessage(w, "123.000045", "C1");
  expect(calls.filter((call) => call.team === w.teamId && call.method === "chat.getPermalink")).toHaveLength(1);
  expect(open).toHaveBeenLastCalledWith("https://example.slack.com/archives/CSHARED001/p2100");
});

it("sends the Mac Unreads shortcut only to the chosen Slack process and checks the resulting view", async () => {
  const script = await readFile(new URL("../assets/open-unreads.jxa", import.meta.url), "utf8");
  const base = "https://app.slack.com/client/TSELECTED";
  function navigate(urls: string[], switchesToUnreads: boolean, switchBeforeDispatch = false) {
    let time = 0;
    let step = 0;
    let windowTitle = "Threads - Workspace - Slack";
    const post = vi.fn((_pid: number, event: { code: number; down: boolean }) => {
      if (!event.down && switchesToUnreads) windowTitle = "Unread Messages - Workspace - Slack";
    });
    let reads = 0;
    const webArea = {
      role: () => "AXWebArea",
      attributes: {
        byName: () => ({
          value: () =>
            switchBeforeDispatch && ++reads > 1 ? base + "OTHER/C1" : urls[Math.min(step, urls.length - 1)],
        }),
      },
    };
    const proc = {
      attributes: { byName: () => ({ value: () => webArea }) },
      windows: [{ name: () => windowTitle }],
    };
    const result = runInNewContext(script + "\nrun(['TSELECTED'])", {
      ObjC: { import: vi.fn() },
      Application: () => ({ applicationProcesses: { whose: () => [proc] } }),
      Date: { now: () => time },
      delay: () => {
        step++;
        time += 1000;
      },
      $: {
        NSWorkspace: {
          sharedWorkspace: {
            frontmostApplication: { bundleIdentifier: { js: "com.tinyspeck.slackmacgap" }, processIdentifier: 42 },
          },
        },
        NSEvent: {
          eventWithCGEvent: ({ code }: { code: number }) => ({
            charactersIgnoringModifiers: { js: code === 12 ? "A" : "Q" },
          }),
        },
        CGEventCreateKeyboardEvent: (_source: unknown, code: number, down: boolean) => ({ code, down }),
        CGEventSetFlags: vi.fn(),
        CGEventPostToPid: post,
        kCGEventFlagMaskCommand: 1048576,
        kCGEventFlagMaskShift: 131072,
      },
    });
    return { result, post };
  }
  const wrong = navigate([base + "OTHER/C1"], true);
  expect(wrong.result).toBe("manual");
  expect(wrong.post).not.toHaveBeenCalled();
  const interrupted = navigate([base], true, true);
  expect(interrupted.result).toBe("manual");
  expect(interrupted.post).not.toHaveBeenCalled();
  const switched = navigate([base + "OTHER/C1", base], true);
  expect(switched.result).toBe("opened");
  expect(switched.post.mock.calls).toEqual([
    [42, { code: 12, down: true }],
    [42, { code: 12, down: false }],
  ]);
  const ignored = navigate([base], false);
  expect(ignored.result).toBe("manual");
  expect(ignored.post).toHaveBeenCalledTimes(2);
});

it("asks for a workspace and opens its Unreads in the installed app, including on menu failure", async () => {
  unreadMenu.mockResolvedValue("opened");
  getApplications.mockResolvedValue([{ name: "Slack", path: "/Applications/Slack.app" }]);
  const workspaces = ["TFIRST", "TSECOND"].map((teamId) => ({
    teamId,
    teamName: "Shared name",
    registration: teamId,
    userId: "U1",
  }));
  const command = OpenUnreadMessages();
  for (const teams of [workspaces, workspaces.slice(1)]) {
    readPromise.mockReturnValue({ data: teams });
    const list = command.type(command.props);
    expect(list.props.navigationTitle).toBe("Choose Workspace");
    const items = list.props.children;
    expect(items.map((item: ReturnType<typeof createElement<List.Item.Props>>) => item.props.id)).toEqual(
      teams.map((w) => w.teamId),
    );
    for (const [index, team] of teams.entries()) {
      const item = items[index];
      expect(item.props.subtitle).toBe(teams.length > 1 ? team.teamId : undefined);
      await item.props.actions.props.children.props.onAction();
      expect(open).toHaveBeenLastCalledWith("slack://open?team=" + team.teamId);
      expect(unreadMenu).toHaveBeenCalled();
    }
  }
  const action = command.props.action(workspaces[1]).props.onAction;
  unreadMenu.mockRejectedValueOnce(new Error("unavailable"));
  open.mockClear();
  await action();
  expect(open).toHaveBeenCalledExactlyOnceWith("slack://open?team=TSECOND");
  expect(showHUD).toHaveBeenLastCalledWith(expect.stringContaining("Shared name"));
  getApplications.mockResolvedValue([]);
  open.mockClear();
  unreadMenu.mockClear();
  open.mockRejectedValueOnce(new Error("No handler for slack://"));
  await action();
  expect(open.mock.calls).toEqual([["slack://open?team=TSECOND"], ["https://app.slack.com/client/TSECOND/unreads"]]);
  expect(unreadMenu).not.toHaveBeenCalled();
  readPromise.mockReset();
});

function picker(ids: string[], chosen: string | null, choose: (id: string | null) => void, scope = "all") {
  return directorySelection(
    ids.map((id) => ({ id, element: createElement(List.Item, { id, title: id }) })),
    scope,
    chosen,
    choose,
  );
}

it("distinguishes late automatic focus from Down to the same person after results are reranked", () => {
  const choose = vi.fn();
  const person = "work:1/U1";
  const favorite = "other:2/U1";
  const retry = "other:2/retry-directory";
  const initial = picker([retry], null, choose);
  const partial = picker([person, retry], null, choose);
  const ready = picker([favorite, person, retry], null, choose);
  expect(ready.selection.selectedItemId).toBe(ready.items[0].props.id);
  expect(ready.items[0].props.title).toBe(favorite);
  for (const state of [initial, partial, ready, partial]) {
    ready.selection.onSelectionChange(state.selection.selectedItemId!);
  }
  expect(choose).not.toHaveBeenCalled();
  const selectedPerson = ready.items[1].props.id!;
  ready.selection.onSelectionChange(selectedPerson);
  expect(choose).toHaveBeenCalledExactlyOnceWith(selectedPerson);
  const reranked = picker([person, favorite, retry], selectedPerson, choose);
  expect(reranked.items[0].props.id).toBe(selectedPerson);
  expect(reranked.hasChoice).toBe(true);
  expect(reranked.selection.selectedItemId).toBe(selectedPerson);
});

it("restores a Down reported after a rerank and a rapid Up reported before the next render", () => {
  const choose = vi.fn();
  const first = "work:1/U1";
  const next = "other:2/U2";
  const favorite = "other:2/U3";
  const initial = picker([first, next], null, choose);
  const downId = initial.items[1].props.id!;
  const duringDown = picker([favorite, first, next], null, choose);
  duringDown.selection.onSelectionChange(downId);
  const afterDown = picker([favorite, first, next], choose.mock.lastCall![0], choose);
  expect(afterDown.selection.selectedItemId).toBe(afterDown.items[2].props.id);
  expect(afterDown.items[2].props.title).toBe(next);
  afterDown.selection.onSelectionChange(duringDown.selection.selectedItemId!);
  expect(choose).toHaveBeenCalledExactlyOnceWith(downId);

  const withRetry = picker([first, "other:2/retry-directory"], null, choose);
  withRetry.selection.onSelectionChange(withRetry.items[1].props.id!);
  withRetry.selection.onSelectionChange(withRetry.items[0].props.id!);
  const afterUp = picker([favorite, first], choose.mock.lastCall![0], choose);
  expect(afterUp.selection.selectedItemId).toBe(afterUp.items[1].props.id);
  expect(afterUp.items[1].props.title).toBe(first);
});

it("keeps an explicitly selected Retry reachable and resets focus for filtering or disappearing results", () => {
  const choose = vi.fn();
  const person = "work:1/U1";
  const retry = "other:2/retry-directory";
  const initial = picker([person, retry], null, choose);
  const retryId = initial.items[1].props.id!;
  initial.selection.onSelectionChange(retryId);
  expect(choose).toHaveBeenCalledExactlyOnceWith(retryId);
  const more = picker(["other:2/U1", person, retry], retryId, choose);
  expect(more.items[2].props.id).toBe(retryId);
  expect(more.hasChoice).toBe(true);
  for (const fresh of [
    picker([person, retry], retryId, choose, "new query"),
    picker([person, "other:2/refresh-activity"], retryId, choose),
  ]) {
    expect(fresh.hasChoice).toBe(false);
    expect(fresh.selection.selectedItemId).toBe(fresh.items[0].props.id);
    fresh.selection.onSelectionChange(retryId);
  }
  expect(choose).toHaveBeenCalledTimes(1);
  expect(picker([], retryId, choose).selection.selectedItemId).toBeUndefined();
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

it("names DMs beyond the people limit and keeps the same user ID separate in each workspace", async () => {
  for (const team of ["TDIRECT01", "TDIRECT02"]) {
    const workspace = await addWorkspace("xoxp-fixture-" + team);
    await inWorkspace(workspace, async () => {
      const [channels] = await SlackClient.searchConversations("", undefined, undefined, "channels");
      const users = await SlackClient.searchUsers("");
      expect(users).toHaveLength(100);
      expect(namedDirectoryRows(channels, new Map(), "D00000001", true)).toMatchObject([
        { id: "D00000001", name: "Loading direct message…" },
      ]);
      expect(namedDirectoryRows(channels, new Map(), "general", true).map((item) => item.name)).toEqual(["general"]);
      const { names, apps, inactive, favoriteUsers } = await SlackClient.getDirectMessageProfiles(undefined, () => {}, [
        "U00000101",
        "UDELETED1",
      ]);
      expect(inactive.has("UDELETED1")).toBe(true);
      expect(
        namedDirectoryRows([], names, "", false, [{ ...users[0], id: "UDELETED1" }], favoriteUsers, inactive).map(
          (r) => r.id,
        ),
      ).not.toContain("UDELETED1");
      expect(favoriteUsers.map((u) => u.id)).toEqual(["U00000101"]);
      expect(
        namedDirectoryRows(users, names, "Late", false, [], favoriteUsers).some((row) => row.id === "U00000101"),
      ).toBe(true);
      expect(namedDirectoryRows([], names, "@example.org", false, [], favoriteUsers).map((r) => r.id)).toEqual([
        "U00000101",
      ]);
      expect(namedDirectoryRows([], names, "Nobody", false, [], favoriteUsers)).toEqual([]);
      expect([...apps]).toEqual(["USLACKBOT", "UBOT00101"]);
      const rows = namedDirectoryRows([...users, ...channels], names, "", false);
      expect(rows.find((item) => item.id === "D00000001")?.name).toBe("Late Member " + team);
      expect(rows.find((item) => item.id === "D00000002")?.name).toBe("Support Bot");
      expect(rows.find((item) => item.id === "D00000003")?.name).toBe("Profile unavailable");
      expect(rows.find((item) => item.id === "D00000004")?.name).toBe("External Guest");
      const dm = channels.find((item) => item.id === "D00000001")!;
      expect(namedDirectoryRows([dm], new Map(), "", false, [{ ...dm, name: "Saved Name" }])[0].name).toBe(
        "Saved Name",
      );
      const saved = { ...users[0], id: "U00000101", name: "U00000101" };
      const savedPerson = { ...saved, name: "Saved Person" };
      expect(namedDirectoryRows([dm], new Map(), "Saved Person", false, [savedPerson])).toMatchObject([
        { id: dm.id, name: "Saved Person", rankingId: savedPerson.id },
      ]);
      expect(namedDirectoryRows([savedPerson, dm], names, "", false, [dm])).toMatchObject([
        { id: savedPerson.id, rankingId: dm.id, conversationId: dm.id },
      ]);
      expect(namedDirectoryRows([dm], names, "", false, [saved])).toMatchObject([
        { id: saved.id, name: "Late Member " + team, conversationId: dm.id },
      ]);
      expect(namedDirectoryRows(channels, names, "late", false).map((item) => item.id)).toEqual(["D00000001"]);
      const person = await SlackClient.searchUsers("Late Member");
      expect(namedDirectoryRows([...person, ...channels], names, "Late", false)).toMatchObject([
        { id: "U00000101", name: "Late Member " + team, conversationId: "D00000001" },
      ]);
      expect(calls.filter((call) => call.team === team && call.method === "users.list")).toHaveLength(2);
      const directory = await SlackClient.getUsersWithApps();
      expect(directory.imPeers.get("D00000002")).toBe("UBOT00101");
      expect(directory.apps.get("UBOT00101")).toBe("Support Bot");
      expect(directory.usersById.has("UBOT00101")).toBe(false);
      expect(directory.usersById.has(directory.imPeers.get("D00000001")!)).toBe(true);
    });
  }
});

it("shares a favorite between a person and their DM while isolating same IDs in other registrations", async () => {
  const w = await addWorkspace("xoxp-fixture-TFAVORITE");
  const other = { ...w, registration: "other" };
  const dm = { id: "D1", directUserId: "U1", name: "Ada", icon: "person", teamId: w.teamId };
  const channel = { ...dm, id: "C1", directUserId: undefined };
  const id = favoriteId(w, dm);
  expect(id).toEqual(favoriteId(w, { ...dm, id: "U1", directUserId: undefined }));
  await Promise.all([saveFavorite(id, true), saveFavorite(favoriteId(w, channel), true)]);
  expect((await readFavorites()).has(favoriteId(other, dm))).toBe(false);
  await saveFavorite(id, false);
  const remaining = await readFavorites();
  expect(remaining.has(id)).toBe(false);
  expect(remaining.has(favoriteId(w, channel))).toBe(true);
});

it("combines later search pages with newer channel history and verifies incoming thread reply authors", async () => {
  const w = await addWorkspace("xoxp-fixture-TORDERBASE");
  const progress = vi.fn();
  const result = await inWorkspace(w, () => loadConversationActivity(undefined, progress));
  expect(progress.mock.calls[1][0]).toEqual({ C1: 100, C2: 70 });
  expect(result).toEqual({ activity: { C1: 115, C2: 70, C3: 20 }, incomplete: false });
  expect(calls.filter((c) => c.team === w.teamId && c.method === "conversations.replies")).toHaveLength(2);
  failReplyRefresh = true;
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
  try {
    const limited = await inWorkspace(w, () => loadConversationActivity(undefined, () => {}));
    expect(limited.incomplete).toBe(true);
    expect(limited.activity.C1).toBe(115);
  } finally {
    clock.mockRestore();
    failReplyRefresh = false;
  }
});

it("bounds Slack history traffic, including reply calls, and continues on the next refresh", async () => {
  const w = await addWorkspace("xoxp-fixture-TORDERWIDE");
  const run = () => inWorkspace(w, () => loadConversationActivity(undefined, () => {}));
  const first = await run();
  expect(first.incomplete).toBe(true);
  const count = calls.filter(
    (c) => c.team === w.teamId && ["conversations.history", "conversations.replies"].includes(c.method),
  ).length;
  expect(count).toBe(12);
  const second = await run();
  expect(Object.keys(second.activity).length).toBeGreaterThan(Object.keys(first.activity).length);
});

it("stops a missing-scope history scan and makes zero calls for a cancelled scan", async () => {
  const w = await addWorkspace("xoxp-fixture-TORDERDENY");
  const before = calls.length;
  await expect(inWorkspace(w, () => loadConversationActivity(AbortSignal.abort(), () => {}))).rejects.toThrow();
  expect(calls).toHaveLength(before);
  const result = await inWorkspace(w, () => loadConversationActivity(undefined, () => {}));
  expect(result.incomplete).toBe(true);
  expect(calls.filter((c) => c.team === w.teamId && c.method === "conversations.history")).toHaveLength(1);
});

it("keeps unread DM favorite identity and skips channel events when ranking incoming unread messages", async () => {
  const w = await addWorkspace("xoxp-fixture-TUNREADEV");
  const {
    conversations: [dm],
  } = await inWorkspace(w, () => SlackClient.getUnreadConversations(["DORDEREVT"]));
  expect(dm.directUserId).toBe("UPEER");
  expect(dm.messageHistory.map((m) => m.incoming)).toEqual([false, true]);
});

it("cancels before network dispatch if a scan is aborted during SDK credential validation", async () => {
  const w = await addWorkspace("xoxp-fixture-TCANCEL99");
  const controller = new AbortController();
  const original = LocalStorage.getItem;
  await inWorkspace(w, async () => {
    const read = vi.spyOn(LocalStorage, "getItem").mockImplementationOnce((key) => {
      controller.abort();
      return original(key);
    });
    try {
      await expect(loadConversationActivity(controller.signal, () => {})).rejects.toThrow();
    } finally {
      read.mockRestore();
    }
  });
  expect(calls.filter((c) => c.team === w.teamId && c.method === "search.messages")).toHaveLength(0);
});

it("leaves the interactive client available when directory enrichment hits a rate limit", async () => {
  const w = await addWorkspace("xoxp-fixture-TQUEUE429");
  await inWorkspace(w, async () => {
    await expect(loadConversationActivity(undefined, () => {})).rejects.toThrow(/rate/i);
    expect((await getSlackWebClient().emoji.list()).ok).toBe(true);
  });
  expect(calls.filter((c) => c.team === w.teamId && c.method === "conversations.list")).toHaveLength(1);
});

it("notifies favorite profile readers when a stale member snapshot is replaced", async () => {
  const key = "T-favorite-refresh";
  const page = (deleted: boolean) => async () => ({ items: [{ id: "U1", name: "peer", deleted }] });
  await getMemberPage(key, page(false), 0);
  const before = memberDirectoryRevision(key);
  const notify = vi.fn();
  const unsubscribe = subscribeMemberDirectory(notify);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60 * 1000);
  try {
    await getMemberPage(key, page(true), 0);
    expect(memberDirectoryRevision(key)).toBeGreaterThan(before);
    expect(notify).toHaveBeenCalled();
    expect((await getMemberPage(key, page(true), 0)).items[0].deleted).toBe(true);
  } finally {
    clock.mockRestore();
    unsubscribe();
  }
});
