// The CSS named colors, which HTML legacy color attributes accept as-is.
const CSS_NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque",
  "black", "blanchedalmond", "blue", "blueviolet", "brown", "burlywood",
  "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk",
  "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray",
  "darkgreen", "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen",
  "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise",
  "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue",
  "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro",
  "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey",
  "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral",
  "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
  "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
  "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen",
  "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue",
  "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace",
  "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
  "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red",
  "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen",
  "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle",
  "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke", "yellow",
  "yellowgreen",
]);

/**
 * Resolves an HTML legacy color attribute (`bgcolor`, `text`, `<font color>`)
 * to the CSS color a browser paints for it, or `null` when the attribute
 * applies no color.
 *
 * Follows the HTML Standard's rules for parsing a legacy color value, which
 * differ from CSS: `333` is `#030303`, not `#333333`. Reading these values as
 * CSS would paint a color the sender never saw.
 */
export function parseLegacyColor(value: string): string | null {
  if (value === "") return null;
  // Matching is ASCII case-insensitive; Unicode case folding would let
  // lookalike characters match keywords and hex digits.
  const keyword = value
    .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (keyword === "transparent") return null;
  if (CSS_NAMED_COLORS.has(keyword)) return keyword;

  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(keyword);
  if (shortHex) {
    const [, red, green, blue] = shortHex;
    return `#${red}${red}${green}${green}${blue}${blue}`;
  }

  let digits = Array.from(keyword, (character) =>
    (character.codePointAt(0) ?? 0) > 0xffff ? "00" : character,
  )
    .join("")
    .slice(0, 128)
    .replace(/^#/, "")
    .replace(/[^0-9a-f]/g, "0");
  while (digits.length === 0 || digits.length % 3 !== 0) digits += "0";

  let length = digits.length / 3;
  let components = [
    digits.slice(0, length),
    digits.slice(length, length * 2),
    digits.slice(length * 2),
  ];
  if (length > 8) {
    components = components.map((component) => component.slice(-8));
    length = 8;
  }
  while (length > 2 && components.every((component) => component[0] === "0")) {
    components = components.map((component) => component.slice(1));
    length -= 1;
  }

  return `#${components
    .map((component) => component.slice(0, 2).padStart(2, "0"))
    .join("")}`;
}
