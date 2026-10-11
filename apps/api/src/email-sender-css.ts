import postcss, { AtRule, type Root } from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";

// The sender's `html` and `body` do not exist inside the shadow root. Two
// dedicated element types stand in for them, so sender rules written for
// ordinary elements such as `div` never reach either one.
export const EMAIL_ROOT_ELEMENT = "invook-email-root";
export const EMAIL_BODY_ELEMENT = "invook-email-body";

export interface SenderCssOptions {
  adaptsTextColors: boolean;
}

export interface PreparedSenderCss {
  css: string;
  declaresBackground: boolean;
  declaresTextColor: boolean;
}

const BACKGROUND_PROPERTIES = new Set([
  "background",
  "background-color",
  "background-image",
]);
const PAINTLESS_BACKGROUND_VALUES = new Set([
  "inherit",
  "initial",
  "none",
  "revert",
  "transparent",
  "unset",
]);
const NON_ADAPTABLE_COLOR_KEYWORDS = new Set([
  "currentcolor",
  "inherit",
  "initial",
  "revert",
  "revert-layer",
  "transparent",
  "unset",
]);
const COLOR_FUNCTIONS = new Set([
  "color",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "rgb",
  "rgba",
  "var",
]);
const COLOR_WORD = /^(?:#[0-9a-f]{3,8}|[a-z]+)$/i;
const COLOR_FUNCTION = /^[a-z]+\([\w\s.,%/+#()-]*\)$/i;

/**
 * Pairs a sender text color with a dark-scheme variant and lets the canvas
 * `color-scheme` choose between them, so the browser resolves the color
 * without the server knowing the theme.
 *
 * The variant keeps hue and chroma and lifts lightness: black lands on the
 * application's dark foreground lightness (0.87 in OKLCH), darker originals
 * stay more prominent than lighter ones, and already-light colors are kept.
 * A browser without relative color syntax drops the declaration and the text
 * inherits the canvas foreground.
 */
function adaptTextColor(value: string): string {
  const nodes = valueParser(value.trim()).nodes;
  const [node] = nodes;
  if (nodes.length !== 1 || !node) return value;

  const color = valueParser.stringify(node);
  const isAdaptableColor =
    node.type === "word"
      ? COLOR_WORD.test(color) &&
        !NON_ADAPTABLE_COLOR_KEYWORDS.has(color.toLowerCase())
      : node.type === "function" &&
        !node.unclosed &&
        COLOR_FUNCTIONS.has(node.value.toLowerCase()) &&
        COLOR_FUNCTION.test(color);
  if (!isAdaptableColor) return value;

  return `light-dark(${color}, oklch(from ${color} max(l, 0.87 - 0.27 * l) c h))`;
}

// The canvas scheme is chosen per message, not by the operating system, and a
// shadow root cannot scope media queries. Sender scheme queries are therefore
// pinned to light: the scheme every sender color is authored against.
function pinColorSchemeQueriesToLight(mediaQueries: string): string {
  return mediaQueries.replace(
    /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi,
    (_query, scheme: string) =>
      scheme.toLowerCase() === "light" ? "(min-width: 0)" : "(max-width: 0)",
  );
}

const DOCUMENT_ELEMENT_STAND_INS: Record<string, string> = {
  body: EMAIL_BODY_ELEMENT,
  html: EMAIL_ROOT_ELEMENT,
};
const DOCUMENT_PSEUDO_STAND_INS = new Set([
  ":host",
  ":host-context",
  ":root",
]);
const VIEWPORT_POSITION_VALUES = new Set(["fixed", "sticky"]);
const DOCUMENT_SELECTOR_HINT = /html|body|:root|:host/i;
const UNPARSED_HOST_SELECTOR =
  /:host(?:-context)?(?:\((?:[^()]|\([^()]*\))*\))?/gi;
const UNPARSED_VIEWPORT_POSITION = /position\s*:\s*(?:fixed|sticky)\b/gi;

// Selectors that target the sender's document elements are pointed at their
// stand-ins. Each replacement is the same kind of selector as the original (a
// type selector for a type selector, a class for the `:root` / `:host`
// pseudo-class), so its specificity is unchanged and sender rules keep their
// relative priority. `:host` must not reach the shadow host in the light tree:
// `position: fixed` there covers Reply/Send and the rest of the app.
const mapDocumentSelectors = selectorParser((selectors) => {
  selectors.walkTags((tag) => {
    const standIn = DOCUMENT_ELEMENT_STAND_INS[tag.value.toLowerCase()];
    if (standIn) tag.value = standIn;
  });
  selectors.walkPseudos((pseudo) => {
    if (DOCUMENT_PSEUDO_STAND_INS.has(pseudo.value.toLowerCase())) {
      pseudo.replaceWith(
        selectorParser.className({ value: EMAIL_ROOT_ELEMENT }),
      );
    }
  });
});

function neutralizeUnparsedSenderCss(stylesheet: string): string {
  return stylesheet
    .replace(/@media\b[^{}]*/gi, pinColorSchemeQueriesToLight)
    .replace(UNPARSED_HOST_SELECTOR, `.${EMAIL_ROOT_ELEMENT}`)
    .replace(UNPARSED_VIEWPORT_POSITION, "position: static");
}

function prepareSenderDeclarations(
  root: Root,
  { adaptsTextColors }: SenderCssOptions,
): Omit<PreparedSenderCss, "css"> {
  let declaresBackground = false;
  let declaresTextColor = false;

  root.walkDecls((declaration) => {
    const property = declaration.prop.toLowerCase();
    if (property === "color-scheme") {
      // The viewer owns the canvas scheme; a sender override would flip
      // system colors and the paired text colors underneath it.
      declaration.remove();
    } else if (
      property === "position" &&
      VIEWPORT_POSITION_VALUES.has(declaration.value.trim().toLowerCase())
    ) {
      // Fixed and sticky descendants escape the shadow tree unless the host
      // is also a containing block. Drop them so a message cannot overlay
      // thread actions even if host containment is missing.
      declaration.remove();
    } else if (property === "color") {
      declaresTextColor = true;
      if (adaptsTextColors) declaration.value = adaptTextColor(declaration.value);
    } else if (
      BACKGROUND_PROPERTIES.has(property) &&
      !PAINTLESS_BACKGROUND_VALUES.has(declaration.value.trim().toLowerCase())
    ) {
      declaresBackground = true;
    }
  });

  return { declaresBackground, declaresTextColor };
}

// Mail composers wrap embedded CSS in HTML comment delimiters, which CSS
// ignores but the parser rejects. Strings and comments are matched first so a
// delimiter the sender wrote inside one is left alone.
function removeHtmlCommentDelimiters(stylesheet: string): string {
  return stylesheet.replace(
    /("(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|\/\*[\s\S]*?\*\/)|<!--|-->/g,
    (_match, quotedOrComment: string | undefined) => quotedOrComment ?? "",
  );
}

export function prepareSenderStylesheet(
  stylesheet: string,
  options: SenderCssOptions,
): PreparedSenderCss {
  let root: Root;
  try {
    root = postcss.parse(removeHtmlCommentDelimiters(stylesheet));
  } catch {
    // Sender CSS that cannot be parsed cannot be adapted either, so the
    // message keeps the light canvas it was authored for. Its scheme queries
    // are still pinned, by their position after `@media`. Host and viewport
    // position rules are neutralized even in this fallback: a browser may
    // still honor CSS that PostCSS rejected.
    return {
      css: neutralizeUnparsedSenderCss(stylesheet),
      declaresBackground: true,
      declaresTextColor: false,
    };
  }

  root.walkAtRules(/^media$/i, (mediaRule) => {
    mediaRule.params = pinColorSchemeQueriesToLight(mediaRule.params);
  });
  root.walkRules((rule) => {
    const isKeyframeSelector =
      rule.parent instanceof AtRule && /keyframes$/i.test(rule.parent.name);
    if (isKeyframeSelector || !DOCUMENT_SELECTOR_HINT.test(rule.selector)) {
      return;
    }
    try {
      rule.selector = mapDocumentSelectors.processSync(rule.selector);
    } catch {
      // An unparseable selector matches nothing in a browser either.
    }
  });

  const declarations = prepareSenderDeclarations(root, options);
  return { css: root.toString(), ...declarations };
}

export function prepareSenderInlineStyle(
  style: string,
  options: SenderCssOptions,
): PreparedSenderCss {
  const unchanged = {
    css: style,
    declaresBackground: false,
    declaresTextColor: false,
  };
  if (!/color|background|position/i.test(style)) return unchanged;

  let root: Root;
  try {
    root = postcss.parse(style);
  } catch {
    // The sanitizer discards a style attribute it cannot parse. Still
    // neutralize viewport positioning in case a browser accepts the value.
    return {
      ...unchanged,
      css: style.replace(UNPARSED_VIEWPORT_POSITION, "position: static"),
    };
  }

  const declarations = prepareSenderDeclarations(root, options);
  return { css: root.toString(), ...declarations };
}
