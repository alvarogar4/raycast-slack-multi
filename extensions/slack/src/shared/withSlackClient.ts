import { showToast, Toast } from "@raycast/api";
import { accounts, inWorkspace } from "./client/WebClient";
import { collectWorkspaceResults, resolveWorkspace, confirmationWorkspace } from "./client/workspaces";

export async function withSlackClient<I extends { workspace?: string }, R>(
  input: I,
  tool: (input: I) => Promise<R>,
  explicit: boolean | "confirmed" = false,
) {
  const all = await accounts.list();
  const workspace =
    explicit === "confirmed"
      ? confirmationWorkspace(all, input.workspace)
      : resolveWorkspace(all, input?.workspace, explicit);
  return inWorkspace(workspace, () => tool(input));
}

export async function workspaceMentions<I extends { workspace?: string }, R extends { uri: string; title: string }>(
  input: I,
  search: (input: I) => Promise<R[]>,
) {
  const all = await accounts.list();
  const targets = input.workspace || !all.length ? [resolveWorkspace(all, input.workspace)] : all;
  const { rows, failures } = await collectWorkspaceResults(targets, async (w) => {
    const result = inWorkspace(w, () => search(input));
    if (targets.length === 1) return result;
    // A workspace waiting for Retry-After can finish warming its directory after the mention picker returns.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Workspace search timed out")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
  if (failures.length) {
    const message = "Could not search " + failures.map((w) => w.teamName).join(", ");
    if (failures.length === targets.length) throw new Error(message);
    await showToast(Toast.Style.Failure, message);
  }
  return rows.map(({ workspace: w, item }) => ({
    ...item,
    title: item.title + " · " + w.teamName,
    uri: item.uri + "?workspace=" + w.teamId + "&registration=" + w.registration,
  }));
}
