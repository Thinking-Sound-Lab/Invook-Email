import assert from "node:assert/strict";
import test from "node:test";

import { buildEmailHtmlDocument } from "./email-html-document";

test("email HTML preserves sender presentation while removing active content", () => {
  const document = buildEmailHtmlDocument(`
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
  `, "message-1", "signed-capability");

  assert.match(
    document,
    /<style>\.headline \{ color: red; background: #ffffff; \}<\/style>/,
  );
  assert.match(
    document,
    /<table><tr><td class="headline" style="font-weight:bold">Hello<\/td><\/tr><\/table>/,
  );
  assert.match(document, /href="https:\/\/example\.com\/path"/);
  assert.match(
    document,
    /src="\/v1\/messages\/message-1\/remote-image\?capability=signed-capability&amp;source=https%3A%2F%2Fexample\.com%2Fbanner\.jpg"/,
  );
  assert.doesNotMatch(document, /Duplicated subject/);
  assert.equal(document.match(/<script/g)?.length, 1);
  assert.doesNotMatch(document, /<form|<input|<iframe|onerror=/);
  assert.doesNotMatch(document, /alert\("unsafe"\)/);
});

test("email HTML loads remote images while blocking active capabilities", () => {
  const document = buildEmailHtmlDocument(
    '<a href="javascript:alert(1)">Unsafe</a><img src="https://example.com/banner.jpg">',
    "message-2",
    "signed-capability",
  );

  assert.match(document, /default-src 'none'/);
  assert.match(document, /img-src data: http: https:/);
  assert.match(document, /form-action 'none'/);
  assert.match(document, /script-src 'nonce-invook-email-size'/);
  assert.match(document, /<meta name="referrer" content="no-referrer">/);
  assert.match(
    document,
    /src="\/v1\/messages\/message-2\/remote-image\?capability=signed-capability&amp;source=https%3A%2F%2Fexample\.com%2Fbanner\.jpg"/,
  );
  assert.doesNotMatch(document, /src="https:\/\//);
  assert.doesNotMatch(document, /display: none !important/);
  assert.doesNotMatch(document, /javascript:/);
});

test("email HTML serializes the frame identity without creating script markup", () => {
  const document = buildEmailHtmlDocument(
    "<p>Hello</p>",
    '</script><script>alert("unsafe")</script>',
  );

  assert.equal(document.match(/<script/g)?.length, 1);
  assert.doesNotMatch(document, /<script>alert/);
  assert.match(document, /\\u003c\/script>/);
});

test("email HTML removes one-pixel tracking images without removing visible images", () => {
  const document = buildEmailHtmlDocument(
    `
      <img src="https://example.com/tracker.gif" width="1" height="1">
      <img src="https://example.com/banner.jpg" width="600" height="240">
    `,
    "message-3",
    "signed-capability",
  );

  assert.doesNotMatch(document, /tracker\.gif/);
  assert.match(document, /banner\.jpg/);
});

test("email HTML preserves self-contained images", () => {
  const document = buildEmailHtmlDocument(
    '<p>Hello</p><img src="data:image/png;base64,iVBORw0KGgo=">',
    "message-4",
  );

  assert.match(document, /data:image\/png;base64,iVBORw0KGgo=/);
});

test("email HTML proxies remote CSS images without changing data images", () => {
  const document = buildEmailHtmlDocument(
    `
      <style class="mail-theme">.hero { background-image: url("https://example.com/hero.png"); }</style>
      <div style="background: url(data:image/png;base64,iVBORw0KGgo=), url('//example.com/tile.png'); content: image-set('https://example.com/retina.png' 2x)"></div>
    `,
    "message-5",
    "signed-capability",
  );

  assert.doesNotMatch(document, /url\(["']?https?:\/\//);
  assert.doesNotMatch(document, /url\(["']?\/\//);
  assert.match(document, /<style class="mail-theme">/);
  assert.match(document, /source=https%3A%2F%2Fexample\.com%2Fhero\.png/);
  assert.match(document, /source=https%3A%2F%2Fexample\.com%2Ftile\.png/);
  assert.match(document, /source=https%3A%2F%2Fexample\.com%2Fretina\.png/);
  assert.match(document, /data:image\/png;base64,iVBORw0KGgo=/);
});

test("email HTML never falls back to a direct remote image URL", () => {
  const document = buildEmailHtmlDocument(
    `
      <img src="https://user@example.com/private.png">
      <img src="http://example.com:8080/private.png">
    `,
    "message-6",
  );

  assert.doesNotMatch(document, /src="https?:\/\//);
  assert.equal(document.match(/src="data:,"/g)?.length, 2);
});

test("email HTML withholds remote images until a capability is available", () => {
  const document = buildEmailHtmlDocument(
    '<img src="https://example.com/banner.png"><div style="background:url(https://example.com/tile.png)"></div>',
    "message-7",
  );

  assert.doesNotMatch(document, /example\.com/);
  assert.match(document, /src="data:,"/);
  assert.match(document, /background:url\(&quot;data:,&quot;\)/);
});

test("email HTML preserves sender color rules and legacy color attributes", () => {
  const document = buildEmailHtmlDocument(
    `
      <style>
        p { color: #222222; }
        @media (prefers-color-scheme: dark) { p { color: #eeeeee; } }
      </style>
      <table bgcolor="#ffffff"><tr><td><font color="#525151">Hello</font></td></tr></table>
    `,
    "message-8",
  );

  assert.match(document, /p \{ color: #222222; \}/);
  assert.match(document, /@media \(prefers-color-scheme: dark\)/);
  assert.match(document, /bgcolor="#ffffff"/);
  assert.match(document, /color="#525151"/);
});
