import { confirmationWorkspace } from "../shared/client/workspaces";
import { accounts } from "../shared/client/WebClient";
import { Tool } from "@raycast/api";
import { getCanvasWebClient } from "../shared/client/WebClient";
import { editCanvas, validateCanvasEdit, parseCanvasSectionTypes } from "../shared/client/canvas";
import { withSlackClient } from "../shared/withSlackClient";

type Input = {
  /** Current workspace identifier (team ID and registration). Use the identifier returned by a workspace lookup, or retry using the identifier supplied when choosing a team ID. */
  workspace?: string;
  /** Existing canvas URL or F-prefixed ID. Read Canvas first. */
  canvas: string;
  /** One targeted Slack operation. Replace/delete operate on an entire section; whole-canvas replacement is prohibited. Do not rebuild a table or rich section to change a cell or preserve its formatting. */
  operation: "insert_before" | "insert_after" | "insert_at_start" | "insert_at_end" | "replace" | "delete" | "rename";
  /** Copy the snapshot from the most recent Read Canvas result. Re-read after every edit. */
  expectedSnapshot: string;
  /** Section ID from Read Canvas. Required for insert_before, insert_after, replace and delete. Never guess it. */
  sectionId?: string;
  /** Copy the specific text criterion used by Read Canvas to find the target. Exactly one matching section is required. */
  containsText?: string;
  /** Copy up to three section type filters used for the target lookup, separated by commas or newlines, if any. */
  sectionTypes?: string;
  /** Slack Canvas Markdown for new/replacement content, or the new title for rename. Omit for delete. Replacement recreates the whole target section; retain its Markdown formatting and never replace unrelated content. HTML and Block Kit are unsupported. */
  markdown?: string;
};

export const confirmation: Tool.Confirmation<Input> = async (input) => {
  const workspace = confirmationWorkspace(await accounts.list(), input.workspace);
  const { canvasId } = validateCanvasEdit({ ...input, sectionTypes: parseCanvasSectionTypes(input.sectionTypes) });
  return {
    message:
      input.operation === "delete"
        ? "Delete the entire matching section from the Slack canvas?"
        : input.operation === "replace"
          ? "Replace the entire matching section? Replacement Markdown may change its formatting."
          : "Apply this change to the Slack canvas?",
    info: [
      { name: "Workspace", value: workspace.teamName + " (" + workspace.teamId + ")" },
      { name: "Canvas", value: canvasId },
      { name: "Operation", value: input.operation },
      ...(input.sectionId ? [{ name: "Section", value: input.sectionId }] : []),
      ...(input.containsText !== undefined ? [{ name: "Target Text", value: input.containsText }] : []),
      ...(input.sectionTypes !== undefined ? [{ name: "Section Types", value: input.sectionTypes }] : []),
      ...(input.markdown !== undefined ? [{ name: "Markdown", value: input.markdown }] : []),
    ],
  };
};

async function tool(input: Input): Promise<{
  canvasId: string;
  operation: string;
  sectionId?: string;
  applied: boolean;
  markdown?: string;
  html?: string;
  snapshot?: string;
  verificationError?: string;
}> {
  return editCanvas(getCanvasWebClient(), { ...input, sectionTypes: parseCanvasSectionTypes(input.sectionTypes) });
}

export default async function run(input: Input) {
  return withSlackClient(input, tool, "confirmed");
}
