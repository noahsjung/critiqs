import { string as cssString, tokenize, tokenTypes, url as cssUrl } from "css-tree";
import { type AssetClass, mapUrl, type UrlContext } from "./urls.ts";

// Stylesheet rewriting with a CSS Syntax Level 3 tokenizer (css-tree's), so
// comments, strings, escapes and `url()` are read as a browser reads them,
// never with a regular expression. Every URL a stylesheet loads, relative
// ones included, is resolved against the stylesheet's own address and mapped:
// the prototype's own files to root paths, other sites' to signed asset paths.
// Only the URL tokens are replaced; everything else is kept byte for byte.

const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)(?:$|[?#])/i;

function classFor(url: string, inImport: boolean, inFontFace: boolean, imports: "style" | "import"): AssetClass {
  if (inImport) return imports;
  if (inFontFace || FONT_FILE.test(url)) return "font";
  return "image";
}

/**
 * `source` with every URL it loads mapped, read against `base` (the
 * stylesheet's address, or the page's for inline CSS). `imports` is how the
 * stylesheets it `@import`s are signed: `style` from the prototype's own CSS
 * or a page's link, `import` from another site's stylesheet, and null from an
 * imported one, whose imports are left unmapped for the frame's policy to
 * refuse.
 */
export function rewriteCss(ctx: UrlContext, source: string, base: URL, imports: "style" | "import" | null = "style"): string {
  const tokens: { type: number; start: number; end: number }[] = [];
  tokenize(source, (type, start, end) => tokens.push({ type, start, end }));
  const replacements: { start: number; end: number; text: string }[] = [];
  const functions: string[] = [];
  let depth = 0;
  let inImport = false;
  let fontFaceOpening = false;
  let fontFaceDepth: number | null = null;

  const replace = (start: number, end: number, raw: string, wrap: (mapped: string) => string) => {
    if (inImport && imports === null) return;
    const mapped = mapUrl(ctx, raw, base, classFor(raw, inImport, fontFaceDepth !== null, imports ?? "import"));
    if (mapped !== raw) replacements.push({ start, end, text: wrap(mapped) });
  };
  const nextSignificant = (from: number) => {
    let at = from;
    while (at < tokens.length && (tokens[at]!.type === tokenTypes.WhiteSpace || tokens[at]!.type === tokenTypes.Comment)) at++;
    return at;
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const text = source.slice(token.start, token.end);
    switch (token.type) {
      case tokenTypes.AtKeyword: {
        const name = text.toLowerCase();
        if (name === "@import") inImport = true;
        if (name === "@font-face") fontFaceOpening = true;
        break;
      }
      case tokenTypes.Semicolon:
        inImport = false;
        break;
      case tokenTypes.LeftCurlyBracket:
        depth++;
        inImport = false;
        if (fontFaceOpening) {
          fontFaceDepth = depth;
          fontFaceOpening = false;
        }
        break;
      case tokenTypes.RightCurlyBracket:
        if (fontFaceDepth === depth) fontFaceDepth = null;
        depth = Math.max(0, depth - 1);
        break;
      case tokenTypes.Url:
        replace(token.start, token.end, cssUrl.decode(text), (mapped) => `url(${cssString.encode(mapped)})`);
        break;
      case tokenTypes.Function: {
        const name = text.slice(0, -1).toLowerCase();
        functions.push(name);
        if (name === "url" || name === "src") {
          const at = nextSignificant(index + 1);
          const argument = tokens[at];
          if (argument?.type === tokenTypes.String) {
            replace(argument.start, argument.end, cssString.decode(source.slice(argument.start, argument.end)), (mapped) => cssString.encode(mapped));
            index = at;
          }
        }
        break;
      }
      case tokenTypes.LeftParenthesis:
        functions.push("(");
        break;
      case tokenTypes.RightParenthesis:
        functions.pop();
        break;
      case tokenTypes.String: {
        const inImageSet = functions.at(-1) === "image-set" || functions.at(-1) === "-webkit-image-set";
        // `@import "x.css"` and `image-set("a.png" 1x)` load the string itself.
        if ((inImport && functions.length === 0) || inImageSet) replace(token.start, token.end, cssString.decode(text), (mapped) => cssString.encode(mapped));
        break;
      }
    }
  }

  if (replacements.length === 0) return source;
  let output = "";
  let at = 0;
  for (const { start, end, text } of replacements) {
    output += source.slice(at, start) + text;
    at = end;
  }
  return output + source.slice(at);
}
