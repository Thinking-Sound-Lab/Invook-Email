import {
  Brain02Icon,
  Calendar03Icon,
  PreferenceHorizontalIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import type { MemoryType } from "@invook/contracts";

export const memoryDefinitions = {
  preference: {
    label: "Preferences",
    singular: "preference",
    icon: PreferenceHorizontalIcon,
    description: "Rules that should shape every reply Invook drafts.",
  },
  contact: {
    label: "Contacts",
    singular: "contact memory",
    icon: UserMultiple02Icon,
    description: "How you communicate with a specific email address.",
  },
  scheduling: {
    label: "Scheduling",
    singular: "scheduling memory",
    icon: Calendar03Icon,
    description: "How you coordinate meetings, times, and confirmations.",
  },
} satisfies Record<
  MemoryType,
  {
    label: string;
    singular: string;
    icon: typeof Brain02Icon;
    description: string;
  }
>;

export const displayedMemoryTypes = ["preference", "contact", "scheduling"] as const satisfies
  readonly MemoryType[];
