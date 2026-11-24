import { showToast, Toast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { connectWorkspace } from "./shared/client/WebClient";

export default async function connect() {
  try {
    const workspace = await connectWorkspace();
    await showToast(Toast.Style.Success, "Connected to " + workspace.teamName);
  } catch (error) {
    await showFailureToast(error, { title: "Could not connect workspace" });
  }
}
