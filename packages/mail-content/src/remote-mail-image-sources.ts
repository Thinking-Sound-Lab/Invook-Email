import { Parser } from "htmlparser2";
import valueParser from "postcss-value-parser";

import { normalizeRemoteMailImageUrl } from "./remote-mail-image";

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

function collectCssImageUrls(css: string, sources: Set<string>): void {
  const parsed = valueParser(css);
  parsed.walk((node) => {
    if (
      node.type === "function" &&
      ["image-set", "-webkit-image-set"].includes(node.value.toLowerCase())
    ) {
      for (const imageSetNode of node.nodes) {
        if (imageSetNode.type !== "string") continue;
        const source = normalizeRemoteMailImageUrl(imageSetNode.value);
        if (source) sources.add(source);
      }
      return undefined;
    }
    if (node.type !== "function" || node.value.toLowerCase() !== "url") {
      return undefined;
    }
    const source = normalizeRemoteMailImageUrl(
      unquoteCssUrl(valueParser.stringify(node.nodes)),
    );
    if (source) sources.add(source);
    return false;
  });
}

export function extractRemoteMailImageUrls(bodyHtml: string): Set<string> {
  const sources = new Set<string>();
  let styleDepth = 0;
  const parser = new Parser(
    {
      onopentag: (name, attributes) => {
        if (name === "style") styleDepth += 1;
        if (attributes.style) collectCssImageUrls(attributes.style, sources);
        if (name !== "img") return;
        const source = normalizeRemoteMailImageUrl(attributes.src ?? "");
        if (source) sources.add(source);
      },
      ontext: (text) => {
        if (styleDepth > 0) collectCssImageUrls(text, sources);
      },
      onclosetag: (name) => {
        if (name === "style") styleDepth = Math.max(0, styleDepth - 1);
      },
    },
    { decodeEntities: true },
  );
  parser.end(bodyHtml);
  return sources;
}
