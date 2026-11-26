// The runtime shim, put first in every proxied page's <head> so it runs before
// the prototype's own scripts. The server rewrote every address in the page;
// this covers addresses scripts build while running: fetch, XHR, history,
// element properties and attributes, inserted HTML, and navigations. It
// keeps cookies in memory for this document only and refuses service
// workers. It holds nothing secret: everything it knows is in the page.
//
// Third-party addresses can't be signed in the browser, so they are left as
// they are and the frame's Content-Security-Policy refuses them.

import { REVIEW_FRAME_TAG, type ReviewFrameMessage, type ReviewUnsupported } from "@critiqs/core";

export interface RuntimeMap {
  /** The prototype's origin, served at this frame host's root. */
  primary: string;
  slots: { slot: number; origin: string }[];
  /** The path the server reached through redirects, to show instead of the one asked for. */
  path: string | null;
}

/** Where a script's address should point on this frame host; unchanged when it isn't the prototype's or an approved origin. */
export function runtimeUrl(map: RuntimeMap, raw: string, base: string, here: string): string {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return raw;
  }
  if (url.origin === here || (url.protocol !== "http:" && url.protocol !== "https:")) return raw;
  if (url.origin === map.primary) return `${url.pathname}${url.search}${url.hash}`;
  const slot = map.slots.find((entry) => entry.origin === url.origin);
  if (slot !== undefined) return `/__critiqs/o/${slot.slot}${url.pathname}${url.search}${url.hash}`;
  return raw;
}

/** A cookie jar for one document: `document.cookie` reads and writes it, and nothing reaches the browser's real cookies. */
export function memoryCookies() {
  const jar = new Map<string, string>();
  return {
    get: () => [...jar].map(([name, value]) => (name === "" ? value : `${name}=${value}`)).join("; "),
    set(text: string) {
      const [pair = "", ...attributes] = String(text).split(";");
      const equals = pair.indexOf("=");
      const name = (equals === -1 ? "" : pair.slice(0, equals)).trim();
      const value = (equals === -1 ? pair : pair.slice(equals + 1)).trim();
      const expired = attributes.some((attribute) => {
        const [key = "", raw = ""] = attribute.split("=");
        const field = key.trim().toLowerCase();
        if (field === "max-age") return Number(raw.trim()) <= 0;
        if (field === "expires") return Date.parse(raw.trim()) <= Date.now();
        return false;
      });
      if (expired) jar.delete(name);
      else jar.set(name, value);
    },
  };
}

