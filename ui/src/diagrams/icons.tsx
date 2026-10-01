// Network and cloud icons for diagrams (bundled Lucide icons): a card's "icon" draws above its label.
// The names are listed in crates/mosaic-core/src/diagram_format.json.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Bell,
  Box,
  Building2,
  Cloud,
  Container,
  Cpu,
  CreditCard,
  Database,
  File,
  Globe,
  HardDrive,
  Key,
  Laptop,
  Lock,
  Mail,
  MessageSquare,
  Monitor,
  Network,
  Router,
  Server,
  Shield,
  Smartphone,
  User,
  Users,
  Wifi,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import format from "../../../crates/mosaic-core/src/diagram_format.json";

export const ICONS: Record<string, LucideIcon> = {
  server: Server,
  database: Database,
  cloud: Cloud,
  laptop: Laptop,
  smartphone: Smartphone,
  monitor: Monitor,
  router: Router,
  network: Network,
  wifi: Wifi,
  globe: Globe,
  shield: Shield,
  lock: Lock,
  key: Key,
  user: User,
  users: Users,
  building: Building2,
  mail: Mail,
  message: MessageSquare,
  bell: Bell,
  "credit-card": CreditCard,
  cpu: Cpu,
  "hard-drive": HardDrive,
  container: Container,
  box: Box,
  file: File,
  workflow: Workflow,
};

export const ICON_NAMES = format.icons;
export const iconLabel = (name: string) => name[0].toUpperCase() + name.slice(1).replace(/-/g, " ");

/** The icon as standalone SVG markup, for exports. */
export function iconMarkup(name: string, color: string, size: number): string | null {
  const icon = ICONS[name];
  return icon ? renderToStaticMarkup(createElement(icon, { size, color, strokeWidth: 1.75 })) : null;
}
