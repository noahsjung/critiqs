import { describe, expect, test } from "bun:test";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import { rewriteCss } from "../src/css.ts";
import { decodeHtml, type Injected, rewriteHtml } from "../src/html.ts";
import { assetPath, leavePath, mapSrcset, mapUrl, parseSrcset, routeRequest, type UrlContext } from "../src/urls.ts";

const ctx: UrlContext = {
  primary: "https://proto.example.com",
  slots: [{ slot: 1, origin: "https://api.example.com" }],
  leaseId: "lease-1",
  secret: "a-test-secret-that-is-long-enough-to-pass",
};
const page = new URL("https://proto.example.com/users/42?tab=1");
const frame = (path: string) => new URL(path, "http://v-aaaaaaaaaaaaaaaaaaaaaaaaaa.review.localhost:5120");
/** The script elements a browser would build from `html`, and the runtime script's map attribute. */
class DOMParserLike {
  scripts = 0;
  map = "";
  constructor(html: string) {
    const walk = (node: DefaultTreeAdapterMap["parentNode"]) => {
      for (const child of node.childNodes) {
        if (!("tagName" in child)) continue;
        if (child.tagName === "script") {
          this.scripts++;
          this.map ||= child.attrs.find((attr) => attr.name === "data-critiqs-map")?.value ?? "";
        }
        walk(child);
      }
    };
    walk(parse(html));
  }
}
const injected: Injected = { runtime: "runtime.0123456789abcdef.js", layer: "layer.0123456789abcdef.js", panelOrigins: ["http://web.localhost:5110"], finalPath: null };

