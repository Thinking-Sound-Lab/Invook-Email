import assert from "node:assert/strict";
import test from "node:test";

import { buildEmailHtmlPresentation } from "./email-html-presentation";

test("email HTML preserves sender presentation while removing active content", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(`
    <html>
      <head>
        <title>Duplicated subject</title>
        <style>.headline { color: red; background: #ffffff; }</style>
      </head>
      <body>
        <table><tr><td class="headline" style="font-weight: bold">Hello</td></tr></table>
        <a href="https://example.com/path">Read more</a>
        <script>alert("unsafe")</script>
        <form action="https://example.com/collect"><input name="secret"></form>
        <iframe src="https://example.com/embed"></iframe>
        <img src="https://example.com/banner.jpg" onerror="alert('unsafe')">
      </body>
    </html>
  `);

  assert.match(
    content,
    /<style>\.headline \{ color: red; background: #ffffff; \}<\/style>/,
  );
  assert.match(
    content,
    /<table><tr><td class="headline" style="font-weight:bold">Hello<\/td><\/tr><\/table>/,
  );
  assert.match(content, /href="https:\/\/example\.com\/path"/);
  assert.match(
    content,
    /src="https:\/\/example\.com\/banner\.jpg"/,
  );
  assert.doesNotMatch(content, /Duplicated subject/);
  assert.doesNotMatch(content, /<script|<form|<input|<iframe|onerror=/);
  assert.doesNotMatch(content, /alert\("unsafe"\)/);
});

test("email HTML loads remote images while blocking active capabilities", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(
    '<a href="javascript:alert(1)">Unsafe</a><img src="https://example.com/banner.jpg">',
  );

  assert.match(
    content,
    /src="https:\/\/example\.com\/banner\.jpg"/,
  );
  assert.match(content, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(content, /javascript:/);
});

test("email HTML preserves one-pixel and visible remote images", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(
    `
      <img src="https://example.com/tracker.gif" width="1" height="1">
      <img src="https://example.com/banner.jpg" width="600" height="240">
    `,
  );

  assert.match(content, /tracker\.gif/);
  assert.match(content, /banner\.jpg/);
});

test("email HTML preserves self-contained images", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(
    '<p>Hello</p><img src="data:image/png;base64,iVBORw0KGgo=">',
  );

  assert.match(content, /data:image\/png;base64,iVBORw0KGgo=/);
});

