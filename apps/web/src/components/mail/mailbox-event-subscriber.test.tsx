import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import type {
  MailboxShell,
  MailboxSidebarCounts,
  MailboxThreadDetail,
  MailboxThreadPage,
  MailboxThreadSummary,
} from "@invook/contracts";
import axios, { AxiosError, CanceledError, type InternalAxiosRequestConfig } from "axios";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import { useThreadDetail } from "@/hooks/use-thread-detail";
import { useMailboxStore } from "@/stores/mailbox/store";
import { useMailShell } from "./mail-shell-provider";

const browserWindow = new Window({ url: "http://localhost/mail" });
for (const [name, value] of Object.entries({
  window: browserWindow,
  self: browserWindow,
  document: browserWindow.document,
  navigator: browserWindow.navigator,
  HTMLElement: browserWindow.HTMLElement,
  HTMLInputElement: browserWindow.HTMLInputElement,
  Event: browserWindow.Event,
  EventTarget: browserWindow.EventTarget,
  MessageEvent: browserWindow.MessageEvent,
  MouseEvent: browserWindow.MouseEvent,
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  ResizeObserver: browserWindow.ResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

class TestEventSource extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = 0;
  isClosed = false;

  constructor(url: string) {
    super();
    this.url = url;
    streams.push(this);
  }

  close(): void {
    this.isClosed = true;
    this.readyState = TestEventSource.CLOSED;
  }

  emit(name: string, data?: unknown): void {
    if (name === "open") this.readyState = TestEventSource.OPEN;
    if (name === "error") this.readyState = 0;
    this.dispatchEvent(data === undefined
      ? new Event(name)
      : new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}
Object.defineProperty(globalThis, "EventSource", { value: TestEventSource, configurable: true });

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  isDisconnected = false;
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  disconnect(): void { this.isDisconnected = true; }
  intersect(): void {
    const rect = document.body.getBoundingClientRect();
    this.callback([{
      isIntersecting: true, intersectionRatio: 1, target: document.body,
      boundingClientRect: rect, intersectionRect: rect, rootBounds: null, time: 0,
    }], this);
  }
}
Object.defineProperty(globalThis, "IntersectionObserver", { value: TestIntersectionObserver, configurable: true });

const accountId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const newThreadId = "33333333-3333-4333-8333-333333333333";
const oldThreadId = "44444444-4444-4444-8444-444444444444";
const shell: MailboxShell = {
  aiConfigured: true,
  user: { name: "Owner", email: "owner@example.com", image: null },
  accounts: [{
    id: accountId,
    email: "owner@example.com",
    image: null,
    status: "connected",
    syncState: { mailSync: "complete" },
    lastSyncedAt: "2026-10-10T01:00:00.000Z",
    replica: { state: "ready", readyAt: "2026-10-10T01:00:00.000Z" },
  }],
  accountLabels: [],
};
const counts: MailboxSidebarCounts = {
  all: { views: { all: 1, important: 0, starred: 0, drafts: 0, sent: 0, spam: 0, trash: 0 }, labels: {} },
  accounts: {},
};
function thread(id: string, subject: string): MailboxThreadSummary {
  return {
    id, subject, accountId, accountEmail: "owner@example.com", snippet: "",
    participants: ["sender@example.com"], isUnread: true, isStarred: false,
    isDraft: false, invookLabel: null, latestMessageAt: "2026-10-10T01:00:00.000Z", messageCount: 1,
  };
}
function page(threads: MailboxThreadSummary[], olderCursor: string | null = null): MailboxThreadPage {
  return { threads, pagination: { newerCursor: null, olderCursor } };
}
function detail(id: string, subject: string): MailboxThreadDetail {
  return { thread: { ...thread(id, subject), messages: [], gmailDrafts: [] }, invookLabels: [] };
}
const initialPage = page([thread(threadId, "Previously stored mail")]);
let root: Root | null = null;
let streams: TestEventSource[] = [];
let observers: TestIntersectionObserver[] = [];
let requests: InternalAxiosRequestConfig[] = [];
let refreshCount = 0;
let replacements: string[] = [];
const originalAdapter = axios.defaults.adapter;
let respond: (config: InternalAxiosRequestConfig) => unknown | Promise<unknown> = defaultResponse;

function defaultResponse(config: InternalAxiosRequestConfig): unknown {
  if (config.url === "/v1/mailbox/shell") return shell;
  if (config.url === "/v1/mailbox/sidebar-counts") return counts;
  if (config.url === "/v1/mailbox/thread-updates") return { threads: [], missingThreadIds: [] };
  if (config.url?.startsWith("/v1/mailbox/threads/")) return detail(threadId, "Thread detail");
  if (config.url === "/v1/mailbox/threads") return initialPage;
  throw new Error(`Unexpected request: ${config.url}`);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred promise not initialized"); };
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function abortable(config: InternalAxiosRequestConfig, promise: Promise<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CanceledError("Canceled request", config));
    if (config.signal?.aborted) return abort();
    config.signal?.addEventListener?.("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => config.signal?.removeEventListener?.("abort", abort));
  });
}

const router = {
  back() {}, forward() {}, push() {}, prefetch() {}, bfcacheId: "test",
  refresh() { refreshCount += 1; },
  replace(href: string) { replacements.push(href); },
};
function ShellProbe() {
  const { user } = useMailShell();
  return <output data-shell-name="">{user.name}</output>;
}
function ThreadProbe() {
  const { detail: openDetail, loadState } = useThreadDetail({ accountSelection: "all", threadId });
  return <output data-thread-detail="">{loadState}:{openDetail?.thread.subject}</output>;
}

async function renderMailbox(input: { view?: "all" | "starred"; isThreadOpen?: boolean } = {}): Promise<void> {
  const [
    { createRoot },
    { AppRouterContext },
    { SearchParamsContext },
    { MailShellProvider },
    { MailboxEventSubscriber },
    { MailList },
  ] = await Promise.all([
    import("react-dom/client"),
    import("next/dist/shared/lib/app-router-context.shared-runtime"),
    import("next/dist/shared/lib/hooks-client-context.shared-runtime"),
    import("./mail-shell-provider"),
    import("./mailbox-event-subscriber"),
    import("./mail-list"),
  ]);
  axios.defaults.adapter = async (config) => {
    requests.push(config);
    const data = await abortable(config, Promise.resolve(respond(config)));
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  const currentRoot = root;
  const view = input.view ?? "all";
  const query = new URLSearchParams({ view });
  if (input.isThreadOpen) query.set("thread", threadId);
  await act(async () => currentRoot.render(
    <AppRouterContext.Provider value={router}>
      <SearchParamsContext.Provider value={query}>
        <MailShellProvider shell={shell}>
          <MailboxEventSubscriber />
          <ShellProbe />
          {input.isThreadOpen
            ? <ThreadProbe />
            : <MailList key={view} accountSelection="all" currentView={view} initialPage={view === "all" ? initialPage : null} />}
        </MailShellProvider>
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>,
  ));
}
function currentStream(): TestEventSource {
  const stream = streams.at(-1);
  assert.ok(stream);
  return stream;
}
async function emit(name: string, data?: unknown): Promise<void> {
  await act(async () => currentStream().emit(name, data));
}
async function ready(): Promise<void> {
  await emit("open");
  await emit("mailbox-ready", { type: "mailbox_stream_ready", accountIds: [accountId] });
}
async function visibility(state: "visible" | "hidden"): Promise<void> {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
}
function listReads(): InternalAxiosRequestConfig[] {
  return requests.filter((request) => request.url === "/v1/mailbox/threads");
}
function historyEvent(threadIds: string[]) {
  return {
    accountId, createdAt: "2026-10-10T02:00:00.000Z", changeType: "history_applied",
    reason: "history_catchup", changedThreadIds: threadIds, refreshedThreadIds: [],
  };
}

afterEach(async () => {
  const currentRoot = root;
  if (currentRoot) await act(async () => currentRoot.unmount());
  root = null;
  for (const stream of streams) assert.equal(stream.isClosed, true);
  streams = [];
  observers = [];
  requests = [];
  refreshCount = 0;
  replacements = [];
  respond = defaultResponse;
  useMailboxStore.getState().reset();
  document.body.replaceChildren();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  axios.defaults.adapter = originalAdapter;
});
after(() => browserWindow.close());

test("tab return reads and displays current mail before the stream becomes ready", async () => {
  await renderMailbox();
  assert.match(document.body.textContent ?? "", /Previously stored mail/);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(listReads().length, 0);
  await visibility("hidden");
  assert.equal(streams.length, 1);
  assert.equal(currentStream().isClosed, false);
  const pendingPage = deferred<MailboxThreadPage>();
  respond = (config) => config.url === "/v1/mailbox/threads" ? pendingPage.promise : defaultResponse(config);
  await visibility("visible");
  assert.equal(listReads().length, 1);
  assert.match(document.body.textContent ?? "", /Previously stored mail/);
  await act(async () => pendingPage.resolve(page([thread(newThreadId, "Mail received while away")])));
  assert.match(document.body.textContent ?? "", /Mail received while away/);
  assert.doesNotMatch(document.body.textContent ?? "", /Previously stored mail|Connecting live|Loading more mail/);
  assert.equal(refreshCount, 0);
});

test("a slow shell and counts read do not hold back the first-page response", async () => {
  const pendingShell = deferred<MailboxShell>();
  const pendingCounts = deferred<MailboxSidebarCounts>();
  respond = (config) => {
    if (config.url === "/v1/mailbox/shell") return pendingShell.promise;
    if (config.url === "/v1/mailbox/sidebar-counts") return pendingCounts.promise;
    if (config.url === "/v1/mailbox/threads") return page([thread(newThreadId, "Already updated")]);
    return defaultResponse(config);
  };
  await renderMailbox();
  await ready();
  assert.match(document.body.textContent ?? "", /Already updated/);
  assert.equal(useMailboxStore.getState().sidebarCounts, null);
  await act(async () => {
    pendingShell.resolve({ ...shell, user: { ...shell.user, name: "Updated account metadata" } });
    pendingCounts.resolve(counts);
  });
  assert.equal(document.querySelector("[data-shell-name]")?.textContent, "Updated account metadata");
  assert.deepEqual(useMailboxStore.getState().sidebarCounts, counts);
  assert.equal(refreshCount, 0);
});

test("a broken stream reconnects immediately on resume without waiting for its retry", async () => {
  await renderMailbox();
  await ready();
  await visibility("hidden");
  await emit("error");
  assert.equal(document.querySelector('[role="alert"]'), null);
  const brokenStream = currentStream();
  respond = (config) => config.url === "/v1/mailbox/threads"
    ? page([thread(newThreadId, "Recovered before reconnect")]) : defaultResponse(config);
  await visibility("visible");
  assert.equal(streams.length, 2);
  assert.equal(brokenStream.isClosed, true);
  assert.match(document.body.textContent ?? "", /Recovered before reconnect/);
  assert.equal(refreshCount, 0);
  await ready();
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test("the existing stream continues patching rows while the tab is hidden", async () => {
  await renderMailbox();
  await ready();
  await visibility("hidden");
  respond = (config) => config.url === "/v1/mailbox/thread-updates"
    ? { threads: [thread(newThreadId, "Pushed in the background")], missingThreadIds: [] }
    : defaultResponse(config);
  await emit("mailbox", historyEvent([newThreadId]));
  assert.match(document.body.textContent ?? "", /Pushed in the background/);
  assert.equal(streams.length, 1);
  assert.equal(currentStream().isClosed, false);
  assert.equal(refreshCount, 0);
});

test("events received during recovery are reconciled after its snapshot and deduplicated", async () => {
  await renderMailbox();
  await ready();
  const pendingPage = deferred<MailboxThreadPage>();
  respond = (config) => {
    if (config.url === "/v1/mailbox/threads") return pendingPage.promise;
    if (config.url === "/v1/mailbox/thread-updates") {
      return { threads: [thread(newThreadId, "Newer event result")], missingThreadIds: [threadId] };
    }
    return defaultResponse(config);
  };
  await visibility("visible");
  await emit("mailbox", historyEvent([newThreadId, threadId]));
  await emit("mailbox", historyEvent([newThreadId]));
  assert.equal(requests.filter((request) => request.url === "/v1/mailbox/thread-updates").length, 0);
  await act(async () => pendingPage.resolve(initialPage));
  assert.match(document.body.textContent ?? "", /Newer event result/);
  assert.doesNotMatch(document.body.textContent ?? "", /Previously stored mail/);
  const patches = requests.filter((request) => request.url === "/v1/mailbox/thread-updates");
  assert.equal(patches.length, 1);
  const params: unknown = patches[0]?.params;
  assert.ok(typeof params === "object" && params !== null && "ids" in params);
  assert.equal(params.ids, `${newThreadId},${threadId}`);
});

test("resume supersedes an older pending read and prevents its late response overwriting mail", async () => {
  await renderMailbox();
  await ready();
  const oldRead = deferred<MailboxThreadPage>();
  respond = (config) => config.url === "/v1/mailbox/threads" ? oldRead.promise : defaultResponse(config);
  await visibility("visible");
  const supersededRequest = listReads().at(-1);
  assert.ok(supersededRequest);
  respond = (config) => config.url === "/v1/mailbox/threads"
    ? page([thread(newThreadId, "Most recent snapshot")]) : defaultResponse(config);
  await act(async () => window.dispatchEvent(new Event("online")));
  assert.equal(supersededRequest.signal?.aborted, true);
  assert.match(document.body.textContent ?? "", /Most recent snapshot/);
  await act(async () => oldRead.resolve(initialPage));
  assert.match(document.body.textContent ?? "", /Most recent snapshot/);
  assert.doesNotMatch(document.body.textContent ?? "", /Previously stored mail/);
});

test("a post-subscription read recovers changes absent from the earlier resume snapshot", async () => {
  await renderMailbox();
  await visibility("visible");
  respond = (config) => config.url === "/v1/mailbox/threads"
    ? page([thread(newThreadId, "Changed before subscription")]) : defaultResponse(config);
  await ready();
  assert.equal(listReads().length, 2);
  assert.match(document.body.textContent ?? "", /Changed before subscription/);
  assert.equal(refreshCount, 0);
});

test("recovery replaces untrusted pagination and cached views re-read instead of showing removed mail", async () => {
  await renderMailbox();
  await act(async () => {
    useMailboxStore.getState().appendPage({ key: "all:all", page: page([thread(oldThreadId, "Older removed mail")], "deep-cursor") });
    useMailboxStore.getState().hydratePage({ key: "all:starred", page: page([thread(oldThreadId, "Removed starred mail")]) });
  });
  respond = (config) => config.url === "/v1/mailbox/threads" ? page([]) : defaultResponse(config);
  await ready();
  const state = useMailboxStore.getState();
  assert.deepEqual(state.pagesByKey["all:all"]?.threadIds, []);
  assert.equal(state.pagesByKey["all:all"]?.olderCursor, null);
  assert.equal(state.threadsById[threadId], undefined);
  assert.equal(state.pagesByKey["all:starred"]?.isStale, true);
  await renderMailbox({ view: "starred" });
  assert.doesNotMatch(document.body.textContent ?? "", /Removed starred mail/);
  await renderMailbox();
  assert.doesNotMatch(document.body.textContent ?? "", /Previously stored mail|Older removed mail/);
  assert.equal(streams.length, 1);
});

test("open-thread recovery re-reads the detail and removes other visited details", async () => {
  useMailboxStore.getState().hydrateThreadDetail({ threadId: oldThreadId, detail: detail(oldThreadId, "Visited before the gap") });
  await renderMailbox({ isThreadOpen: true });
  respond = (config) => config.url?.startsWith("/v1/mailbox/threads/")
    ? detail(threadId, "Recovered open thread") : defaultResponse(config);
  await ready();
  assert.equal(document.querySelector("[data-thread-detail]")?.textContent, "available:Recovered open thread");
  assert.equal(useMailboxStore.getState().detailsById[oldThreadId], undefined);
});

test("pagination started before recovery cannot append mail from a superseded cursor", async () => {
  await renderMailbox();
  respond = (config) => config.url === "/v1/mailbox/threads"
    ? page(initialPage.threads, "old-cursor") : defaultResponse(config);
  await ready();
  const pendingOlderPage = deferred<MailboxThreadPage>();
  respond = (config) => {
    if (config.url === "/v1/mailbox/threads") {
      const params: unknown = config.params;
      if (typeof params === "object" && params !== null && "cursor" in params) return pendingOlderPage.promise;
      return page([thread(newThreadId, "Current head")], "current-cursor");
    }
    return defaultResponse(config);
  };
  const observer = [...observers].reverse().find((candidate) => !candidate.isDisconnected);
  assert.ok(observer);
  await act(async () => observer.intersect());
  const paginationRequest = listReads().at(-1);
  assert.ok(paginationRequest);
  await visibility("visible");
  assert.equal(paginationRequest.signal?.aborted, true);
  await act(async () => pendingOlderPage.resolve(page([thread(oldThreadId, "Superseded page")], "old-deep-cursor")));
  assert.match(document.body.textContent ?? "", /Current head/);
  assert.doesNotMatch(document.body.textContent ?? "", /Superseded page/);
  assert.equal(useMailboxStore.getState().pagesByKey["all:all"]?.olderCursor, "current-cursor");
});

test("a prefetch from before recovery cannot repopulate an invalidated detail", async () => {
  await renderMailbox();
  await ready();
  const pendingDetail = deferred<MailboxThreadDetail>();
  respond = (config) => config.url?.startsWith("/v1/mailbox/threads/")
    ? pendingDetail.promise : defaultResponse(config);
  const row = document.querySelector<HTMLAnchorElement>(`a[href*="thread=${threadId}"]`);
  assert.ok(row);
  await act(async () => row.focus());
  assert.equal(requests.filter((request) => request.url?.startsWith("/v1/mailbox/threads/")).length, 1);
  await visibility("visible");
  await act(async () => pendingDetail.resolve(detail(threadId, "Prefetched before recovery")));
  assert.equal(useMailboxStore.getState().detailsById[threadId], undefined);
});

test("changing the view during recovery cancels the old read without reopening the stream", async () => {
  await renderMailbox();
  await ready();
  const pendingAll = deferred<MailboxThreadPage>();
  respond = (config) => {
    if (config.url === "/v1/mailbox/threads") {
      const params: unknown = config.params;
      return typeof params === "object" && params !== null && "view" in params && params.view === "all"
        ? pendingAll.promise : page([thread(newThreadId, "Current starred view")]);
    }
    return defaultResponse(config);
  };
  await visibility("visible");
  const supersededRequest = listReads().at(-1);
  assert.ok(supersededRequest);
  await renderMailbox({ view: "starred" });
  assert.equal(supersededRequest.signal?.aborted, true);
  assert.match(document.body.textContent ?? "", /Current starred view/);
  await act(async () => pendingAll.resolve(initialPage));
  assert.doesNotMatch(document.body.textContent ?? "", /Previously stored mail/);
  assert.equal(streams.length, 1);
  assert.equal(useMailboxStore.getState().pagesByKey["all:all"]?.isStale, true);
});

test("persistent stream failures remain visible until a successful canonical recovery", async () => {
  await renderMailbox();
  await ready();
  await emit("error");
  assert.equal(document.querySelector('[role="alert"]'), null);
  await emit("error");
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /updates are unavailable/);
  await emit("open");
  assert.ok(document.querySelector('[role="alert"]'));
  await ready();
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test("failed canonical reads retain cached mail and show an unavailable state", async () => {
  await renderMailbox();
  await ready();
  respond = () => { throw new Error("API unavailable"); };
  await visibility("visible");
  assert.match(document.body.textContent ?? "", /Previously stored mail/);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /updates are unavailable/);
  assert.equal(refreshCount, 0);
});

test("expired sessions clear the mailbox cache and return to sign-in", async () => {
  await renderMailbox();
  respond = (config) => {
    throw new AxiosError("Unauthorized", "ERR_BAD_REQUEST", config, undefined, {
      data: null, status: 401, statusText: "Unauthorized", headers: {}, config,
    });
  };
  await ready();
  assert.deepEqual(replacements, ["/"]);
  assert.deepEqual(useMailboxStore.getState().threadsById, {});
  assert.equal(useMailboxStore.getState().shell, null);
  assert.equal(currentStream().isClosed, true);
});

test("loss of the mailbox shell takes precedence over an unrelated failed list read", async () => {
  await renderMailbox();
  respond = (config) => {
    const status = config.url === "/v1/mailbox/shell" ? 404 : 503;
    throw new AxiosError("Unavailable", "ERR_BAD_REQUEST", config, undefined, {
      data: null, status, statusText: "Unavailable", headers: {}, config,
    });
  };
  await ready();
  assert.deepEqual(replacements, ["/"]);
  assert.deepEqual(useMailboxStore.getState().threadsById, {});
  assert.equal(currentStream().isClosed, true);
});