function install(script: HTMLScriptElement): void {
  const map = JSON.parse(script.dataset.critiqsMap ?? "null") as RuntimeMap | null;
  if (map === null) return;
  const here = location.origin;
  const mapped = (raw: string | URL) => runtimeUrl(map, String(raw), document.baseURI, here);
  const tell = (message: ReviewFrameMessage) => {
    const origins = JSON.parse(document.querySelector<HTMLScriptElement>("script[data-panel-origins]")?.dataset.panelOrigins ?? "[]") as string[];
    for (const origin of origins) {
      try {
        window.parent.postMessage(message, origin);
      } catch {
        // Not a valid origin: skipped.
      }
    }
  };
  const unsupported = (feature: ReviewUnsupported) => tell({ tag: REVIEW_FRAME_TAG, v: 1, kind: "unsupported", feature });

  // Show the path the proxy reached, so the app's router reads where it really is.
  if (map.path !== null) history.replaceState(history.state, "", map.path);

  const nativeFetch = window.fetch.bind(window);
  window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      const next = mapped(input.url);
      return nativeFetch(next === input.url ? input : new Request(next, input), init);
    }
    return nativeFetch(mapped(input), init);
  }, window.fetch);
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    return (open as (...args: unknown[]) => void).call(this, method, mapped(url), ...rest);
  } as typeof open;
  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    history[name] = function (this: History, state: unknown, unused: string, url?: string | URL | null) {
      return original.call(this, state, unused, url == null ? url : mapped(url));
    };
  }
  // No popups: the frame's sandbox refuses them too.
  window.open = () => null;

  // Element properties and attributes that load or link to an address.
  const properties: [{ prototype: object }, string][] = [
    [HTMLAnchorElement, "href"],
    [HTMLAreaElement, "href"],
    [HTMLImageElement, "src"],
    [HTMLScriptElement, "src"],
    [HTMLLinkElement, "href"],
    [HTMLSourceElement, "src"],
    [HTMLMediaElement, "src"],
    [HTMLVideoElement, "poster"],
    [HTMLTrackElement, "src"],
    [HTMLInputElement, "src"],
    [HTMLFormElement, "action"],
  ];
  for (const [type, property] of properties) {
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, property);
    if (descriptor?.set === undefined) continue;
    Object.defineProperty(type.prototype, property, {
      ...descriptor,
      set(this: Element, value: string) {
        descriptor.set!.call(this, mapped(value));
      },
    });
  }
  const URL_ATTRIBUTES = new Set(["src", "href", "action", "formaction", "poster", "background"]);
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    return setAttribute.call(this, name, URL_ATTRIBUTES.has(name.toLowerCase()) ? mapped(value) : value);
  };
  // HTML inserted by scripts: absolute addresses on the prototype's origin are pointed here.
  const fix = (element: Element) => {
    for (const name of URL_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null && /^(?:https?:)?\/\//i.test(value.trim())) {
        const next = mapped(value);
        if (next !== value) setAttribute.call(element, name, next);
      }
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        fix(node);
        for (const inner of node.querySelectorAll("[src],[href],[action],[formaction],[poster]")) fix(inner);
      }
    }
  }).observe(document, { childList: true, subtree: true });

  // Cookies live in this document's memory only: nothing reaches the browser's
  // cookie jar, shared with other review frames under the same domain.
  const cookies = memoryCookies();
  Object.defineProperty(Document.prototype, "cookie", { configurable: true, get: () => cookies.get(), set: (value: string) => cookies.set(value) });
  Object.defineProperty(window, "cookieStore", { configurable: true, value: undefined });

  // Service workers would outlive the page and intercept the frame host.
  if ("serviceWorker" in navigator) {
    const refuse = () => Promise.reject(new DOMException("Service workers don't run in a Critiqs review link.", "SecurityError"));
    Object.defineProperty(navigator.serviceWorker, "register", { configurable: true, value: refuse });
  }

  // Navigations: to the prototype's absolute address, repeated through the frame
  // host; to another site, stopped, and the review page told.
  const navigation = (window as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener("navigate", (event) => {
    const navigate = event as Event & { destination: { url: string }; cancelable: boolean; hashChange: boolean; downloadRequest: string | null };
    let destination: URL;
    try {
      destination = new URL(navigate.destination.url);
    } catch {
      return;
    }
    if (destination.origin === here || !navigate.cancelable) return;
    navigate.preventDefault();
    if (destination.origin === map.primary) location.assign(mapped(destination.href));
    else if (destination.protocol === "http:" || destination.protocol === "https:") tell({ tag: REVIEW_FRAME_TAG, v: 1, kind: "left", url: destination.origin, signIn: false });
  });

  // Forms. The frame can't submit forms (no allow-forms, form-action 'none'),
  // so a search or filter form (GET, no password or file field) is followed as
  // a link; anything else tells the review page it isn't supported here.
  const submit = (form: HTMLFormElement, submitter: HTMLElement | null) => {
    if (form.querySelector('input[type="password" i]') !== null) return unsupported("password");
    const method = ((submitter?.getAttribute("formmethod") ?? form.getAttribute("method")) || "get").toLowerCase();
    if (method !== "get" || form.querySelector('input[type="file" i]') !== null) return unsupported("form");
    const action = new URL((submitter?.getAttribute("formaction") ?? form.getAttribute("action")) || location.href, document.baseURI);
    if (action.origin !== here || action.pathname.startsWith("/__critiqs/")) return unsupported("form");
    const data = new FormData(form, submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : null);
    action.search = new URLSearchParams([...data].filter((entry): entry is [string, string] => typeof entry[1] === "string")).toString();
    location.assign(action.href);
  };
  document.addEventListener(
    "click",
    (event) => {
      const target = (event.target as Element | null)?.closest?.('button:not([type]), button[type="submit" i], input[type="submit" i], input[type="image" i]') as HTMLButtonElement | HTMLInputElement | null;
      const form = target?.form;
      if (target == null || form == null || target.disabled) return;
      event.preventDefault();
      submit(form, target);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      const input = event.target as HTMLInputElement | null;
      if (event.key !== "Enter" || !(input instanceof HTMLInputElement) || input.form === null || ["button", "checkbox", "radio", "submit", "reset", "file"].includes(input.type)) return;
      event.preventDefault();
      submit(input.form, null);
    },
    true,
  );
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
    submit(this, null);
  };
  HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement, submitter?: HTMLElement | null) {
    submit(this, submitter ?? null);
  };
}

if (typeof document !== "undefined" && document.currentScript instanceof HTMLScriptElement) install(document.currentScript);
