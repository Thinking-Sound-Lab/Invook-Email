// Illustrative mailbox content for marketing previews. Labels and layout match
// the product; the people, addresses, and messages are fictional and use the
// reserved .example domain.

export const PREVIEW_LABEL_CLASS_NAMES = {
  Important: "bg-pill-red text-pill-red-foreground",
  Clients: "bg-pill-purple text-pill-purple-foreground",
  Newsletter: "bg-pill-blue text-pill-blue-foreground",
  Billing: "bg-pill-green text-pill-green-foreground",
  Others: "bg-pill-brown text-pill-brown-foreground",
} as const;

export type PreviewLabelName = keyof typeof PREVIEW_LABEL_CLASS_NAMES;

export interface PreviewAccount {
  email: string;
  initials: string;
  ringClassName: string;
}

export const PREVIEW_USER = {
  name: "Maya Chen",
  email: "maya@studio.example",
  initials: "MC",
} as const;

export const PREVIEW_ACCOUNTS = {
  work: {
    email: "maya@studio.example",
    initials: "MS",
    ringClassName: "ring-pill-blue-foreground",
  },
  personal: {
    email: "maya@personal.example",
    initials: "MP",
    ringClassName: "ring-pill-green-foreground",
  },
} as const satisfies Record<string, PreviewAccount>;

export type PreviewAccountKey = keyof typeof PREVIEW_ACCOUNTS;

export interface PreviewThread {
  people: string;
  messageCount?: number;
  subject: string;
  snippet: string;
  label: PreviewLabelName;
  receivedAt: string;
  isUnread: boolean;
  isStarred: boolean;
  account: PreviewAccountKey;
}

export const PREVIEW_TODAY_THREADS: PreviewThread[] = [
  {
    people: "Priya Raman",
    messageCount: 3,
    subject: "Contract redlines before Thursday",
    snippet: "I marked the two clauses we still need to settle before we sign.",
    label: "Important",
    receivedAt: "9:41 AM",
    isUnread: true,
    isStarred: true,
    account: "work",
  },
  {
    people: "Daniel Okafor",
    subject: "Homepage feedback, round two",
    snippet: "The new hero works. A few notes on the pricing table and footer.",
    label: "Clients",
    receivedAt: "9:18 AM",
    isUnread: true,
    isStarred: false,
    account: "work",
  },
  {
    people: "Field Notes Weekly",
    subject: "Five small ideas worth trying",
    snippet: "This issue: calmer standups, shorter docs, and a better Friday.",
    label: "Newsletter",
    receivedAt: "8:52 AM",
    isUnread: false,
    isStarred: false,
    account: "personal",
  },
  {
    people: "Cloudline Hosting",
    subject: "Your October invoice is ready",
    snippet: "Invoice 2041 is now available in your account.",
    label: "Billing",
    receivedAt: "8:30 AM",
    isUnread: false,
    isStarred: false,
    account: "work",
  },
];

export const PREVIEW_YESTERDAY_THREADS: PreviewThread[] = [
  {
    people: "Sam Chen",
    messageCount: 2,
    subject: "Dinner on Saturday?",
    snippet: "Thinking about the new place on 5th. Does 7:30 work for you?",
    label: "Important",
    receivedAt: "6:12 PM",
    isUnread: true,
    isStarred: false,
    account: "personal",
  },
  {
    people: "Parcelpoint",
    subject: "Your order has shipped",
    snippet: "Tracking is now available for your recent order.",
    label: "Others",
    receivedAt: "2:40 PM",
    isUnread: false,
    isStarred: false,
    account: "personal",
  },
  {
    people: "Lena Fischer",
    subject: "Brand guidelines, final files",
    snippet: "Everything is in the shared folder. Let me know if anything is missing.",
    label: "Clients",
    receivedAt: "11:05 AM",
    isUnread: false,
    isStarred: true,
    account: "work",
  },
  {
    people: "Harbor Bank",
    subject: "Payment received",
    snippet: "We received your card payment. No action is needed.",
    label: "Billing",
    receivedAt: "9:20 AM",
    isUnread: false,
    isStarred: false,
    account: "personal",
  },
];
