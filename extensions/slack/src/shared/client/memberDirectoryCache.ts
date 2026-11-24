import { Cache } from "@raycast/api";
import type { SlackMember } from "./slackTypes";
import { memberDisplayName } from "./member";
import { planMemberDirectoryRead } from "./memberDirectoryRefresh";

/** `pages` keeps the layout of the scan that produced the snapshot (in memory only), so a search that began on the live scan can finish reading it by page index after the scan completes. */
type Snapshot = { savedAt: number; members: SlackMember[]; pages?: SlackMember[][] };

const cache = new Cache({ capacity: 20 * 1024 * 1024 });
const memory = new Map<string, Snapshot>();
const listeners = new Set<() => void>();
export function subscribeMemberDirectory(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function memberDirectoryRevision(accountKey: string) {
  return memory.get("member-directory-v3:" + accountKey)?.savedAt ?? 0;
}

/** Keeps the profile fields used by the directory, including names of existing DM partners. */
export function slimMember(member: SlackMember): SlackMember | undefined {
  if (!member.id || !memberDisplayName(member)) return undefined;
  const { profile } = member;
  return {
    id: member.id,
    is_bot: member.is_bot,
    deleted: member.deleted,
    is_workflow_bot: member.is_workflow_bot,
    team_id: member.team_id,
    name: member.name,
    real_name: member.real_name,
    tz: member.tz,
    profile: profile && {
      real_name: profile.real_name,
      bot_id: profile.bot_id,
      api_app_id: profile.api_app_id,
      display_name: profile.display_name,
      email: profile.email,
      first_name: profile.first_name,
      last_name: profile.last_name,
      image_24: profile.image_24,
      title: profile.title,
      status_text: profile.status_text,
      status_emoji: profile.status_emoji,
      status_expiration: profile.status_expiration,
    },
  };
}

function read(key: string): Snapshot | undefined {
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const raw = cache.get(key);
    if (!raw) return undefined;
    const snapshot = JSON.parse(raw) as Snapshot;
    memory.set(key, snapshot);
    return snapshot;
  } catch {
    return undefined;
  }
}

function write(key: string, pages: SlackMember[][]) {
  const snapshot = { savedAt: Date.now(), members: pages.flat() };
  memory.set(key, { ...snapshot, pages });
  listeners.forEach((notify) => notify());
  try {
    cache.set(key, JSON.stringify(snapshot));
  } catch {
    // Persistence is best-effort; the in-memory copy still serves this session.
  }
}

type FetchPage = (cursor?: string) => Promise<{ items: SlackMember[]; nextCursor?: string }>;

/** One scan of users.list. Pages become readable as they arrive. A failed scan stays here until its backoff elapses. */
type Load = {
  pages: SlackMember[][];
  finished: boolean;
  error?: unknown;
  failedAt?: number;
  listeners: Set<() => void>;
};

const loads = new Map<string, Load>();

function startLoad(key: string, fetchPage: FetchPage): Load {
  const load: Load = { pages: [], finished: false, listeners: new Set() };
  const notify = () => {
    const listeners = [...load.listeners];
    load.listeners.clear();
    listeners.forEach((listener) => listener());
  };
  loads.set(key, load);
  void (async () => {
    try {
      let cursor: string | undefined;
      do {
        const page = await fetchPage(cursor);
        load.pages.push(page.items.flatMap((member) => slimMember(member) ?? []));
        notify();
        cursor = page.nextCursor || undefined;
      } while (cursor);
      write(key, load.pages);
    } catch (error) {
      load.error = error;
      load.failedAt = Date.now();
    } finally {
      load.finished = true;
      // A failure stays registered so the next search can reuse it instead of starting another full scan.
      if (!load.error) loads.delete(key);
      notify();
    }
  })();
  return load;
}

async function readLoadPage(load: Load, index: number): Promise<MemberPage> {
  for (;;) {
    const items = load.pages[index];
    if (items) {
      const hasMore = index + 1 < load.pages.length || !load.finished;
      // Fetched pages stay readable. A finished scan that stopped short reports that on its last page.
      return { items, hasMore, error: !hasMore && load.error ? load.error : undefined };
    }
    if (load.finished) {
      if (load.error) throw load.error;
      return { items: [], hasMore: false };
    }
    await new Promise<void>((resolve) => load.listeners.add(resolve));
  }
}

export function clearFailedMemberLoad(accountKey: string) {
  const key = "member-directory-v3:" + accountKey;
  if (loads.get(key)?.failedAt !== undefined) loads.delete(key);
}

export type MemberPage = { items: SlackMember[]; hasMore: boolean; error?: unknown };

/**
 * Returns page `index` of the workspace member list. users.list is scanned at most once per hour and the scan is
 * shared by every search, so a search can read matches as pages arrive instead of waiting for the whole workspace.
 * A stale snapshot is served immediately while a refresh runs in the background. If that refresh fails, the stale
 * snapshot keeps working and another scan waits out a short backoff instead of restarting on every search.
 * Only a complete scan is cached.
 */
export async function getMemberPage(accountKey: string, fetchPage: FetchPage, index: number): Promise<MemberPage> {
  const key = "member-directory-v3:" + accountKey;
  const snapshot = read(key);
  const now = Date.now();
  const age = snapshot ? now - snapshot.savedAt : Infinity;
  const plan = planMemberDirectoryRead({
    hasSnapshot: snapshot !== undefined,
    snapshotAgeMs: age,
    load: loads.get(key),
    now,
  });

  if (plan.discardFailedLoad) loads.delete(key);
  if (plan.serve === "fresh" && snapshot) {
    const pages = snapshot.pages ?? [snapshot.members];
    return { items: pages[index] ?? [], hasMore: index + 1 < pages.length };
  }

  if (plan.startLoad && !loads.has(key)) startLoad(key, fetchPage);
  // A stale snapshot is served as one page: the refresh replaces it, and a page layout must not change mid-search.
  if (plan.serve === "stale" && snapshot) return { items: index === 0 ? snapshot.members : [], hasMore: false };

  const load = loads.get(key);
  if (!load) throw new Error("Member directory is unavailable");
  return readLoadPage(load, index);
}
