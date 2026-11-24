import { WorkspaceList } from "./shared/WorkspaceViews";
import { DirectoryRows } from "./search";
export default function SendMessageCommand() {
  return (
    <WorkspaceList placeholder="Choose a recipient">
      {(workspace, searchText) => <DirectoryRows workspace={workspace} searchText={searchText} compose />}
    </WorkspaceList>
  );
}