test("email HTML preserves remote CSS images without changing data images", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(
    `
      <style class="mail-theme">.hero { background-image: url("https://example.com/hero.png"); }</style>
      <div style="background: url(data:image/png;base64,iVBORw0KGgo=), url('//example.com/tile.png'); content: image-set('https://example.com/retina.png' 2x)"></div>
    `,
  );

  assert.match(content, /https:\/\/example\.com\/hero\.png/);
  assert.match(content, /https:\/\/example\.com\/tile\.png/);
  assert.match(content, /https:\/\/example\.com\/retina\.png/);
  assert.doesNotMatch(content, /url\(["']?\/\//);
  assert.match(content, /<style class="mail-theme">/);
  assert.match(content, /data:image\/png;base64,iVBORw0KGgo=/);
});

test("email HTML rejects credentialed and non-default-port image URLs", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(
    `
      <img src="https://user@example.com/private.png">
      <img src="http://example.com:8080/private.png">
    `,
  );

  assert.doesNotMatch(content, /src="https?:\/\//);
  assert.equal(content.match(/src="data:,"/g)?.length, 2);
});

test("email HTML loads remote images directly without an API capability", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(
    '<img src="https://example.com/banner.png"><div style="background:url(https://example.com/tile.png)"></div>',
  );

  assert.match(content, /src="https:\/\/example\.com\/banner\.png"/);
  assert.match(content, /https:\/\/example\.com\/tile\.png/);
});

test("email HTML preserves sender color rules and legacy color attributes", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(
    `
      <style>
        p { color: #222222; }
        a.sender-link { color: #2867b2; }
        @media (prefers-color-scheme: dark) { p { color: #eeeeee; } }
      </style>
      <table bgcolor="#ffffff"><tr><td><font color="#525151">Hello</font><a class="sender-link" href="https://example.com">Link</a></td></tr></table>
    `,
  );

  assert.match(content, /p \{ color: #222222; \}/);
  assert.match(content, /a\.sender-link \{ color: #2867b2; \}/);
  assert.match(content, /bgcolor="#ffffff"/);
  assert.match(content, /<font color="#525151">Hello<\/font>/);
  assert.doesNotMatch(content, /light-dark\(/);
});

test("email HTML pins sender color scheme queries to the light scheme", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(
    `
      <style>
        @media (prefers-color-scheme: dark) { p { color: #eeeeee; } }
        @media screen and (prefers-color-scheme:light) { p { color: #111111; } }
      </style>
      <table bgcolor="#ffffff"><tr><td><p>Hello</p></td></tr></table>
    `,
  );

  assert.match(content, /@media \(max-width: 0\) \{ p \{ color: #eeeeee; \} \}/);
  assert.match(
    content,
    /@media screen and \(min-width: 0\) \{ p \{ color: #111111; \} \}/,
  );
  assert.doesNotMatch(content, /prefers-color-scheme/);
});

test("email HTML gives mail that paints its own background a light canvas", () => {
  const painted = [
    '<table bgcolor="#f8f9fa"><tr><td>Receipt</td></tr></table>',
    '<p><span style="background-color: rgb(255, 255, 255)">Pasted</span></p>',
    "<style>.card { background: #ffffff; }</style><div class=\"card\">Card</div>",
    '<html><body bgcolor="#FFFFFF"><p>Hello</p></body></html>',
  ];

  for (const bodyHtml of painted) {
    const { sanitizedHtml: content } = buildEmailHtmlPresentation(bodyHtml);

    assert.match(content, /background-color: Canvas;/);
    assert.match(content, /color: CanvasText;/);
    assert.match(content, /color-scheme: light;/);
    assert.match(content, /color: LinkText;/);
    assert.match(content, /:where\(\[data-invook-body\]\) \{\s+margin: 16px;/);
    assert.doesNotMatch(content, /background-color: transparent|var\(--foreground\)/);
  }
});

test("email HTML keeps unpainted mail on the application canvas", () => {
  const unpainted = [
    "<p>Hello</p>",
    '<p style="background: none; background-color: transparent">Hello</p>',
    '<blockquote style="border-left: 1px solid rgb(204, 204, 204)">Quoted</blockquote>',
  ];

  for (const bodyHtml of unpainted) {
    const { sanitizedHtml: content } = buildEmailHtmlPresentation(bodyHtml);

    assert.match(content, /background-color: transparent;/);
    assert.match(content, /color-scheme: inherit;\s+display: flow-root/);
    assert.doesNotMatch(content, /Canvas|LinkText|margin: 16px/);
  }
});

test("email HTML pairs sender text colors with a dark variant on the application canvas", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(
    `
      <style>a:link { color: #0563C1; }</style>
      <p><span style="color:black; border-color: #ccc">Body</span></p>
      <p><font color="222222">Legacy</font></p>
      <a href="https://example.com" style="color: rgb(17, 85, 204)">Link</a>
      <span style="color: transparent">Preheader</span>
    `,
  );

  assert.match(content, /background-color: transparent;/);
  assert.match(
    content,
    /a:link \{ color: light-dark\(#0563C1, oklch\(from #0563C1 max\(l, 0\.87 - 0\.27 \* l\) c h\)\); \}/,
  );
  assert.match(
    content,
    /<span style="color:light-dark\(black, oklch\(from black max\(l, 0\.87 - 0\.27 \* l\) c h\)\);border-color:#ccc">Body<\/span>/,
  );
  assert.match(
    content,
    /<font color="222222" style="color:light-dark\(#222222, oklch\(from #222222 max\(l, 0\.87 - 0\.27 \* l\) c h\)\)">Legacy<\/font>/,
  );
  assert.match(
    content,
    /style="color:light-dark\(rgb\(17, 85, 204\), oklch\(from rgb\(17, 85, 204\) max\(l, 0\.87 - 0\.27 \* l\) c h\)\)"[^>]*>Link<\/a>/,
  );
  assert.match(content, /<span style="color:transparent">Preheader<\/span>/);
  assert.equal(content.match(/light-dark\(/g)?.length, 4);
});

test("email HTML keeps the sender body as the block its rules target", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation(`
    <html>
      <head>
        <style>
          :root { color-scheme: light dark; }
          html, body { margin: 0; }
          body.newsletter > table { background: #eef1f4; }
          tbody td.body { padding: 0; }
        </style>
      </head>
      <body class="newsletter" bgcolor="FFFFFF" text="#000000" style="font-family: Georgia; color-scheme: dark">
        <table><tbody><tr><td class="body" data-invook-body="true">Hello</td></tr></tbody></table>
      </body>
    </html>
  `);

  assert.match(
    content,
    /<div class="newsletter" style="background-color:#FFFFFF;color:#000000;font-family:Georgia" data-invook-body="true">/,
  );
  assert.equal(content.match(/data-invook-body="true"/g)?.length, 1);
  assert.match(content, /\.invook-email-root,\[data-invook-body\] \{ margin: 0; \}/);
  assert.match(
    content,
    /\[data-invook-body\]\.newsletter > table \{ background: #eef1f4; \}/,
  );
  assert.match(content, /tbody td\.body \{ padding: 0; \}/);
  assert.match(content, /\.invook-email-root \{\s*\}/);
  assert.doesNotMatch(content, /color-scheme: (?:light dark|dark)/);
  assert.doesNotMatch(content, /<body|<html/);
});

test("email HTML includes the isolated viewer root without a document wrapper", () => {
  const { sanitizedHtml: content } = buildEmailHtmlPresentation("<p>Hello</p>");

  assert.match(content, /:host \{/);
  assert.match(content, /color-scheme: inherit/);
  assert.match(content, /background-color: transparent/);
  assert.match(content, /color: inherit/);
  assert.match(content, /font-family: inherit/);
  assert.match(
    content,
    /color: color-mix\(in oklch, var\(--foreground\) 58%, var\(--chart-2\) 42%\)/,
  );
  assert.match(content, /text-underline-offset: 0\.14em/);
  assert.doesNotMatch(content, /background-color: #ffffff|color: #202124/);
  assert.match(
    content,
    /<div class="invook-email-root" role="document"><div data-invook-body="true"><p>Hello<\/p><\/div><\/div>$/,
  );
  assert.doesNotMatch(content, /<!doctype|<html|<body|postMessage|ResizeObserver/);
});

test("email HTML marks common quoted reply containers for collapsed display", () => {
  const presentation = buildEmailHtmlPresentation(`
    <p>Current reply</p>
    <div class="gmail_quote gmail_quote_container">
      <div>On Fri, Aug 28, Sender wrote:</div>
      <blockquote type="cite">Earlier message</blockquote>
    </div>
  `);

  assert.equal(presentation.hasQuotedContent, true);
  assert.match(
    presentation.sanitizedHtml,
    /class="gmail_quote gmail_quote_container" data-invook-quoted="true"/,
  );
  assert.match(
    presentation.sanitizedHtml,
    /:host\(:not\(\[data-show-quoted="true"\]\)\)/,
  );
});

test("email HTML leaves ordinary blockquotes visible", () => {
  const presentation = buildEmailHtmlPresentation(
    '<p data-invook-quoted="true">Current reply</p><blockquote>A deliberate quotation</blockquote>',
  );

  assert.equal(presentation.hasQuotedContent, false);
  assert.match(presentation.sanitizedHtml, /<p>Current reply<\/p>/);
  assert.doesNotMatch(
    presentation.sanitizedHtml,
    /<blockquote[^>]*data-invook-quoted/,
  );
});
