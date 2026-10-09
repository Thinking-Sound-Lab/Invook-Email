import assert from "node:assert/strict";
import test from "node:test";

import { parseLegacyColor } from "./html-legacy-color";

test("legacy colors resolve to the color a browser paints", () => {
  // Expected values are what Chromium computes for `<font color>`.
  const cases: Array<[string, string]> = [
    ["#FFFFFF", "#ffffff"],
    [" ffffff ", "#ffffff"],
    ["#333", "#333333"],
    ["333", "#030303"],
    ["fff", "#0f0f0f"],
    ["abc", "#0a0b0c"],
    ["f", "#0f0000"],
    ["#ffff", "#ffff00"],
    ["#12345", "#123450"],
    ["1234567", "#124570"],
    ["000000001", "#000001"],
    ["00000000a00000000b00000000c", "#0a0b0c"],
    ["6db6ec49efd278cd0bc92d1e5e072d68", "#6ecde0"],
    ["chucknorris", "#c00000"],
    ["windowtext", "#0d0e00"],
    ["rgb(255, 0, 0)", "#005500"],
    ["red; position: fixed", "#ed00f0"],
    ["\u{1F600}ff", "#00ff00"],
    [" ", "#000000"],
    ["#", "#000000"],
    ["a".repeat(200), "#aaaaaa"],
  ];

  for (const [value, expected] of cases) {
    assert.equal(parseLegacyColor(value), expected, JSON.stringify(value));
  }
});

test("legacy colors keep CSS named colors and match them without Unicode folding", () => {
  assert.equal(parseLegacyColor("red"), "red");
  assert.equal(parseLegacyColor("White"), "white");
  assert.equal(parseLegacyColor(" RebeccaPurple "), "rebeccapurple");
  assert.equal(parseLegacyColor("grey"), "grey");
  // U+212A KELVIN SIGN lowercases to "k" but is not an ASCII match.
  assert.equal(parseLegacyColor("blac\u212A"), "#b0ac00");
});

test("legacy colors that apply no color resolve to null", () => {
  assert.equal(parseLegacyColor(""), null);
  assert.equal(parseLegacyColor("transparent"), null);
  assert.equal(parseLegacyColor(" TRANSPARENT "), null);
});
