import {
  Bot,
  CalendarClock,
  CalendarDays,
  Inbox,
  ListChecks,
  ListFilter,
  MessagesSquare,
  PanelsTopLeft,
  Plug,
  Search,
  Settings,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { parseView } from "./specialTabs";

const icons: Record<string, LucideIcon> = {
  calendar: CalendarDays,
  today: CalendarDays,
  week: CalendarDays,
  tasks: ListChecks,
  board: ListChecks,
  overdue: ListChecks,
  projects: ListChecks,
  search: Search,
  query: ListFilter,
  chat: MessagesSquare,
  chats: MessagesSquare,
  agents: Bot,
  workflows: Workflow,
  workflow: CalendarClock,
  "new-workflow": Workflow,
  run: ListChecks,
  runs: ListChecks,
  activity: Inbox,
  connections: Plug,
  settings: Settings,
  planning: PanelsTopLeft,
};

/** Keep workspace tabs recognizable alongside their matching navigation entries. */
export function specialTabIcon(path: string, size = 13) {
  const Icon = icons[parseView(path).kind] ?? PanelsTopLeft;
  return <Icon size={size} aria-hidden="true" />;
}
