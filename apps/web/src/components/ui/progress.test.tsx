import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { Progress } from "./progress";

test("determinate progress exposes its numeric value to assistive technology", () => {
  const markup = renderToStaticMarkup(<Progress value={42} />);

  assert.match(markup, /role="progressbar"/);
  assert.match(markup, /aria-valuenow="42"/);
});
