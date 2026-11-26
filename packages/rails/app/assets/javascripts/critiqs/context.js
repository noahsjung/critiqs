// critiqs-rails: hands each page's context to Critiqs. critiqs_tag renders
// it as <critiqs-app data-critiqs-context="…">, so no inline script needs a
// CSP nonce. A module runs once per document, and pages change without a
// load: Turbo Drive visits and Back bring a new <critiqs-app>, and a morph
// refresh changes the attribute in place without running scripts. So this
// watches the page and reports each element's context whenever it changes.
const ATTRIBUTE = "data-critiqs-context";
const elements = document.getElementsByTagName("critiqs-app");
const reported = new WeakMap();

function report() {
  for (const element of elements) {
    const context = element.getAttribute(ATTRIBUTE) ?? "{}";
    if ((reported.get(element) ?? "{}") === context) continue;
    reported.set(element, context);
    customElements.whenDefined("critiqs-app").then(() => element.setContext(JSON.parse(context)));
  }
}

report();
new MutationObserver(report).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: [ATTRIBUTE] });
