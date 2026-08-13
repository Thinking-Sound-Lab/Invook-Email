import assert from "node:assert/strict";
import test from "node:test";

import { buildEmailHtmlDocument } from "./email-html-document";

test("email HTML preserves presentation while removing active content", () => {
  const document = buildEmailHtmlDocument(`
    <html>
      <head><style>.headline { color: red; }</style></head>
      <body>
        <table><tr><td class="headline" style="font-weight: bold">Hello</td></tr></table>
        <a href="https://example.com/path">Read more</a>
        <script>alert("unsafe")</script>
        <form action="https://example.com/collect"><input name="secret"></form>
        <iframe src="https://example.com/embed"></iframe>
        <img src="https://example.com/tracker.gif" onerror="alert('unsafe')">
      </body>
    </html>
  `, "message-1");

  assert.match(document, /<style>\.headline \{ color: red; \}<\/style>/);
  assert.match(document, /<table><tr><td class="headline" style="font-weight:bold">Hello<\/td><\/tr><\/table>/);
  assert.match(document, /href="https:\/\/example\.com\/path"/);
  assert.equal(document.match(/<script/g)?.length, 1);
  assert.doesNotMatch(document, /<form|<input|<iframe|onerror=/);
  assert.doesNotMatch(document, /alert\("unsafe"\)/);
});

test("email HTML document blocks remote resources and navigation capabilities", () => {
  const document = buildEmailHtmlDocument(
    '<a href="javascript:alert(1)">Unsafe</a><img src="https://example.com/pixel.gif">',
    "message-2",
  );

  assert.match(document, /default-src 'none'/);
  assert.match(document, /img-src data:/);
  assert.match(document, /form-action 'none'/);
  assert.match(document, /script-src 'nonce-invook-email-size'/);
  assert.match(document, /<meta name="referrer" content="no-referrer">/);
  assert.doesNotMatch(document, /javascript:/);
});

test("email HTML serializes the frame identity without creating script markup", () => {
  const document = buildEmailHtmlDocument("<p>Hello</p>", '</script><script>alert("unsafe")</script>');

  assert.equal(document.match(/<script/g)?.length, 1);
  assert.doesNotMatch(document, /<script>alert/);
  assert.match(document, /\\u003c\/script>/);
});