describe("urls", () => {
  test("the prototype's own addresses become root paths", () => {
    expect(mapUrl(ctx, "https://proto.example.com/a/b?x=1#h", page, "page")).toBe("/a/b?x=1#h");
    expect(mapUrl(ctx, "../settings", page, "page")).toBe("/settings");
    expect(mapUrl(ctx, "//proto.example.com/x.png", page, "image")).toBe("/x.png");
    expect(mapUrl(ctx, "logo.png", page, "image")).toBe("/users/logo.png");
  });

  test("approved origins map to their slot", () => {
    expect(mapUrl(ctx, "https://api.example.com/v1/me?x=1", page, "image")).toBe("/__critiqs/o/1/v1/me?x=1");
  });

  test("other sites' files become signed asset paths; their pages a signed leave notice", () => {
    const signed = mapUrl(ctx, "https://cdn.example.net/img/logo.png?v=2", page, "image");
    expect(signed).toMatch(/^\/__critiqs\/a\/[A-Za-z0-9_-]{22}\/image\/https\/cdn\.example\.net\/img\/logo\.png\?v=2$/);
    expect(mapUrl(ctx, "https://accounts.google.com/o/oauth2/auth?client_id=x", page, "page")).toMatch(/^\/__critiqs\/leave\?to=https%3A%2F%2Faccounts\.google\.com&s=[A-Za-z0-9_-]{22}$/);
  });

  test("addresses that aren't http(s) or can't be signed stay as they are", () => {
    for (const raw of ["data:image/png;base64,AAAA", "blob:https://proto.example.com/x", "#top", "mailto:a@example.com", "javascript:void 0", "", "tel:123"]) expect(mapUrl(ctx, raw, page, "image")).toBe(raw);
    expect(mapUrl(ctx, "https://cdn.example.net:8443/a.png", page, "image")).toBe("https://cdn.example.net:8443/a.png");
    expect(mapUrl(ctx, "https://user:pass@cdn.example.net/a.png", page, "image")).toBe("https://user:pass@cdn.example.net/a.png");
  });

  test("a signed path routes back to exactly the URL, class and lease it was made for", () => {
    const url = new URL("https://cdn.example.net/img/a%20b.png?v=2&x=%2F");
    const path = assetPath(ctx, "image", url)!;
    expect(routeRequest(ctx, frame(path))).toEqual({ kind: "asset", assetClass: "image", upstream: url });
    // Another lease, another class, an edited path, query or host, or no signature: nothing.
    expect(routeRequest({ ...ctx, leaseId: "lease-2" }, frame(path))).toEqual({ kind: "none" });
    expect(routeRequest(ctx, frame(path.replace("/image/", "/script/")))).toEqual({ kind: "none" });
    expect(routeRequest(ctx, frame(path.replace("a%20b.png", "c.png")))).toEqual({ kind: "none" });
    expect(routeRequest(ctx, frame(path.replace("v=2", "v=3")))).toEqual({ kind: "none" });
    expect(routeRequest(ctx, frame(path.replace("cdn.example.net", "evil.example.net")))).toEqual({ kind: "none" });
    expect(routeRequest(ctx, frame(path.replace(/\/a\/[^/]+\//, "/a/AAAAAAAAAAAAAAAAAAAAAA/")))).toEqual({ kind: "none" });
    expect(routeRequest(ctx, frame("/__critiqs/a/image/https/cdn.example.net/x.png"))).toEqual({ kind: "none" });
  });

  test("the host segment of a signed path can't smuggle a port, credentials or path", () => {
    for (const host of ["cdn.example.net:22", "user@cdn.example.net", "cdn.example.net%2Fx", "127.0.0.1:80"]) {
      expect(routeRequest(ctx, frame(`/__critiqs/a/AAAAAAAAAAAAAAAAAAAAAA/image/https/${host}/x.png`))).toEqual({ kind: "none" });
    }
  });

  test("a leave notice routes only with its signature", () => {
    const path = leavePath(ctx, new URL("https://elsewhere.example.net/deep?q=1"));
    expect(routeRequest(ctx, frame(path))).toEqual({ kind: "leave", to: "https://elsewhere.example.net" });
    expect(routeRequest(ctx, frame(path.replace("elsewhere", "evil")))).toEqual({ kind: "none" });
    expect(routeRequest(ctx, frame("/__critiqs/leave?to=https%3A%2F%2Fevil.example"))).toEqual({ kind: "none" });
    expect(routeRequest(ctx, frame("/__critiqs/leave?to=javascript%3Aalert(1)&s=AAAAAAAAAAAAAAAAAAAAAA"))).toEqual({ kind: "none" });
  });

  test("paths on the frame host never name another host", () => {
    for (const path of ["//evil.example/x", "/\\evil.example/x", "/%2F%2Fevil.example/", "/..//evil.example"]) {
      const route = routeRequest(ctx, frame(path));
      expect(route.kind === "primary" && route.upstream.origin).toBe("https://proto.example.com");
    }
    expect(routeRequest(ctx, frame("/__critiqs/o/2/x"))).toEqual({ kind: "none" });
    expect(routeRequest(ctx, frame("/__critiqs/o/1//evil.example/x"))).toMatchObject({ kind: "slot", upstream: new URL("https://api.example.com//evil.example/x") });
    expect(routeRequest(ctx, frame("/__critiqs/anything"))).toEqual({ kind: "none" });
    expect(routeRequest(ctx, frame("/__critiqs/runtime.0123456789abcdef.js"))).toEqual({ kind: "static", file: "runtime.0123456789abcdef.js" });
  });

  test("srcset", () => {
    expect(parseSrcset("a.png 1x, https://cdn.example.net/b.png 2x,c.png")).toEqual([
      { url: "a.png", descriptor: "1x" },
      { url: "https://cdn.example.net/b.png", descriptor: "2x" },
      { url: "c.png", descriptor: "" },
    ]);
    expect(parseSrcset("data:image/png;base64,AAA= 1x")).toEqual([{ url: "data:image/png;base64,AAA=", descriptor: "1x" }]);
    const mapped = mapSrcset(ctx, "a.png 1x, https://cdn.example.net/b.png 2x", page, "image");
    expect(mapped).toMatch(/^\/users\/a\.png 1x, \/__critiqs\/a\/[^ ]+\/image\/https\/cdn\.example\.net\/b\.png 2x$/);
  });
});

describe("css", () => {
  const sheet = new URL("https://cdn.example.net/css/site.css");

  test("every url() and @import is mapped against the stylesheet's address", () => {
    const out = rewriteCss(
      ctx,
      `@import "theme.css";
@import url(https://proto.example.com/base.css) screen;
@font-face { font-family: X; src: url(../fonts/x.woff2) format("woff2"), url('x.ttf'); }
.hero { background: URL( "https://proto.example.com/hero.png" ) no-repeat, image-set("a.png" 1x, "b.png" 2x); }
.icon { mask: url(icons.svg#check) }`,
      sheet,
    );
    expect(out).toContain('@import "/__critiqs/a/');
    expect(out).toMatch(/@import "\/__critiqs\/a\/[^/]+\/style\/https\/cdn\.example\.net\/css\/theme\.css"/);
    expect(out).toContain('@import url("/base.css") screen;');
    expect(out).toMatch(/src: url\("\/__critiqs\/a\/[^/]+\/font\/https\/cdn\.example\.net\/fonts\/x\.woff2"\) format\("woff2"\), url\("\/__critiqs\/a\/[^/]+\/font\/https\/cdn\.example\.net\/css\/x\.ttf"\)/);
    expect(out).toContain('URL( "/hero.png" )');
    expect(out).toMatch(/image-set\("\/__critiqs\/a\/[^/]+\/image\/https\/cdn\.example\.net\/css\/a\.png" 1x, "\/__critiqs\/a\/[^/]+\/image\/[^"]+b\.png" 2x\)/);
    expect(out).toMatch(/mask: url\("\/__critiqs\/a\/[^/]+\/image\/https\/cdn\.example\.net\/css\/icons\.svg#check"\)/);
  });

  test("comments, strings that aren't URLs, data URLs and escapes are read as a browser reads them", () => {
    const source = `/* url(https://evil.example/x.png) */ .a::before { content: "url(https://evil.example/y.png)"; background: url(data:image/png;base64,AAAA); } .b { background: url(https\\3a //proto.example.com/esc\\29 .png) }`;
    const out = rewriteCss(ctx, source, sheet);
    expect(out).toContain("/* url(https://evil.example/x.png) */");
    expect(out).toContain('content: "url(https://evil.example/y.png)"');
    expect(out).toContain("url(data:image/png;base64,AAAA)");
    expect(out).toContain('url("/esc).png")');
  });

  test("CSS without URLs is returned untouched", () => {
    const source = ".a { color: red }\n/* nothing */";
    expect(rewriteCss(ctx, source, sheet)).toBe(source);
  });
});

describe("html", () => {
  const rewrite = (source: string, url = page, more: Partial<Injected> = {}) => rewriteHtml(ctx, source, url, { ...injected, ...more });

  test("a page without <head> still gets both scripts first in <head>", () => {
    for (const source of ["<!doctype html><h1>No head tag</h1>", "<!doctype html><html><body><h1>Body only</h1></body></html>", "plain text"]) {
      const out = rewrite(source);
      expect(out).toMatch(/^<!DOCTYPE html>|^<html><head><script src="\/__critiqs\/runtime\.0123456789abcdef\.js"/);
      expect(out).toContain('<head><script src="/__critiqs/runtime.0123456789abcdef.js" data-critiqs-map="');
      expect(out).toContain('<script src="/__critiqs/layer.0123456789abcdef.js" defer="" data-panel-origins="[&quot;http://web.localhost:5110&quot;]" data-channel="review-link"></script>');
    }
  });

  test("the map is an escaped attribute, never inline script", () => {
    const out = rewrite("<head><title>x</title></head>", page, { finalPath: '/a"><script>alert(1)</script>' });
    expect(out).toContain("data-critiqs-map=\"{&quot;primary&quot;:&quot;https://proto.example.com&quot;");
    // Read back as a browser would: still only the two scripts, and the text is the attribute's value.
    const reread = new DOMParserLike(out);
    expect(reread.scripts).toBe(2);
    expect(JSON.parse(reread.map).path).toBe('/a"><script>alert(1)</script>');
  });

  test("<base>: the first same-origin one sets the base, then every <base> goes", () => {
    const out = rewrite('<head><link rel="stylesheet" href="early.css"><base href="/app/"><base href="https://evil.example/"></head><body><a href="next">n</a><img src="i.png"></body>');
    expect(out).not.toContain("<base");
    expect(out).toContain('href="/app/next"');
    expect(out).toContain('src="/app/i.png"');
    // A cross-origin base is ignored: addresses stay on the prototype.
    expect(rewrite('<base href="https://evil.example/"><a href="x">x</a>')).toContain('href="/users/x"');
  });

  test("CSP and refresh meta tags, nested frames, srcdoc, ping and download go", () => {
    const out = rewrite(`<head><meta http-equiv="Content-Security-Policy" content="default-src *"><meta http-equiv="refresh" content="0;url=https://evil.example/"></head>
<body><iframe srcdoc="<script>alert(1)</script>" width="300" height="200" class="embed"></iframe><iframe src="https://proto.example.com/inner"></iframe>
<object data="x.swf"></object><embed src="y.swf"><a href="/x" ping="https://track.example/" download="evil.exe">x</a></body>`);
    expect(out).not.toMatch(/Content-Security-Policy|http-equiv="refresh"|<iframe|srcdoc|<object|<embed|ping=|download=/i);
    expect(out).toContain('<div class="embed" data-critiqs-embed="" style="width:300px;height:200px"></div>');
    // A same-origin refresh stays, as a path.
    expect(rewrite('<meta http-equiv="refresh" content="5; url=https://proto.example.com/next">')).toContain('content="5; url=/next"');
  });

  test("links, forms and resources are mapped by kind", () => {
    const out = rewrite(`<head><link rel="stylesheet" href="https://cdn.example.net/s.css" integrity="sha384-x"><link rel="preconnect" href="https://cdn.example.net"><link rel="icon" href="/favicon.ico"><link rel="preload" as="font" href="https://fonts.example.net/f.woff2"><link rel="manifest" href="/m.json"></head>
<body><a href="https://elsewhere.example.net/page">out</a><form action="https://proto.example.com/search"><input name="q"></form>
<script src="https://cdn.example.net/lib.js" integrity="sha384-y"></script><img src="https://cdn.example.net/a.png" srcset="https://cdn.example.net/a2.png 2x">
<picture><source srcset="https://cdn.example.net/p.webp"></picture><video src="https://media.example.net/v.mp4" poster="https://cdn.example.net/p.png"><source src="https://media.example.net/v.webm"></video>
<div style="background:url(https://cdn.example.net/bg.png)"></div><style>.x{background:url(https://proto.example.com/x.png)}</style></body>`);
    expect(out).toMatch(/<link rel="stylesheet" href="\/__critiqs\/a\/[^/]+\/style\/https\/cdn\.example\.net\/s\.css">/);
    expect(out).not.toContain("preconnect");
    expect(out).not.toContain("manifest");
    expect(out).toContain('<link rel="icon" href="/favicon.ico">');
    expect(out).toMatch(/rel="preload" as="font" href="\/__critiqs\/a\/[^/]+\/font\/https\/fonts\.example\.net\/f\.woff2"/);
    expect(out).toMatch(/<a href="\/__critiqs\/leave\?to=https%3A%2F%2Felsewhere\.example\.net&amp;s=[^"]+">/);
    expect(out).toContain('<form action="/search">');
    // Script bytes pass unchanged, so their integrity stays.
    expect(out).toMatch(/<script src="\/__critiqs\/a\/[^/]+\/script\/https\/cdn\.example\.net\/lib\.js" integrity="sha384-y">/);
    expect(out).toMatch(/srcset="\/__critiqs\/a\/[^/]+\/image\/https\/cdn\.example\.net\/a2\.png 2x"/);
    expect(out).toMatch(/<source srcset="\/__critiqs\/a\/[^/]+\/image\//);
    expect(out).toMatch(/<video src="\/__critiqs\/a\/[^/]+\/media\/https\/media\.example\.net\/v\.mp4" poster="\/__critiqs\/a\/[^/]+\/image\//);
    expect(out).toMatch(/<source src="\/__critiqs\/a\/[^/]+\/media\//);
    expect(out).toMatch(/style="background:url\(&quot;\/__critiqs\/a\/[^/]+\/image\//);
    expect(out).toContain('.x{background:url("/x.png")}');
  });

  test("import maps and SVG", () => {
    const out = rewrite(`<script type="importmap">{"imports":{"react":"https://esm.example.net/react","app/":"/app/"},"scopes":{"https://proto.example.com/x/":{"a":"https://api.example.com/a.js"}},"integrity":{"https://esm.example.net/react":"sha384-z"}}</script>
<svg><a href="https://elsewhere.example.net/">s</a><image href="https://cdn.example.net/i.png"/><use href="#local"/><use xlink:href="https://proto.example.com/sprite.svg#icon"/></svg>`);
    const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(out)![1]!);
    expect(map.imports.react).toMatch(/^\/__critiqs\/a\/[^/]+\/script\/https\/esm\.example\.net\/react$/);
    expect(map.imports["app/"]).toBe("/app/");
    expect(map.scopes["/x/"].a).toBe("/__critiqs/o/1/a.js");
    expect(map.integrity).toBeUndefined();
    expect(out).toMatch(/<a href="\/__critiqs\/leave\?to=/);
    expect(out).toMatch(/<image href="\/__critiqs\/a\/[^/]+\/image\//);
    expect(out).toContain('<use href="#local">');
    expect(out).toContain('xlink:href="/sprite.svg#icon"');
  });

  test("template contents are rewritten too", () => {
    expect(rewrite('<template><img src="https://proto.example.com/t.png"><iframe src="x"></iframe></template>')).toMatch(/<template><img src="\/t\.png"><div data-critiqs-embed=""><\/div><\/template>/);
  });

  test("decodeHtml takes UTF-8 only", () => {
    const utf8 = new TextEncoder().encode("<meta charset=utf-8><p>héllo</p>");
    expect(decodeHtml(utf8, null)).toContain("héllo");
    expect(decodeHtml(utf8, "utf-8")).toContain("héllo");
    expect(decodeHtml(utf8, "iso-8859-1")).toBeNull();
    expect(decodeHtml(new TextEncoder().encode('<meta charset="shift_jis"><p>x</p>'), null)).toBeNull();
    expect(decodeHtml(new Uint8Array([0x3c, 0x70, 0x3e, 0xff, 0xfe]), null)).toBeNull();
    expect(decodeHtml(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]), null)).toBeNull();
  });
});
