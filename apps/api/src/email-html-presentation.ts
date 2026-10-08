import type { EmailHtmlPresentation } from "@invook/contracts";
import sanitizeHtml from "sanitize-html";
import valueParser from "postcss-value-parser";

import {
  EMAIL_BODY_ATTRIBUTE,
  EMAIL_ROOT_CLASS,
  parseLegacyColor,
  prepareSenderInlineStyle,
  prepareSenderStylesheet,
  type SenderCssOptions,
} from "./email-sender-css";

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

function rewriteCssRemoteImages(css: string): string {
  const parsed = valueParser(css);
  parsed.walk((node) => {
    if (
      node.type === "function" &&
      ["image-set", "-webkit-image-set"].includes(node.value.toLowerCase())
    ) {
      for (const imageSetNode of node.nodes) {
        if (imageSetNode.type !== "string") continue;
        const source = normalizeRemoteImageUrl(imageSetNode.value);
        if (source) {
          imageSetNode.value = source;
        } else if (/^(?:https?:)?\/\//i.test(imageSetNode.value)) {
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
    if (!source) {
      if (!/^data:/i.test(originalSource) && !originalSource.startsWith("#")) {
        node.nodes = valueParser('"data:,"').nodes;
      }
      return false;
    }
    node.nodes = valueParser(JSON.stringify(source)).nodes;
    return false;
  });
  return parsed.toString();
}

const QUOTED_CONTAINER_CLASS =
  /(?:^|\s)(?:gmail_quote|gmail_extra|yahoo_quoted|protonmail_quote|moz-cite-prefix|moz-forward-container)(?:\s|$)/i;
const QUOTED_CONTAINER_IDS = new Set([
  "divrplyfwdmsg",
  "replyforwardmessage",
]);

interface PreparedEmailElement {
  tagName: string;
  attributes: Record<string, string>;
  declaresBackground: boolean;
  declaresTextColor: boolean;
}

function prepareEmailElement(
  sourceTagName: string,
  sourceAttributes: Record<string, string>,
  options: SenderCssOptions,
): PreparedEmailElement {
  const attributes = { ...sourceAttributes };
  delete attributes["data-invook-quoted"];
  delete attributes[EMAIL_BODY_ATTRIBUTE];

  const isBodyElement = sourceTagName === "body";
  const isFontElement = sourceTagName === "font";
  let declaresBackground = Boolean(attributes.bgcolor?.trim());
  let declaresTextColor = isFontElement && Boolean(attributes.color?.trim());

  // Legacy color attributes are presentational hints the browser resolves
  // itself. They become declarations only where the hint would be lost: on
  // the element standing in for the sender's body, and on text colors that
  // need a dark-scheme pair.
  const legacyDeclarations: string[] = [];
  if (isBodyElement) {
    const backgroundColor = parseLegacyColor(attributes.bgcolor ?? "");
    const textColor = parseLegacyColor(attributes.text ?? "");
    if (backgroundColor) {
      legacyDeclarations.push(`background-color:${backgroundColor}`);
    }
    if (textColor) legacyDeclarations.push(`color:${textColor}`);
    delete attributes.bgcolor;
  } else if (isFontElement && options.adaptsTextColors) {
    const textColor = parseLegacyColor(attributes.color ?? "");
    if (textColor) legacyDeclarations.push(`color:${textColor}`);
  }

  const style = [...legacyDeclarations, attributes.style ?? ""]
    .filter(Boolean)
    .join(";");
  if (style) {
    const senderStyle = prepareSenderInlineStyle(
      rewriteCssRemoteImages(style),
      options,
    );
    attributes.style = senderStyle.css;
    declaresBackground ||= senderStyle.declaresBackground;
    declaresTextColor ||= senderStyle.declaresTextColor;
  }

  const isQuotedContainer =
    QUOTED_CONTAINER_CLASS.test(attributes.class ?? "") ||
    QUOTED_CONTAINER_IDS.has((attributes.id ?? "").toLowerCase()) ||
    (sourceTagName === "blockquote" &&
      (attributes.type ?? "").toLowerCase() === "cite");
  if (isQuotedContainer) attributes["data-invook-quoted"] = "true";
  if (isBodyElement) attributes[EMAIL_BODY_ATTRIBUTE] = "true";

  return {
    tagName: isBodyElement ? "div" : sourceTagName,
    attributes,
    declaresBackground,
    declaresTextColor,
  };
}

interface SanitizedEmailHtml {
  html: string;
  hasSenderBackground: boolean;
  hasSenderTextColor: boolean;
}

function sanitizeEmailHtml(
  bodyHtml: string,
  options: SenderCssOptions,
): SanitizedEmailHtml {
  let hasBodyElement = false;
  let hasSenderBackground = false;
  let hasSenderTextColor = false;

  const sanitizedBodyHtml = sanitizeHtml(bodyHtml, {
    allowedTags: [...EMAIL_HTML_TAGS],
    allowedAttributes: {
      "*": [
        "align",
        "aria-label",
        "bgcolor",
        "class",
        "color",
        EMAIL_BODY_ATTRIBUTE,
        "data-invook-quoted",
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
      blockquote: ["type"],
      col: ["span"],
      img: ["alt", "referrerpolicy", "src"],
      ol: ["start", "type"],
      table: ["border", "cellpadding", "cellspacing", "summary"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
      ul: ["type"],
    },
    allowedSchemes: ["data", "http", "https", "mailto", "tel"],
    // Email presentation depends on embedded CSS. The rendered content is
    // isolated from the application stylesheet by a Shadow DOM boundary.
    allowVulnerableTags: true,
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    enforceHtmlBoundary: true,
    nonTextTags: ["script", "style", "textarea", "option", "xmp", "title"],
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: {
          ...attributes,
          rel: "noopener noreferrer nofollow",
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
            referrerpolicy: "no-referrer",
            src: source,
          },
        };
      },
      // The sanitizer applies this after any tag-specific transform, so every
      // element is prepared exactly once. The sender's body survives as a
      // block element; the sanitizer would otherwise drop it along with the
      // margin, background, and text color that `body` rules give a message.
      "*": (tagName, attributes) => {
        const element = prepareEmailElement(tagName, attributes, options);
        hasBodyElement ||= tagName === "body";
        hasSenderBackground ||= element.declaresBackground;
        hasSenderTextColor ||= element.declaresTextColor;
        return { tagName: element.tagName, attribs: element.attributes };
      },
    },
  });
  const html = sanitizedBodyHtml.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_match, attributes: string, stylesheet: string) => {
      const senderStylesheet = prepareSenderStylesheet(
        rewriteCssRemoteImages(stylesheet),
        options,
      );
      hasSenderBackground ||= senderStylesheet.declaresBackground;
      hasSenderTextColor ||= senderStylesheet.declaresTextColor;
      return `<style${attributes}>${senderStylesheet.css}</style>`;
    },
  );

  return {
    html: hasBodyElement
      ? html
      : `<div ${EMAIL_BODY_ATTRIBUTE}="true">${html}</div>`,
    hasSenderBackground,
    hasSenderTextColor,
  };
}

