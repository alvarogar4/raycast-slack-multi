import test from "node:test";
import assert from "node:assert/strict";
import { compareConversations, incomingTimestamp } from "./conversationOrder";
import { isAppMember } from "./member";

test("interleaves workspaces by received message, breaks ties and leaves undated contacts last", () => {
  const rows = [
    { id: "a:D1", name: "Zed", latest: 30 },
    { id: "a:C1", name: "Ann", latest: 10 },
    { id: "b:D1", name: "Kim", latest: 20 },
    { id: "b:C2", name: "Ann", latest: 10 },
    { id: "b:U1", name: "Abe", latest: 0 },
  ];
  assert.deepEqual(
    [...rows].sort(compareConversations("latest")).map((r) => r.id),
    ["a:D1", "b:D1", "a:C1", "b:C2", "b:U1"],
  );
  assert.deepEqual(
    [...rows].sort(compareConversations("name")).map((r) => r.name),
    ["Abe", "Ann", "Ann", "Kim", "Zed"],
  );
});

test("incoming chronology ignores my posts and channel events and includes bot posts in normal channels", () => {
  assert.equal(incomingTimestamp({ user: "U2", ts: "22.001" }, "U1"), 22.001);
  assert.equal(incomingTimestamp({ user: "U1", ts: "25" }, "U1"), 0);
  assert.equal(incomingTimestamp({ user: "U2", ts: "26", subtype: "channel_join" }, "U1"), 0);
  assert.equal(incomingTimestamp({ bot_id: "B1", ts: "27", subtype: "bot_message" }, "U1"), 27);
});

test("identifies app peers by Slack identity even when a human shares their display name", () => {
  assert.ok(isAppMember({ id: "USLACKBOT" }));
  assert.equal(isAppMember({ id: "U1", is_app_user: true }), false);
  assert.ok(isAppMember({ id: "U2", profile: { bot_id: "B1" } }));
  assert.equal(isAppMember({ id: "U3", name: "Notion" }), false);
});

test("favorites in both workspaces stay above other rows and follow the selected sort", () => {
  const rows = [
    { id: "a:C", name: "Bee", latest: 10, favorite: true },
    { id: "b:C", name: "Abe", latest: 5, favorite: true },
    { id: "c:C", name: "Ace", latest: 20 },
  ];
  assert.deepEqual(
    [...rows].sort(compareConversations("latest")).map((r) => r.id),
    ["a:C", "b:C", "c:C"],
  );
  assert.deepEqual(
    [...rows].sort(compareConversations("name")).map((r) => r.id),
    ["b:C", "a:C", "c:C"],
  );
});
