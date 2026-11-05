import { RunsHistory } from "./RunsHistory";
import { WorkflowList } from "./WorkflowList";
import { WorkflowDetail } from "./WorkflowDetail";

export { RunDetail } from "./RunDetail";
export {
  pendingForRun,
  runState,
  runDuration,
  eventFolder,
  matchesEventFolder,
  workflowTrigger,
  workflowDeleteTarget,
} from "./workflowPresentation";
export function Workflows(props: { name?: string; runsOnly?: boolean; agentsOnly?: boolean }) {
  return props.runsOnly ? (
    <RunsHistory name={props.name} />
  ) : props.name ? (
    <WorkflowDetail name={props.name} />
  ) : (
    <WorkflowList agentsOnly={props.agentsOnly} />
  );
}

export { WorkflowContext } from "./WorkflowDetail";

export { WorkflowForm, workflowContent } from "./WorkflowForm";
