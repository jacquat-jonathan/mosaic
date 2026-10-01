// Starter templates for New › Diagram. Each is a plain JSON Canvas file next to this one, so a
// template can be opened and edited in Mosaic itself. More (UML types) come with the shape stencils.

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
];