type EmailCanvas = "application" | "light";

// Mail that paints no background of its own takes the application surface and
// foreground. Mail that does was authored against the browser's light canvas,
// so it gets exactly that: system canvas colors under a light color scheme.
// As in a browser, the body keeps a margin unless the sender resets it, which
// is what separates full-bleed layouts from text that needs an inset.
const EMAIL_CANVAS_STYLES: Record<
  EmailCanvas,
  { root: string; link: string; body: string }
> = {
  application: {
    root: `
    background-color: transparent;
    color: inherit;
    color-scheme: inherit;`,
    link: `
    color: color-mix(in oklch, var(--foreground) 58%, var(--chart-2) 42%);`,
    body: "",
  },
  light: {
    root: `
    background-color: Canvas;
    border-radius: var(--radius);
    color: CanvasText;
    color-scheme: light;
    overflow: auto;`,
    link: `
    color: LinkText;`,
    body: `
  :where([${EMAIL_BODY_ATTRIBUTE}]) {
    margin: 16px;
  }`,
  },
};

function buildEmailContentStyles(canvas: EmailCanvas): string {
  const { root, link, body } = EMAIL_CANVAS_STYLES[canvas];
  return `
  :host {
    color: inherit;
    color-scheme: inherit;
    display: block;
    font-family: inherit;
    min-width: 0;
    width: 100%;
  }
  .${EMAIL_ROOT_CLASS} {
    all: initial;${root}
    display: flow-root;
    min-width: 0;
    width: 100%;
    font-family: inherit;
    font-size: 14px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    -webkit-text-size-adjust: 100%;
  }${body}
  .${EMAIL_ROOT_CLASS} img {
    border: 0;
    height: auto;
    max-width: 100%;
  }
  :where(.${EMAIL_ROOT_CLASS}) a {${link}
    text-decoration-color: color-mix(in oklch, currentColor, transparent 42%);
    text-underline-offset: 0.14em;
  }
  .${EMAIL_ROOT_CLASS} table {
    max-width: 100%;
  }
  .${EMAIL_ROOT_CLASS} pre {
    max-width: 100%;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  :host(:not([data-show-quoted="true"]))
    .${EMAIL_ROOT_CLASS} [data-invook-quoted="true"] {
    display: none !important;
  }
`;
}

const EMAIL_CONTENT_STYLES: Record<EmailCanvas, string> = {
  application: buildEmailContentStyles("application"),
  light: buildEmailContentStyles("light"),
};

export function buildEmailHtmlPresentation(
  bodyHtml: string,
): EmailHtmlPresentation {
  const authored = sanitizeEmailHtml(bodyHtml, { adaptsTextColors: false });
  const canvas: EmailCanvas = authored.hasSenderBackground
    ? "light"
    : "application";
  // Sender text colors assume a light canvas. On the application canvas they
  // are re-sanitized with dark-scheme pairs; on the light canvas the sender's
  // CSS is left exactly as authored.
  const sanitized =
    canvas === "application" && authored.hasSenderTextColor
      ? sanitizeEmailHtml(bodyHtml, { adaptsTextColors: true })
      : authored;
  return {
    sanitizedHtml: `<style>${EMAIL_CONTENT_STYLES[canvas]}</style><div class="${EMAIL_ROOT_CLASS}" role="document">${sanitized.html}</div>`,
    hasQuotedContent:
      /<[a-z][^>]*\sdata-invook-quoted="true"(?:\s|>)/i.test(sanitized.html),
  };
}
