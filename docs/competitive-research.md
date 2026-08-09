# Invook Competitive Research: Gmail, Superhuman Mail, and Slashy

**Research date:** August 7, 2026  
**Scope:** Public product pages, company documentation, and the Y Combinator company profile. Product claims such as time saved are vendor claims unless otherwise noted. This was not a hands-on benchmark of signed-in products.

## Executive conclusion

Invook cannot differentiate merely by generating replies “in your voice,” prioritizing email, or reminding users to follow up. Gmail, Superhuman Mail, and Slashy now all claim versions of those capabilities.

The strongest wedge is a **relationship-aware action inbox**:

1. Tell the user why each message matters and what commitment is at risk.
2. Produce replies using an inspectable, audience-specific voice profile.
3. Maintain a user-visible relationship and commitment memory with evidence linking every remembered fact to its source.
4. Optimize for decision speed: the time from opening the inbox to safely completing the next action.

Superhuman wins primarily through workflow speed and polish. Slashy is pursuing an AI executive-assistant model with broad context, memory, automations, and access through chat surfaces. Gmail wins through distribution, price, Google context, and rapidly improving Gemini features. Invook should combine fast interaction with a much more transparent and trustworthy memory system, rather than trying to match every automation or integration immediately.

## 1. Gmail baseline

Gmail is no longer just the conventional baseline. Google described Gmail in January 2026 as a “personal, proactive inbox assistant.” Its announced capabilities include:

- AI Overviews that summarize conversations and answer natural-language questions across the inbox.
- Help Me Write for drafting and polishing.
- Suggested Replies that use conversation context and match the user's tone and style.
- Proofread for grammar, tone, and style.
- AI Inbox, initially announced for trusted testers, which identifies VIPs, to-dos, and high-stakes messages using contact frequency, contacts, and relationships inferred from email content.
- The wider Google ecosystem and potential context from other Google apps.

Gmail's structural advantages are difficult to attack directly:

- It is the mailbox and source of truth, not an overlay.
- It is free or already included in Google Workspace.
- It has enormous distribution, strong mobile clients, search, spam filtering, and Google Calendar/Drive integration.
- Users do not need to grant another company access to their mailbox.

Its weaknesses create room for a focused client:

- The interface serves billions of users and many use cases, so it cannot be as opinionated as a dedicated power-user product.
- AI features are mixed into a large traditional email interface rather than forming one continuous clearing workflow.
- Availability can vary by plan, geography, language, and rollout stage.
- Public descriptions emphasize generated help, but do not expose a detailed, editable voice model or an evidence-backed relationship memory ledger.

## 2. How Superhuman differs from Gmail

Superhuman Mail is not simply Gmail with better styling. Gmail or Outlook remains the underlying provider, while Superhuman replaces the interaction layer and organizes it around speed, keyboard control, and follow-through.

### Workflow and UI

Superhuman's enduring differentiation is the interaction system:

- Keyboard shortcuts and a command-palette mental model.
- Split Inbox and AI-created labels for batching similar work.
- Auto Archive for removing classes of low-value mail.
- Snooze, Send Later, reminders, read status, snippets, offline support, and fast open/send/copy actions.
- Integrated scheduling and calendar actions inside the email flow.
- Team features including live shared conversations, comments, shared drafts, and reply-collision indicators.

Gmail exposes many individual email primitives, but Superhuman composes them into a deliberately coached workflow. Its product claim is twice-as-fast inbox handling and four hours saved per week; these are Superhuman's claims, not results independently verified for this report.

### Superhuman's AI and user voice

Superhuman states that its AI matches the voice and tone of emails the user has already sent and applies that style to generated email. Its AI feature set includes:

- Write with AI from short notes.
- Instant Reply and Auto Drafts.
- Voice-and-tone matching.
- Write with Voice on mobile, converting spoken intent into a complete message rather than only transcribing it.
- Automatic follow-up reminders and prepared follow-up drafts.
- Auto Summarize and Ask AI across inbox, calendar, and the web.
- Auto Labels and Auto Archive.

The public explanation of voice learning is relatively simple: learn from previously sent messages. It does not publicly describe the exact retrieval, style representation, update cadence, or how user edits alter the profile.

### Commercial position

At the time of research, Superhuman Mail listed Starter at **$25 per member/month billed annually** and Business at **$33 per member/month billed annually**. Advanced capabilities such as Auto Drafts, Ask AI, custom AI labels, MCP, HubSpot, and Salesforce were presented under Business.

Superhuman is therefore positioned as a premium productivity product for professionals and teams, not a mass-market Gmail replacement.

## 3. Slashy analysis

The company referred to as “Slacy” appears to be **Slashy**, a Y Combinator Summer 2025 company. YC describes it as “Cursor for Email.” Its current site says it supports Gmail and Google Workspace, with Outlook support coming later.

