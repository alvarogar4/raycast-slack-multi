import { LocalStorage } from "@raycast/api";
import type { User, Channel, Group } from "./SlackClient";
import { workspaceKey, type Workspace } from "./workspaces";

export type DirectoryItem = User | Channel | Group;
const prefix = "favorite-conversation:";

export function favoriteId(workspace: Workspace, item: DirectoryItem) {
  const peer = "directUserId" in item && item.directUserId;
  return workspaceKey(workspace) + "/" + (peer || item.id);
}

export async function readFavorites() {
  return new Set(
    Object.keys(await LocalStorage.allItems())
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  );
}

export async function saveFavorite(id: string, selected: boolean) {
  if (selected) await LocalStorage.setItem(prefix + id, true);
  else await LocalStorage.removeItem(prefix + id);
}
