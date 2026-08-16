import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { ScrollArea } from "./scroll-area";

test("a visually hidden scrollbar remains mounted to enable viewport scrolling", () => {
  const markup = renderToStaticMarkup(
    <ScrollArea type="always" hideScrollbar>
      <div>Scrollable content</div>
    </ScrollArea>,
  );

  assert.match(
    markup,
    /data-slot="scroll-area-scrollbar"[^>]*class="[^"]*hidden/,
  );
});
