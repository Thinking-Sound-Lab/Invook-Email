import postcss, { AtRule, type Root } from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";

export const EMAIL_ROOT_CLASS = "invook-email-root";
export const EMAIL_BODY_ATTRIBUTE = "data-invook-body";

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
  body: `[${EMAIL_BODY_ATTRIBUTE}]`,
  html: `.${EMAIL_ROOT_CLASS}`,
};

// The sender's document elements do not exist inside the shadow root, so
// selectors that target them are pointed at the elements standing in for them.
// Both stand-ins are `div` elements and `:where()` carries no specificity, so
// a mapped selector weighs exactly what the type selector it replaces did and
// the sender's own rules keep their relative priority.
const mapDocumentSelectors = selectorParser((selectors) => {
  selectors.walkTags((tag) => {
    const standIn = DOCUMENT_ELEMENT_STAND_INS[tag.value.toLowerCase()];
    if (!standIn) return;
    tag.value = "div";
    tag.parent?.insertAfter(
      tag,
      selectorParser.pseudo({ value: `:where(${standIn})` }),
    );
  });
  selectors.walkPseudos((pseudo) => {
    if (pseudo.value.toLowerCase() === ":root") {
      pseudo.replaceWith(selectorParser.className({ value: EMAIL_ROOT_CLASS }));
    }
  });
});

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
    // are still pinned, by their position after `@media`.
    return {
      css: stylesheet.replace(/@media\b[^{}]*/gi, pinColorSchemeQueriesToLight),
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
    if (isKeyframeSelector || !/html|body|:root/i.test(rule.selector)) return;
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
  if (!/color|background/i.test(style)) return unchanged;

  let root: Root;
  try {
    root = postcss.parse(style);
  } catch {
    // The sanitizer discards a style attribute it cannot parse.
    return unchanged;
  }

  const declarations = prepareSenderDeclarations(root, options);
  return { css: root.toString(), ...declarations };
}
