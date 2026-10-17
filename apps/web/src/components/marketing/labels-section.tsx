import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  BuiltInLabelsPreview,
  CustomLabelPreview,
  LabelControlPreview,
  PastMailPreview,
  SampleMatchesPreview,
} from "./label-feature-previews";
import { SectionHeading } from "./section-heading";

const labelFeatures = [
  {
    value: "built-in",
    title: "Start with four labels",
    description: "Important, Newsletter, Billing, and Others come ready to use.",
    preview: <BuiltInLabelsPreview />,
  },
  {
    value: "custom",
    title: "Describe your own",
    description: "Name a label and explain in plain language which emails belong in it.",
    preview: <CustomLabelPreview />,
  },
  {
    value: "preview",
    title: "Preview before you save",
    description: "See sample matches from up to 100 recent Inbox threads first.",
    preview: <SampleMatchesPreview />,
  },
  {
    value: "past-mail",
    title: "Apply it to past mail",
    description: "Label the last 7, 30, or 90 days when you create a label.",
    preview: <PastMailPreview />,
  },
  {
    value: "control",
    title: "Keep the final say",
    description: "Change any thread’s label. Your Gmail labels stay untouched.",
    preview: <LabelControlPreview />,
  },
] as const;

export function LabelsSection() {
  return (
    <section id="labels" className="marketing-reveal mx-auto max-w-7xl px-6 pt-28 sm:pt-36">
      <Tabs
        orientation="vertical"
        defaultValue={labelFeatures[0].value}
        className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-12"
      >
        <div>
          <SectionHeading
            align="start"
            title="Labels on your terms"
            description="Every new Inbox thread gets exactly one label, classified by an LLM from definitions you can read and write."
          />
          <TabsList className="mt-10 w-full items-stretch gap-1 bg-transparent p-0">
            {labelFeatures.map((feature) => (
              <TabsTrigger
                key={feature.value}
                value={feature.value}
                className="h-auto flex-col items-start gap-1 whitespace-normal rounded-2xl px-5 text-left text-lp-ink/45 hover:text-lp-ink/75 group-data-vertical/tabs:py-4 data-active:bg-lp-surface data-active:text-lp-ink"
              >
                <span className="text-base font-semibold tracking-[-0.02em]">{feature.title}</span>
                <span className="text-sm font-normal leading-6">{feature.description}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <div className="lg:sticky lg:top-24">
          {labelFeatures.map((feature) => (
            <TabsContent key={feature.value} value={feature.value}>
              {feature.preview}
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </section>
  );
}
