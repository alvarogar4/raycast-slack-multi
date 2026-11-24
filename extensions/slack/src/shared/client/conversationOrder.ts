export type ConversationSort = "latest" | "name";

export interface ConversationRank {
  id: string;
  name: string;
  latest: number;
  favorite?: boolean;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function compareConversations(sort: ConversationSort) {
  return (a: ConversationRank, b: ConversationRank) =>
    Number(!!b.favorite) - Number(!!a.favorite) ||
    (sort === "latest" ? b.latest - a.latest : 0) ||
    collator.compare(a.name, b.name) ||
    a.id.localeCompare(b.id);
}

export function incomingTimestamp(
  message: { ts?: string; user?: string; bot_id?: string; subtype?: string },
  me: string,
) {
  if (message.user === me || (!message.user && !message.bot_id)) return 0;
  if (message.subtype && !["bot_message", "file_share", "me_message", "thread_broadcast"].includes(message.subtype))
    return 0;
  const ts = Number(message.ts);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}
