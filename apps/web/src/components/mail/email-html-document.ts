import sanitizeHtml from "sanitize-html";
import valueParser from "postcss-value-parser";

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

function parsePixelDimension(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value);
  return match ? Number(match[1]) : null;
}

function getInlinePixelDimension(
  style: string | undefined,
  property: "height" | "width",
): number | null {
  if (!style) return null;
  const declaration = new RegExp(
    `(?:^|;)\\s*${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\s*(?:;|$)`,
    "i",
  ).exec(style);
  return declaration ? Number(declaration[1]) : null;
}

function isTrackingPixel(attributes: Record<string, string>): boolean {
  const width =
    parsePixelDimension(attributes.width) ??
    getInlinePixelDimension(attributes.style, "width");
  const height =
    parsePixelDimension(attributes.height) ??
    getInlinePixelDimension(attributes.style, "height");
  return width !== null && height !== null && width <= 1 && height <= 1;
}

function normalizeRemoteImageUrl(value: string): string | null {
  try {
    const trimmed = value.trim();
    const url = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const defaultPort = url.protocol === "https:" ? "443" : "80";
    if (url.port && url.port !== defaultPort) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function remoteImageProxyPath(
  messageId: string,
  source: string,
  capability: string,
): string {
  const query = new URLSearchParams({ capability, source });
  return `/v1/messages/${encodeURIComponent(messageId)}/remote-image?${query.toString()}`;
}

function unquoteCssUrl(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function rewriteCssRemoteImages(
  css: string,
  messageId: string,
  capability: string | null,
): string {
  const parsed = valueParser(css);
  parsed.walk((node) => {
    if (
      node.type === "function" &&
      ["image-set", "-webkit-image-set"].includes(node.value.toLowerCase())
    ) {
      for (const imageSetNode of node.nodes) {
        if (imageSetNode.type !== "string") continue;
        const source = normalizeRemoteImageUrl(imageSetNode.value);
        if (source && capability) {
          imageSetNode.value = remoteImageProxyPath(
            messageId,
            source,
            capability,
          );
        } else if (source || /^(?:https?:)?\/\//i.test(imageSetNode.value)) {
          imageSetNode.value = "data:,";
        }
      }
      return undefined;
    }
    if (node.type !== "function" || node.value.toLowerCase() !== "url") {
      return undefined;
    }
    const originalSource = unquoteCssUrl(valueParser.stringify(node.nodes));
    const source = normalizeRemoteImageUrl(originalSource);
    if (!source || !capability) {
      if (!/^data:/i.test(originalSource) && !originalSource.startsWith("#")) {
        node.nodes = valueParser('"data:,"').nodes;
      }
      return false;
    }
    node.nodes = valueParser(
      JSON.stringify(remoteImageProxyPath(messageId, source, capability)),
    ).nodes;
    return false;
  });
  return parsed.toString();
}

function sanitizeEmailHtml(
  bodyHtml: string,
  messageId: string,
  capability: string | null,
): string {
  const sanitizedBodyHtml = sanitizeHtml(bodyHtml, {
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
    // sandboxed iframe; remote images load without receiving the app referrer.
    allowVulnerableTags: true,
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    nonTextTags: ["script", "style", "textarea", "option", "xmp", "title"],
    exclusiveFilter: (frame) => {
      if (frame.tag !== "img") return false;
      return isTrackingPixel(frame.attribs);
    },
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: {
          ...attributes,
          rel: "noopener noreferrer",
          target: "_blank",
        },
      }),
      img: (_tagName, attributes) => {
        const originalSource = attributes.src ?? "";
        const source = normalizeRemoteImageUrl(originalSource);
        if (!source) {
          return {
            tagName: "img",
            attribs: /^(?:https?:)?\/\//i.test(originalSource.trim())
              ? { ...attributes, src: "data:," }
              : attributes,
          };
        }
        return {
          tagName: "img",
          attribs: {
            ...attributes,
            src: capability
              ? remoteImageProxyPath(messageId, source, capability)
              : "data:,",
          },
        };
      },
      "*": (tagName, attributes) => ({
        tagName,
        attribs: attributes.style
          ? {
              ...attributes,
              style: rewriteCssRemoteImages(
                attributes.style,
                messageId,
                capability,
              ),
            }
          : attributes,
      }),
    },
  });
  return sanitizedBodyHtml.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_match, attributes: string, stylesheet: string) =>
      `<style${attributes}>${rewriteCssRemoteImages(
        stylesheet,
        messageId,
        capability,
      )}</style>`,
  );
}

function serializeFrameId(frameId: string): string {
  return JSON.stringify(frameId).replaceAll("<", "\\u003c");
}

function buildEmailContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'none'",
    "font-src data:",
    "form-action 'none'",
    "frame-src 'none'",
    "img-src data: http: https:",
    "media-src 'none'",
    "object-src 'none'",
    "script-src 'nonce-invook-email-size'",
    "style-src 'unsafe-inline'",
  ].join("; ");
}

function serializeEmailHtmlDocument(
  bodyHtml: string,
  frameId: string,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${buildEmailContentSecurityPolicy()}">
    <meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: light only; }
      *, *::before, *::after { box-sizing: border-box; }
      html, body { margin: 0; min-width: 0; padding: 0; width: 100%; background: transparent; color: #202124; }
      html { overflow: auto; }
      body { overflow-wrap: anywhere; font-family: "Plus Jakarta Sans", Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5; }
      #invook-email-root { display: flow-root; min-width: 0; width: 100%; background: #fff; }
      img { border: 0; height: auto; max-width: 100%; }
      table { max-width: 100%; }
      pre { max-width: 100%; overflow-wrap: anywhere; white-space: pre-wrap; }
      a { color: #1155cc; }
    </style>
  </head>
  <body>
    <div id="invook-email-root" role="document">${bodyHtml}</div>
    <script nonce="invook-email-size">
      (() => {
        const frameId = ${serializeFrameId(frameId)};
        const reportHeight = () => {
          const root = document.getElementById("invook-email-root");
          if (!root) return;
          const rootBounds = root.getBoundingClientRect();
          const bodyPaddingBottom = Number.parseFloat(
            getComputedStyle(document.body).paddingBottom,
          ) || 0;
          const height = Math.ceil(
            Math.max(root.scrollHeight, rootBounds.height, rootBounds.bottom + scrollY) +
              bodyPaddingBottom,
          );
          parent.postMessage({ type: "invook-email-height", frameId, height }, "*");
        };
        const observer = new ResizeObserver(reportHeight);
        const root = document.getElementById("invook-email-root");
        if (root) observer.observe(root);
        reportHeight();
      })();
    </script>
  </body>
</html>`;
}

export function buildEmailHtmlDocument(
  bodyHtml: string,
  frameId: string,
  remoteImageCapability: string | null = null,
): string {
  return serializeEmailHtmlDocument(
    sanitizeEmailHtml(bodyHtml, frameId, remoteImageCapability),
    frameId,
  );
}
