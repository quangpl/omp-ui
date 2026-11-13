import type { ComponentType } from "react";
import {
  BookOpenIcon,
  BrainIcon,
  CodeIcon,
  GlobeIcon,
  InfoIcon,
  LightbulbIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  PencilIcon,
  PenLineIcon,
  SearchIcon,
  TerminalIcon,
  TriangleAlertIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import type { ActivityIcon } from "@/components/visualize/game";

/** Icon of each kind of agent activity (Visualize floor, agent log). */
export const ACTIVITY_ICON: Record<ActivityIcon, ComponentType<{ className?: string }>> = {
  terminal: TerminalIcon,
  read: BookOpenIcon,
  edit: PencilIcon,
  search: SearchIcon,
  delegate: UsersIcon,
  team: MessagesSquareIcon,
  web: GlobeIcon,
  advisor: LightbulbIcon,
  plan: ListChecksIcon,
  inspect: CodeIcon,
  think: BrainIcon,
  write: PenLineIcon,
  status: InfoIcon,
  error: TriangleAlertIcon,
  tool: WrenchIcon,
};
