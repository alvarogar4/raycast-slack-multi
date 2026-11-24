import assert from "node:assert/strict";
import test from "node:test";
import {
  collectWorkspaceResults,
  resolveWorkspace,
  selectedWorkspaces,
  workspaceKey,
  workspaceStore,
} from "./workspaces";
import { directoryConversation, toChannel } from "./conversation";
import { searchConversationDirectory } from "./conversationSearch";

function fixture() {
  const values = new Map<string, string>();
  const accounts = workspaceStore(
    {
      async allItems() {
        return Object.fromEntries(values);
      },
      async getItem(k) {
        return values.get(k);
      },
      async setItem(k, v) {
        values.set(k, v);
      },
      async removeItem(k) {
        values.delete(k);
      },
    },
    async (fn) => fn(),
  );
  const add = (id: string, user = "U1") =>
    accounts.add("xoxp-test-fixture", async () => ({ ok: true, team: id, team_id: id, user_id: user }));
  return { values, accounts, add };
}

test("add validates before writing and keeps tokens out of command metadata", async () => {
  const { accounts, values, add } = fixture();
  await assert.rejects(
    accounts.add("invalid", async () => {
      assert.fail("invalid prefix reached Slack");
    }),
    /user token/,
  );
  await assert.rejects(
    accounts.add("xoxp-fixture", async () => {
      throw new Error("sensitive response");
    }),
    /^Error: Slack could not validate/,
  );
  assert.equal(values.size, 0);
  const w = await add("T1");
  assert.deepEqual(await accounts.list(), [w]);
  assert.equal("token" in w, false);
  assert.equal((await accounts.credential(w)).token, "xoxp-test-fixture");
  await assert.rejects(add("T1", "U2"), /already connected/);
});

test("stale actions cannot read, remove or rename a replacement registration", async () => {
  const { accounts, add } = fixture();
  const first = await add("T1"),
    second = await add("T2");
  await accounts.rename(first, "Engineering");
  await accounts.remove(first);
  const replacement = await add("T1", "U2");
  await assert.rejects(accounts.credential(first), /Workspace changed/);
  await assert.rejects(accounts.rename(first, "Old"), /Workspace changed/);
  await assert.rejects(accounts.remove(first), /Workspace changed/);
  assert.deepEqual(await accounts.list(), [replacement, second]);
  assert.notEqual(workspaceKey(first), workspaceKey(second));
  assert.notEqual(workspaceKey(first), workspaceKey(replacement));
});

test("workspace resolution requires explicit send intent even with one account; duplicate labels are ambiguous", async () => {
  const { add } = fixture();
  const a = await add("T1"),
    b = { ...(await add("T2")), teamName: "T1 alias" };
  assert.throws(() => resolveWorkspace([a], undefined, true), /Choose a workspace/);
  assert.equal(resolveWorkspace([a]), a);
  assert.throws(() => resolveWorkspace([a, b]), /T1.*T2/);
  assert.equal(resolveWorkspace([a, b], "T2", true), b);
  assert.equal(resolveWorkspace([a, b], "t1 alias", true), b);
  assert.throws(
    () =>
      resolveWorkspace(
        [
          { ...a, teamName: "Same" },
          { ...b, teamName: "Same" },
        ],
        "same",
      ),
    /Choose a workspace/,
  );
  assert.deepEqual(selectedWorkspaces([a, b], "T2"), [b]);
});

test("all workspaces preserve identical result IDs, source order and successful reads on partial failure", async () => {
  const { add } = fixture();
  const [a, b, c] = await Promise.all(["T1", "T2", "T3"].map((id) => add(id)));
  const all = selectedWorkspaces([a, b, c], "all");
  const merged = await collectWorkspaceResults(all, async (w) => {
    if (w.teamId === "T2") throw Error("unavailable");
    return ["Cshared"];
  });
  assert.deepEqual(merged, {
    rows: [
      { workspace: a, item: "Cshared" },
      { workspace: c, item: "Cshared" },
    ],
    failures: [b],
  });
});

test("an unfiltered directory walks through an empty page, labels unjoined channels and retains direct and shared conversations", async () => {
  const team = "Tlocal";
  const [channels] = await searchConversationDirectory({
    query: "",
    maxResultsPerType: Infinity,
    scanAllPages: true,
    loadConversationsPage: async (cursor) =>
      cursor
        ? {
            items: [
              { id: "C1", name: "public", is_member: false },
              { id: "D1", is_im: true, user: "U1" },
              { id: "C2", name: "connect", context_team_id: "Tlocal", shared_team_ids: ["Tremote"] },
            ].map((c) => directoryConversation(c, team)),
          }
        : { items: [], nextCursor: "second" },
  });
  assert.deepEqual(
    channels.map((c) => c.id),
    ["C1", "D1", "C2"],
  );
  assert.equal(channels[0].notJoined, true);
  assert.equal(channels[1].directUserId, "U1");
  assert.equal(channels[2].teamId, team);
  assert.equal(toChannel(directoryConversation({ id: "C3", name: "public" }, team))?.teamId, team);
});

test("a damaged account can be removed while healthy registrations remain usable", async () => {
  const { values, accounts, add } = fixture();
  const w = await add("T1");
  values.set("workspace:Tbad", "{");
  assert.deepEqual(await accounts.inspect(), { valid: [w], invalid: ["Tbad"] });
  await accounts.removeInvalid("Tbad");
  await assert.rejects(accounts.removeInvalid(w.teamId), /Workspace changed/);
  assert.deepEqual(await accounts.list(), [w]);
});

test("a later directory failure leaves previously delivered page results available", async () => {
  const seen: string[][] = [];
  await assert.rejects(
    searchConversationDirectory({
      query: "",
      scanAllPages: true,
      maxResultsPerType: Infinity,
      loadConversationsPage: async (cursor) => {
        if (cursor) throw new Error("temporarily unavailable");
        return { items: [directoryConversation({ id: "C1", name: "first" }, "T1")], nextCursor: "second" };
      },
      onPage: (channels) => seen.push(channels.map((c) => c.id)),
    }),
    /temporarily unavailable/,
  );
  assert.deepEqual(seen, [["C1"]]);
});
