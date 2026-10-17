import type { ReactNode } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

import { GITHUB_REPOSITORY_URL } from "./marketing-links";

const questions: ReadonlyArray<{ value: string; question: string; answer: ReactNode }> = [
  {
    value: "providers",
    question: "Which email providers does Invook support?",
    answer: "Gmail. You can connect several Gmail accounts and use them together in one workspace.",
  },
  {
    value: "labeling",
    question: "How does Invook choose a label?",
    answer:
      "When a new thread lands in your Inbox, an LLM reads it and picks exactly one of your enabled labels, using each label’s plain-language description. Threads that match nothing get Others.",
  },
  {
    value: "gmail-labels",
    question: "Does Invook change my Gmail labels?",
    answer:
      "No. Invook labels live in Invook, not in Gmail. Actions you take in Invook, such as starring or reading a thread, are written to Gmail.",
  },
  {
    value: "past-mail",
    question: "Can I label mail I already have?",
    answer:
      "Yes. You can apply a label to the last 7, 30, or 90 days of email. Automatic labeling otherwise covers Inbox threads from the last 14 days.",
  },
  {
    value: "access",
    question: "Does signing in give Invook access to my mailbox?",
    answer:
      "No. Signing in with Google only confirms who you are. Connecting Gmail is a separate step that you approve.",
  },
  {
    value: "open-source",
    question: "Is Invook open source?",
    answer: (
      <>
        Yes. Invook is licensed under Apache 2.0, and the full source is{" "}
        <a href={GITHUB_REPOSITORY_URL}>on GitHub</a>.
      </>
    ),
  },
  {
    value: "self-host",
    question: "Can I host Invook myself?",
    answer:
      "Yes. Docker Compose runs the web app, API, worker, PostgreSQL, and MinIO. You’ll also need Google OAuth with Gmail Pub/Sub, Temporal Cloud, and an OpenAI key.",
  },
];

export function FaqSection() {
  return (
    <section id="faq" className="marketing-reveal mx-auto max-w-7xl px-6 pt-28 sm:pt-36">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:gap-16">
        <h2 className="text-[2rem] font-semibold leading-[1.1] tracking-[-0.04em] text-lp-ink sm:text-[2.75rem]">
          Questions and answers
        </h2>
        <Accordion type="single" collapsible className="gap-2">
          {questions.map((item) => (
            <AccordionItem
              key={item.value}
              value={item.value}
              className="rounded-2xl bg-lp-surface px-6 not-last:border-b-0"
            >
              <AccordionTrigger className="py-5 text-base font-semibold tracking-[-0.02em] text-lp-ink hover:no-underline focus-visible:ring-lp-ink/30">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="pb-5 text-sm leading-6 text-lp-muted [&_a]:text-lp-ink [&_a]:hover:text-lp-ink">
                {item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
