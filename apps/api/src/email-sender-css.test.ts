import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareSenderInlineStyle,
  prepareSenderStylesheet,
} from "./email-sender-css";

const authored = { adaptsTextColors: false };
const adapted = { adaptsTextColors: true };

function pairOf(color: string): string {
  return `light-dark(${color}, oklch(from ${color} max(l, 0.87 - 0.27 * l) c h))`;
}

test("sender stylesheets report the colors they declare", () => {
  const cases: Array<[string, boolean, boolean]> = [
    ["p { margin: 0; border-color: #ccc; }", false, false],
    ["p { color: #222; }", false, true],
    ["td { background: #fff; }", true, false],
    ["td { BACKGROUND-COLOR: #fff; }", true, false],
    ["td { background-image: url(https://example.com/a.png); }", true, false],
    ["td { background: none; background-color: transparent; }", false, false],
    ["@media (max-width: 600px) { td { background: red; color: blue; } }", true, true],
  ];

  for (const [stylesheet, declaresBackground, declaresTextColor] of cases) {
    const prepared = prepareSenderStylesheet(stylesheet, authored);

    assert.equal(prepared.declaresBackground, declaresBackground, stylesheet);
    assert.equal(prepared.declaresTextColor, declaresTextColor, stylesheet);
    assert.equal(prepared.css, stylesheet);
  }
});

test("sender stylesheets map document selectors without touching lookalikes", () => {
  const { css } = prepareSenderStylesheet(
    `
      html > body, HTML BODY.x { margin: 0; }
      :root .y, :not(body) b { padding: 0; }
      tbody td, .body, #body, [class~="body"] a, a[href*="html"] { margin: 0; }
      @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    `,
    authored,
  );

  assert.match(
    css,
    /div:where\(\.invook-email-root\) > div:where\(\[data-invook-body\]\), div:where\(\.invook-email-root\) div:where\(\[data-invook-body\]\)\.x \{ margin: 0; \}/,
  );
  assert.match(
    css,
    /\.invook-email-root \.y, :not\(div:where\(\[data-invook-body\]\)\) b \{ padding: 0; \}/,
  );
  assert.match(
    css,
    /tbody td, \.body, #body, \[class~="body"\] a, a\[href\*="html"\] \{ margin: 0; \}/,
  );
  assert.match(css, /@keyframes fade \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
});

test("mapped document selectors keep the weight of the type selector they replace", () => {
  // A class rule outranks a `body` rule whatever their order. The stand-in
  // must stay a type selector plus a weightless `:where()` to preserve that.
  const { css } = prepareSenderStylesheet(
    ".newsletter { color: black; } body { color: white; } html { margin: 0; }",
    authored,
  );

  assert.equal(
    css,
    ".newsletter { color: black; } div:where([data-invook-body]) { color: white; } div:where(.invook-email-root) { margin: 0; }",
  );
});

test("sender stylesheets keep quoted values and comments as authored", () => {
  const { css } = prepareSenderStylesheet(
    [
      'p::after { content: "-->"; }',
      "q::before { content: '<!--'; }",
      'a::after { content: "(prefers-color-scheme: dark)"; }',
      "/* --> (prefers-color-scheme: dark) */",
    ].join("\n"),
    authored,
  );

  // The serializer writes the `<` of `<!--` as its CSS escape, which is the
  // same string value and cannot be read as markup.
  assert.equal(
    css,
    [
      'p::after { content: "-->"; }',
      "q::before { content: '\\3c !--'; }",
      'a::after { content: "(prefers-color-scheme: dark)"; }',
      "/* --> (prefers-color-scheme: dark) */",
    ].join("\n"),
  );
});

test("sender stylesheets cannot choose the canvas color scheme", () => {
  const { css } = prepareSenderStylesheet(
    `
      :root { color-scheme: light dark; supported-color-schemes: light dark; }
      @media (prefers-color-scheme: dark) { .card { color: #fff; } }
      @media screen and (PREFERS-COLOR-SCHEME : light), print { .card { color: #000; } }
    `,
    authored,
  );

  assert.doesNotMatch(css, /color-scheme\s*:/i);
  assert.match(css, /supported-color-schemes: light dark;/);
  assert.match(css, /@media \(max-width: 0\) \{ \.card \{ color: #fff; \} \}/);
  assert.match(
    css,
    /@media screen and \(min-width: 0\), print \{ \.card \{ color: #000; \} \}/,
  );
});

test("sender stylesheets wrapped in HTML comment delimiters are prepared", () => {
  const prepared = prepareSenderStylesheet(
    "<!--\n p.MsoNormal { margin: 0in; }\n a:link { color: #0563C1; }\n-->",
    adapted,
  );

  assert.equal(prepared.declaresBackground, false);
  assert.equal(prepared.declaresTextColor, true);
  assert.match(prepared.css, new RegExp(`a:link \\{ color: ${escapeRegExp(pairOf("#0563C1"))}; \\}`));
  assert.doesNotMatch(prepared.css, /<!--|-->/);
});

test("unparseable sender stylesheets keep the light canvas they were authored for", () => {
  const stylesheet =
    'p::after { content: "(prefers-color-scheme: dark)"; } } @media (prefers-color-scheme: dark) { p { color: white; }';
  const prepared = prepareSenderStylesheet(stylesheet, adapted);

  assert.equal(prepared.declaresBackground, true);
  assert.equal(
    prepared.css,
    'p::after { content: "(prefers-color-scheme: dark)"; } } @media (max-width: 0) { p { color: white; }',
  );
});

test("sender text colors are paired only when they are a single plain color", () => {
  const cases: Array<[string, string]> = [
    ["color: #333", `color: ${pairOf("#333")}`],
    ["color:RED !important", `color:${pairOf("RED")} !important`],
    ["color: rgb(17, 85, 204)", `color: ${pairOf("rgb(17, 85, 204)")}`],
    ["color: hsl(210 50% 40% / 0.8)", `color: ${pairOf("hsl(210 50% 40% / 0.8)")}`],
    ["color: var(--brand)", `color: ${pairOf("var(--brand)")}`],
    ["color: windowtext", `color: ${pairOf("windowtext")}`],
    ["color: inherit", "color: inherit"],
    ["color: transparent", "color: transparent"],
    ["color: currentColor", "color: currentColor"],
    ["color: red blue", "color: red blue"],
    ["color: red)", "color: red)"],
    ["color: url(https://example.com/a)", "color: url(https://example.com/a)"],
    ['color: var(--brand, "x")', 'color: var(--brand, "x")'],
    ["border-color: #333; background-color: #fff", "border-color: #333; background-color: #fff"],
  ];

  for (const [style, expected] of cases) {
    assert.equal(prepareSenderInlineStyle(style, adapted).css, expected);
    assert.equal(prepareSenderInlineStyle(style, authored).css, style);
  }
});

test("sender inline styles report colors and cannot choose the color scheme", () => {
  assert.deepEqual(
    prepareSenderInlineStyle("font-size: 14px; color: #222; background: #fff", authored),
    {
      css: "font-size: 14px; color: #222; background: #fff",
      declaresBackground: true,
      declaresTextColor: true,
    },
  );
  assert.deepEqual(
    prepareSenderInlineStyle("color-scheme: dark; margin: 0", authored),
    { css: "margin: 0", declaresBackground: false, declaresTextColor: false },
  );
  assert.deepEqual(
    prepareSenderInlineStyle("color: red } p { background: blue", adapted),
    {
      css: "color: red } p { background: blue",
      declaresBackground: false,
      declaresTextColor: false,
    },
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
