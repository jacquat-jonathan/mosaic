// Starter templates for New › Diagram. Each is a plain JSON Canvas file next to this one, so a
// template can be opened and edited in Mosaic itself.

import blank from "./templates/Blank.canvas?raw";
import flowchart from "./templates/Flowchart.canvas?raw";
import fourPlusOne from "./templates/4+1 views.canvas?raw";
import c4Context from "./templates/C4 context.canvas?raw";

export interface DiagramTemplate {
  id: string;
  label: string;
  detail: string;
  /** Default file name, without `.canvas`. */
  stem: string;
  content: string;
}

export const DIAGRAM_TEMPLATES: DiagramTemplate[] = [
  { id: "blank", label: "Blank", detail: "An empty diagram", stem: "Diagram", content: blank },
  { id: "flowchart", label: "Flowchart", detail: "Start, steps, a decision with yes/no branches", stem: "Flowchart", content: flowchart },
  { id: "4+1", label: "4+1 architecture views", detail: "Logical, process, development and physical views, tied by scenarios", stem: "Architecture views", content: fourPlusOne },
  { id: "c4-context", label: "C4 system context", detail: "A person, your system and the systems around it", stem: "System context", content: c4Context },
  ...umlTemplates(),
];

/** The 14 UML diagram types, structural then behavioural, with the 4+1 view each usually serves. */
function umlTemplates(): DiagramTemplate[] {
  const files = import.meta.glob("./templates/uml/*.canvas", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const types: [name: string, kind: string, view: string][] = [
    ["Class", "Structural", "logical view"],
    ["Object", "Structural", "logical view"],
    ["Component", "Structural", "development view"],
    ["Deployment", "Structural", "physical view"],
    ["Package", "Structural", "development view"],
    ["Composite structure", "Structural", "logical view"],
    ["Profile", "Structural", "extends UML itself"],
    ["Use case", "Behavioural", "scenarios (+1)"],
    ["Activity", "Behavioural", "process view"],
    ["State machine", "Behavioural", "logical view"],
    ["Sequence", "Behavioural", "process view, scenarios"],
    ["Communication", "Behavioural", "process view"],
    ["Interaction overview", "Behavioural", "process view"],
    ["Timing", "Behavioural", "process view"],
  ];
  return types.map(([name, kind, view]) => ({
    id: `uml-${name.toLowerCase().replace(/ /g, "-")}`,
    label: `UML ${name.toLowerCase()} diagram`,
    detail: `${kind} · ${view}`,
    stem: `${name} diagram`,
    content: files[`./templates/uml/${name}.canvas`],
  }));
}
