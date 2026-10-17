import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Tabs, TabsList, TabsTrigger } from "./tabs";

const browserWindow = new Window({ url: "http://localhost" });
for (const [name, value] of Object.entries({
  window: browserWindow,
  document: browserWindow.document,
  navigator: browserWindow.navigator,
  HTMLElement: browserWindow.HTMLElement,
  KeyboardEvent: browserWindow.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

let currentRoot: Root | null = null;

afterEach(async () => {
  const root = currentRoot;
  currentRoot = null;
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
});

async function renderTabs(orientation: "horizontal" | "vertical") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  currentRoot = root;
  await act(async () =>
    root.render(
      <Tabs orientation={orientation} defaultValue="first">
        <TabsList>
          <TabsTrigger value="first">First</TabsTrigger>
          <TabsTrigger value="second">Second</TabsTrigger>
        </TabsList>
      </Tabs>,
    ),
  );

  const tablist = document.querySelector('[role="tablist"]');
  const [firstTrigger, secondTrigger] = document.querySelectorAll('[role="tab"]');
  assert.ok(tablist && firstTrigger && secondTrigger);
  return { tablist, firstTrigger, secondTrigger };
}

// Roving focus prevents the default action only for keys it handles in the
// current orientation, so dispatchEvent returns false exactly for those keys.
function pressKey(target: Element, key: string): boolean {
  return target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

test("vertical tabs move between triggers with Up and Down, not Left and Right", async () => {
  const { tablist, firstTrigger, secondTrigger } = await renderTabs("vertical");
  assert.equal(tablist.getAttribute("aria-orientation"), "vertical");

  assert.equal(pressKey(firstTrigger, "ArrowRight"), true);

  await act(async () => {
    const isSecondTriggerFocused = new Promise<void>((resolve) => {
      secondTrigger.addEventListener("focus", () => resolve(), { once: true });
    });
    assert.equal(pressKey(firstTrigger, "ArrowDown"), false);
    await isSecondTriggerFocused;
  });
  assert.equal(secondTrigger.getAttribute("data-state"), "active");
});

test("horizontal tabs keep Left and Right navigation", async () => {
  const { tablist, firstTrigger } = await renderTabs("horizontal");
  assert.equal(tablist.getAttribute("aria-orientation"), "horizontal");

  assert.equal(pressKey(firstTrigger, "ArrowDown"), true);
  await act(async () => {
    assert.equal(pressKey(firstTrigger, "ArrowRight"), false);
  });
});
