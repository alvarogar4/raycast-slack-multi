import { Action, closeMainWindow, environment, Icon, showHUD } from "@raycast/api";
import { runAppleScript, runPowerShellScript } from "@raycast/utils";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceTarget } from "./shared/WorkspaceViews";
import { openSlackLink } from "./shared/OpenInSlack";
import type { Workspace } from "./shared/client/workspaces";

// Navigate inside the selected team's Slack document without sending input to other applications.
async function openNativeUnreads(teamId: string) {
  if (process.platform === "win32") {
    if (!/^T[A-Z0-9]+$/.test(teamId)) throw new Error("Invalid Slack workspace ID");
    return runPowerShellScript(String.raw`
      Add-Type -AssemblyName UIAutomationClient
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $deadline = [DateTime]::UtcNow.AddSeconds(6)
      do {
        $node = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($node -and (Get-Process -Id $node.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq "slack") {
          $document = $node
          while ($document -and $document.Current.ControlType -ne [System.Windows.Automation.ControlType]::Document) {
            $document = $walker.GetParent($document)
          }
          if ($document) {
            $url = $document.GetCurrentPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty)
            if ($url -match '^https://app\.slack\.com/client/${teamId}([/?#]|$)') {
              if ($url -match '^https://app\.slack\.com/client/${teamId}/unreads([/?#]|$)') { return "opened" }
              $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, "All Unreads")
              $window = $document
              while ($window -and $window.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
                $window = $walker.GetParent($window)
              }
              if ($window) {
                foreach ($item in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)) {
                  if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem) {
                    $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                    return "opened"
                  }
                }
              }
              return "manual"
            }
          }
        }
        Start-Sleep -Milliseconds 150
      } while ([DateTime]::UtcNow -lt $deadline)
      return "manual"
    `);
  }
  const script = await readFile(join(environment.assetsPath, "open-unreads.jxa"), "utf8");
  return runAppleScript(script, [teamId], { language: "JavaScript" });
}

async function openWorkspaceUnreads({ teamId, teamName }: Workspace) {
  try {
    const team = encodeURIComponent(teamId);
    await closeMainWindow();
    const native = await openSlackLink(
      `slack://open?team=${team}`,
      async () => `https://app.slack.com/client/${team}/unreads`,
    );
    if (!native) return;
    const result = await openNativeUnreads(teamId).catch(() => "manual");
    if (result.trim() !== "opened") {
      const shortcut = process.platform === "win32" ? "Ctrl+Shift+A" : "⌘⇧A";
      await showHUD(`In ${teamName}, press ${shortcut} for Unreads`);
    }
  } catch {
    await showHUD("Could not open Unreads in " + teamName);
  }
}

export default function OpenUnreadMessages() {
  return (
    <WorkspaceTarget
      action={(workspace) => (
        <Action title="Open Unread Messages" icon={Icon.Message} onAction={() => openWorkspaceUnreads(workspace)} />
      )}
    />
  );
}
