import sanitizeHtml from "sanitize-html";

const EMAIL_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src data:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'nonce-invook-email-size'",
  "style-src 'unsafe-inline'",
].join("; ");

const EMAIL_HTML_TAGS = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "s",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
] as const;

function sanitizeEmailHtml(bodyHtml: string): string {
  return sanitizeHtml(bodyHtml, {
    allowedTags: [...EMAIL_HTML_TAGS],
    allowedAttributes: {
      "*": [
        "align",
        "aria-label",
        "bgcolor",
        "class",
        "color",
        "dir",
        "height",
        "id",
        "lang",
        "role",
        "style",
        "title",
        "valign",
        "width",
      ],
      a: ["href", "name", "rel", "target"],
      col: ["span"],
      img: ["alt", "src"],
      ol: ["start", "type"],
      table: ["border", "cellpadding", "cellspacing", "summary"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
      ul: ["type"],
    },
    allowedSchemes: ["data", "http", "https", "mailto", "tel"],
    // Email presentation depends on embedded CSS. It remains confined to a
    // scriptless iframe whose CSP blocks every external resource request.
    allowVulnerableTags: true,
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: {
          ...attributes,
          rel: "noopener noreferrer",
          target: "_blank",
        },
      }),
    },
  });
}

function serializeFrameId(frameId: string): string {
  return JSON.stringify(frameId).replaceAll("<", "\\u003c");
}

export function buildEmailHtmlDocument(bodyHtml: string, frameId: string): string {
  const sanitizedBody = sanitizeEmailHtml(bodyHtml);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${EMAIL_CONTENT_SECURITY_POLICY}">
    <meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light only; }
      html, body { margin: 0; min-width: 0; padding: 0; background: #fff; color: #202124; }
      body { overflow-wrap: anywhere; font-family: "Plus Jakarta Sans", Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5; }
      img { max-width: 100%; }
      table { max-width: 100%; }
      pre { max-width: 100%; overflow-wrap: anywhere; white-space: pre-wrap; }
      a { color: #1155cc; }
    </style>
  </head>
  <body>
    ${sanitizedBody}
    <script nonce="invook-email-size">
      (() => {
        const frameId = ${serializeFrameId(frameId)};
        const reportHeight = () => {
          const height = Math.max(
            document.body?.scrollHeight ?? 0,
            document.documentElement.scrollHeight,
          );
          parent.postMessage({ type: "invook-email-height", frameId, height }, "*");
        };
        const observer = new ResizeObserver(reportHeight);
        observer.observe(document.documentElement);
        if (document.body) observer.observe(document.body);
        reportHeight();
      })();
    </script>
  </body>
</html>`;
}