### Product strategy

Slashy starts with much of the Superhuman foundation—fast shortcuts, unified inbox, tracking, scheduling, labels, snippets, mobile, and team comments—but makes a conversational assistant the center of the product.

Its public product claims include:

- A Cursor-like AI sidebar that can search, draft, schedule, and act.
- Drafts, summaries, and follow-ups requested in natural language.
- iMessage, Slack, voice, and mobile access to the inbox.
- Automations triggered by incoming email, calendar events, or schedules.
- Important-email alerts outside the email client.
- CRM, meeting-notes, calendar, Notion, and other integrations.
- Follow-up monitoring and automatically prepared nudges.
- Natural-language labels that learn from corrections.

This is closer to an AI executive assistant than a traditional email client with AI features.

### Slashy voice learning

Slashy's YC launch description is unusually specific about its claimed context. For a draft, it says it can use:

- The current thread.
- Past emails the user has sent.
- Changes the user made to previous AI drafts before sending.
- Its custom email memory system.
- Recipient context from LinkedIn and the web.
- Connected context from meeting notes, CRM, Notion, and other tools.

It also says its personalized memory keeps notes on how the user writes, who they communicate with, scheduling preferences, decisions, and prior edits, and that it periodically rewrites those notes to better match the user. The current product site summarizes this as learning voice, relationships, decisions, and preferences from every email, event, and correction.

These are company descriptions; the exact architecture and quality are not publicly verifiable. However, they establish a high competitive bar: edit-based learning and cross-application context are not unique differentiators by themselves.

### Slashy UI and speed

Slashy's interface combines:

- A conventional dense inbox for rapid triage.
- A persistent conversational assistant.
- Keyboard shortcuts and command search.
- One-click action suggestions inside a thread.
- A memory/settings surface showing example preferences and contacts.
- External interaction through iMessage, Slack, voice, and iPhone.

The advantage is reach and breadth: the user can delegate without opening email. The likely trade-off is complexity and trust. The assistant can access many systems and perform increasingly broad actions, so understanding what it knows, why it acted, and how to correct it becomes critical.

Slashy listed a Professional plan at **$25 per user/month billed annually** during this research.

## 4. Competitive comparison

| Dimension | Gmail | Superhuman Mail | Slashy | Opportunity for Invook |
| --- | --- | --- | --- | --- |
| Core advantage | Distribution and Google ecosystem | Polished speed and workflow | AI assistant that operates across channels | Relationship and commitment intelligence with visible evidence |
| Primary UI | General-purpose mailbox | Keyboard-first power client | Inbox plus conversational sidebar | Brief-first action queue plus fast thread view |
| User voice | Suggested replies match tone/style; Google context is expanding | Matches sent-email voice and tone | Sent mail, edits, memory, recipient and external context | Inspectable profiles by audience/contact, with examples and confidence |
| Inbox intelligence | AI summaries, questions, suggested replies, emerging AI Inbox | Auto Labels, Auto Archive, Split Inbox, summaries | Learned labels, important alerts, natural-language delegation | Explain why an item matters and which obligation/deadline it affects |
| Memory | Google account and inferred relationship context | Knowledge-base and inbox/calendar context are marketed | Explicit personalized memory across email, events, edits, and integrations | Provenance-backed relationship timeline and commitment ledger |
| Follow-up | Nudges/tasks and Gemini assistance | Mature Remind Me and automatic reminders/drafts | Watches for replies and can draft nudges | Bidirectional commitment tracking: what I owe and what they owe |
| Automation | Google ecosystem automations | Email-focused AI automation and team workflow | Broad assistant automations across apps/channels | Conservative approval modes with previews, evidence, and undo |
| Price pressure | Free/included for many users | Premium | Premium | Must demonstrate measurable saved decisions or recovered opportunities |

## 5. What Invook should learn

### From Superhuman

1. **Speed must be designed into the interaction model.** Keyboard handling, optimistic updates, offline cache, prefetching, and stable layouts are product features, not implementation details.
2. **Teach one repeatable workflow.** The value comes from repeatedly moving a thread through reply, archive, snooze, or remind—not from a collection of disconnected AI buttons.
3. **Batching reduces cognitive switching.** A user should clear similar decisions together: quick replies, approvals, waiting, newsletters, and high-risk relationships.
4. **Reliability earns the right to add automation.** Reading, threading, drafts, sending, and undo must feel flawless before autonomous behavior.

### From Slashy

1. **The context for a good reply lives beyond the open thread.** Sent mail, edits, relationship history, meetings, and CRM context can materially improve a draft.
2. **Edits are the strongest voice signal.** Capture semantic changes—shorter, warmer, removed commitment, corrected fact—not only raw text diffs.
3. **Email is an action surface.** Users want the scheduling, follow-up, and preparation work around a message completed too.
4. **Memory must improve continuously.** Static onboarding preferences will quickly become stale.
5. **Conversational access is valuable, but broad integrations can dilute the MVP.** Invook should prove the Gmail loop before matching Slashy across Slack, CRM, Notion, meetings, and mobile.

