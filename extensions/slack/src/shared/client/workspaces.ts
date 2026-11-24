import { randomUUID } from "node:crypto";

export interface Workspace {
  teamId: string;
  teamName: string;
  userId: string;
  registration: string;
}

interface StoredWorkspace extends Workspace {
  token: string;
}

interface Storage {
  allItems(): Promise<Record<string, unknown>>;
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

type AuthResult = { team_id?: string; team?: string; user_id?: string; bot_id?: string; ok?: boolean };
const prefix = "workspace:";
export const workspaceKey = (w: Workspace) => `${w.teamId}:${w.registration}`;

function decode(value: unknown): StoredWorkspace | undefined {
  if (typeof value !== "string") return;
  let w: unknown;
  try {
    w = JSON.parse(value);
  } catch {
    return;
  }
  if (
    typeof w === "object" &&
    w !== null &&
    "teamId" in w &&
    typeof w.teamId === "string" &&
    "teamName" in w &&
    typeof w.teamName === "string" &&
    "userId" in w &&
    typeof w.userId === "string" &&
    "token" in w &&
    typeof w.token === "string" &&
    "registration" in w &&
    typeof w.registration === "string"
  )
    return { teamId: w.teamId, teamName: w.teamName, userId: w.userId, token: w.token, registration: w.registration };
  return undefined;
}

function metadata({ teamId, teamName, userId, registration }: Workspace): Workspace {
  return { teamId, teamName, userId, registration };
}

export function workspaceStore(storage: Storage, exclusive: <T>(operation: () => Promise<T>) => Promise<T>) {
  async function credential(w: Workspace) {
    const saved = decode(await storage.getItem(prefix + w.teamId));
    if (!saved || saved.teamId !== w.teamId || saved.registration !== w.registration)
      throw new Error("Workspace changed. Reopen this command.");
    return saved;
  }
  async function inspect() {
    const valid: Workspace[] = [],
      invalid: string[] = [];
    for (const [key, value] of Object.entries(await storage.allItems())) {
      if (!key.startsWith(prefix)) continue;
      const teamId = key.slice(prefix.length);
      const w = decode(value);
      if (w && w.teamId === teamId) valid.push(metadata(w));
      else invalid.push(teamId);
    }
    return { valid: valid.sort((a, b) => a.teamName.localeCompare(b.teamName)), invalid };
  }
  return {
    credential,
    inspect,
    async list() {
      return (await inspect()).valid;
    },
    removeInvalid(teamId: string) {
      return exclusive(async () => {
        const w = decode(await storage.getItem(prefix + teamId));
        if (w && w.teamId === teamId) throw new Error("Workspace changed. Reopen this command.");
        await storage.removeItem(prefix + teamId);
      });
    },
    async add(input: string, authenticate: (token: string) => Promise<AuthResult>) {
      const token = input.trim();
      if (!token.startsWith("xoxp-")) throw new Error("Enter a Slack user token starting with xoxp-.");
      const auth = await authenticate(token).catch(() => {
        throw new Error("Slack could not validate this token. Check the token and your connection.");
      });
      if (!auth.ok || !auth.team_id || !auth.user_id || auth.bot_id)
        throw new Error("A workspace-specific user token is required.");
      const w: StoredWorkspace = {
        teamId: auth.team_id,
        teamName: auth.team || auth.team_id,
        userId: auth.user_id,
        token,
        registration: randomUUID(),
      };
      await exclusive(async () => {
        if (await storage.getItem(prefix + w.teamId))
          throw new Error("This workspace is already connected. Remove it first to change the token.");
        await storage.setItem(prefix + w.teamId, JSON.stringify(w));
      });
      return metadata(w);
    },
    rename(w: Workspace, name: string) {
      return exclusive(async () => {
        const saved = await credential(w);
        if (!name.trim()) throw new Error("Enter a workspace name.");
        await storage.setItem(prefix + w.teamId, JSON.stringify({ ...saved, teamName: name.trim() }));
      });
    },
    remove(w: Workspace) {
      return exclusive(async () => {
        await credential(w);
        await storage.removeItem(prefix + w.teamId);
      });
    },
  };
}

export function resolveWorkspace(workspaces: Workspace[], selector?: string, explicit = false) {
  const id = selector?.trim();
  const match = id ? workspaces.find((w) => w.teamId === id || workspaceKey(w) === id) : undefined;
  if (match) return match;
  const choices = id ? workspaces.filter((w) => w.teamName.toLowerCase() === id.toLowerCase()) : workspaces;
  if (choices.length === 1 && (id || !explicit)) return choices[0];
  if (!workspaces.length) throw new Error("Connect a workspace in Manage Workspaces.");
  throw new Error("Choose a workspace by team ID: " + workspaces.map((w) => `${w.teamName} (${w.teamId})`).join(", "));
}

/** Raycast passes the original input to execution after confirmation, including across processes. */
export function confirmationWorkspace(workspaces: Workspace[], selector?: string) {
  const w = resolveWorkspace(workspaces, selector, true);
  if (selector !== workspaceKey(w))
    throw new Error("Repeat the confirmation with the current workspace identifier: " + workspaceKey(w));
  return w;
}

export function selectedWorkspaces(workspaces: Workspace[], selection: string) {
  return selection === "all" ? workspaces : workspaces.filter((w) => w.teamId === selection);
}

/** Keep each result paired with its originating registration, even for shared Slack IDs. */
export async function collectWorkspaceResults<T>(targets: Workspace[], load: (w: Workspace) => Promise<T[]>) {
  const responses = await Promise.allSettled(targets.map(load));
  return {
    rows: responses.flatMap((r, i) =>
      r.status === "fulfilled" ? r.value.map((item) => ({ workspace: targets[i], item })) : [],
    ),
    failures: targets.filter((_, i) => responses[i].status === "rejected"),
  };
}
