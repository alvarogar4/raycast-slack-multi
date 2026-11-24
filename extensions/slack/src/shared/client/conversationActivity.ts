import { Cache } from "@raycast/api";
import { getActivityClient, getWorkspace } from "./WebClient";
import { loadConversationDirectoryPage } from "./SlackClient";
import { incomingTimestamp } from "./conversationOrder";
import { isRateLimitError } from "./rateLimit";
import { workspaceKey } from "./workspaces";

export type Activity = Record<string, number>;
const cache = new Cache({ namespace: "received-message-dates" });
const freshness = 5 * 60 * 1000;
const searchPages = 3;
const historyRequests = 12;

type HistoryDate = { checked: number; ts: number; partial: boolean };

function storedDate(key: string): HistoryDate | undefined {
  const saved = cache.get(key);
  return saved ? JSON.parse(saved) : undefined;
}

export async function loadConversationActivity(signal: AbortSignal | undefined, onPage: (activity: Activity) => void) {
  signal?.throwIfAborted();
  const w = getWorkspace();
  const client = getActivityClient(signal);
  const activity: Activity = {};
  let incomplete = false;
  let limited = false;
  // Search includes replies to older parents that do not appear on a channel's recent history page.
  try {
    for (let page = 1; page <= searchPages; page++) {
      signal?.throwIfAborted();
      const { messages } = await client.search.messages({
        query: "after:1970-01-01 -from:me",
        sort: "timestamp",
        sort_dir: "desc",
        count: 100,
        page,
      });
      signal?.throwIfAborted();
      for (const m of messages?.matches ?? []) {
        const id = m.channel?.id;
        const ts = incomingTimestamp(m, w.userId);
        if (id && ts) activity[id] = Math.max(activity[id] ?? 0, ts);
      }
      onPage({ ...activity });
      if (page >= (messages?.paging?.pages ?? messages?.pagination?.page_count ?? 1)) break;
      if (page === searchPages) incomplete = true;
    }
  } catch (error) {
    signal?.throwIfAborted();
    incomplete = true;
    limited = isRateLimitError(error);
  }

  const searchIncomplete = incomplete;
  // The directory cache finishes its shared scan for other readers even if this ranking pass is cancelled.
  const directoryClient = getActivityClient();
  const candidates: { id: string; key: string; type: string; saved?: HistoryDate }[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await loadConversationDirectoryPage(cursor, undefined, directoryClient);
    signal?.throwIfAborted();
    for (const c of page.items) {
      if (!c.id || (!c.is_im && !c.is_mpim && c.is_member === false)) continue;
      const key = workspaceKey(w) + "/" + c.id;
      const saved = storedDate(key);
      // Keep the search candidate separate so a verified refresh can replace a deleted cached message.
      candidates.push({
        id: c.id,
        key,
        type: c.is_im ? "im" : c.is_mpim ? "mpim" : c.is_private ? "groups" : "channels",
        saved,
      });
    }
    if (page.error) throw page.error;
    cursor = page.nextCursor;
  } while (cursor);
  const search = { ...activity };
  for (const { id, saved } of candidates) if (saved?.ts) activity[id] = Math.max(activity[id] ?? 0, saved.ts);
  onPage({ ...activity });
  // Unchecked conversations advance on subsequent launches. Compare the busiest ones first on a cold cache.
  candidates.sort(
    (a, b) => (a.saved?.checked ?? 0) - (b.saved?.checked ?? 0) || (activity[b.id] ?? 0) - (activity[a.id] ?? 0),
  );
  let remaining = historyRequests;
  const missingScopes = new Set<string>();
  for (const { id, key, type, saved } of candidates) {
    signal?.throwIfAborted();
    if (saved && Date.now() - saved.checked < freshness) {
      if (saved.partial) incomplete = true;
      continue;
    }
    if (!remaining || limited) {
      incomplete = true;
      break;
    }
    if (missingScopes.has(type)) continue;
    try {
      remaining--;
      const history = await client.conversations.history({ channel: id, limit: 100 });
      signal?.throwIfAborted();
      const messages = history.messages ?? [];
      let ts = Math.max(search[id] ?? 0, ...messages.map((m) => incomingTimestamp(m, w.userId)));
      let partial = !!history.has_more && !messages.some((m) => incomingTimestamp(m, w.userId));
      activity[id] = Math.max(activity[id] ?? 0, ts);
      const threads = messages
        .filter((m) => m.ts && Number(m.latest_reply) > ts)
        .sort((a, b) => Number(b.latest_reply) - Number(a.latest_reply));
      for (const thread of threads) {
        if (Number(thread.latest_reply) <= ts) break;
        let cursor: string | undefined;
        const oldest = String(ts);
        do {
          if (!remaining) {
            partial = true;
            break;
          }
          remaining--;
          const replies = await client.conversations.replies({
            channel: id,
            ts: thread.ts!,
            oldest,
            cursor,
            limit: 100,
          });
          signal?.throwIfAborted();
          for (const m of replies.messages ?? []) ts = Math.max(ts, incomingTimestamp(m, w.userId));
          activity[id] = Math.max(activity[id] ?? 0, ts);
          const next = replies.response_metadata?.next_cursor;
          if (!next || cursor === next) {
            if (replies.has_more) partial = true;
            break;
          }
          cursor = next;
        } while (cursor);
      }
      if (partial || searchIncomplete || history.has_more) ts = Math.max(ts, saved?.ts ?? 0);
      activity[id] = ts;
      cache.set(key, JSON.stringify({ checked: Date.now(), ts, partial }));
      if (partial) incomplete = true;
      onPage({ ...activity });
    } catch (error) {
      signal?.throwIfAborted();
      const code = (error as { data?: { error?: string } })?.data?.error;
      incomplete = true;
      // Failed conversations must also yield their turn to unchecked ones on the next refresh.
      activity[id] = Math.max(activity[id] ?? 0, saved?.ts ?? 0);
      cache.set(key, JSON.stringify({ checked: Date.now(), ts: activity[id], partial: true }));
      if (code === "missing_scope") missingScopes.add(type);
      if (isRateLimitError(error) || code === "invalid_auth" || code === "token_revoked" || code === "account_inactive")
        break;
    }
  }
  return { activity, incomplete };
}