## 6. Recommended differentiation for Invook

### Positioning

> **Invook is the email client that remembers every relationship and makes sure every commitment is completed—in your real voice, with evidence you can trust.**

This is narrower and more defensible than “an AI assistant for email.”

### A. Make voice visible instead of magical

Create a **Voice Studio** where users can inspect and control:

- Concision, warmth, directness, formality, structure, greeting, and sign-off.
- Different profiles for customer, investor, colleague, vendor, friend, or a specific contact.
- Example sent emails supporting each learned preference.
- Recent lessons learned from edits.
- A preview showing “why this draft sounds like you.”
- Reset, exclude, and correct controls.

This contrasts with opaque claims that the system “learns your voice.” Transparency can become a trust and onboarding advantage.

### B. Build evidence-backed relationship memory

Each contact should have a compact relationship page containing:

- Current relationship and organization.
- Active topics and projects.
- Decisions and preferences.
- Commitments made by either side.
- Open questions and next expected action.
- A chronological interaction timeline.

Every fact should link to the source email or event, show confidence and freshness, and be editable or deletable. Generated drafts should expose which memories were used. Neither competitor's public materials make provenance and correction the central user experience.

### C. Optimize decision speed, not only rendering speed

The inbox should answer three questions before the user opens a thread:

1. Why does this matter?
2. What action is expected?
3. When does it become costly to ignore?

Recommended interface:

- A daily brief containing the small set of messages that could block people, lose opportunities, or violate commitments.
- A keyboard-first action queue: reply, approve draft, archive, snooze, remind, or mark waiting.
- Precomputed summaries and draft candidates generated during synchronization so opening a thread usually has no AI spinner.
- Visible confidence and a reason for priority, such as “you promised the deck today.”
- Fast undo for every mailbox action.

### D. Make commitment tracking the wedge

Competitors offer reminders. Invook should model the underlying obligation:

- “I owe Sarah a proposal by Friday.”
- “Sarah owes me confirmation.”
- “If no response by Tuesday, follow up.”
- “This reply creates a new promise.”

Before sending, Invook can warn when a draft introduces a date, price, deliverable, or promise and ask whether to track it. This turns follow-up from a timer into a relationship-aware system.

### E. Lead with trust

- Cite the messages supporting summaries, memories, and draft facts.
- Flag unsupported names, dates, prices, and commitments before send.
- Let users exclude labels, contacts, or date ranges from indexing.
- Provide user-visible indexed-data and retention controls.
- Keep sending and material mailbox actions approval-based until the user explicitly enables a narrow automation.

Trust is especially valuable against a broad autonomous-assistant positioning.

## 7. MVP implication

### Build now

- Gmail sync and indexing of Inbox, Sent, and relevant Archive history.
- Keyboard-first triage with reply, archive, snooze, remind, and waiting states.
- Thread summaries, required-action extraction, and importance reasons.
- Voice profile bootstrapped from sent mail.
- Learning from user edits.
- Contact relationship timeline with source citations.
- Two-sided commitment ledger and reply-aware reminders.
- Precomputed draft suggestions for genuinely actionable messages.

### Delay

- Slack and iMessage bots.
- CRM and meeting-note integrations.
- Team comments and shared inboxes.
- General-purpose autonomous workflows.
- Read tracking and sales-specific tooling.
- Outlook support.

These delayed features are useful, but competing on them immediately would put Invook into a breadth race with Slashy and a polish race with Superhuman before establishing its unique value.

## 8. Suggested product metrics

- Median time from inbox open to completed decision.
- Percentage of priority explanations users agree with.
- Important-message miss rate.
- Draft acceptance and semantic edit distance.
- Voice rating by audience/contact type.
- Memory correction and deletion rate.
- Percentage of generated facts with accessible source evidence.
- Commitments detected, completed, overdue, and recovered by reminders.
- Follow-ups resulting in a reply or closed loop.
- P50/P95 navigation latency and time until a usable draft appears.

## Sources

1. Google, **“Gmail is entering the Gemini era,”** January 8, 2026: https://blog.google/products-and-platforms/products/gmail/gmail-is-entering-the-gemini-era/
2. Superhuman, **Superhuman Mail product page:** https://superhuman.com/products/mail
3. Superhuman, **Superhuman Mail AI:** https://superhuman.com/products/mail/ai
4. Superhuman, **Mail pricing:** https://superhuman.com/plans/mail
5. Slashy, **Product homepage:** https://www.slashy.com/
6. Y Combinator, **Slashy company and launch profile:** https://www.ycombinator.com/companies/slashy

