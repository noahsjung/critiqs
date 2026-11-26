import type { CritiqsProps, HostContext, RestoreRequest } from "../../react/src/host.ts";
import { type CritiqsInstance, mountCritiqs } from "../../react/src/mount.tsx";

/** The tag `critiqs/element` defines. */
export const ELEMENT_TAG = "critiqs-app";

/**
 * <critiqs-app project-id="…" require-project-id></critiqs-app> adds Critiqs
 * to the page while the element is in the document, for pages a server
 * renders (Rails, Django, Flask, Astro) or that have no build at all. It
 * renders nothing in place; Critiqs draws above the page in its own shadow
 * root. Attributes: `project-id`, `backend`, `version`, `require-project-id`.
 * `getContext` and `restoreContext` are functions, so they are set as
 * properties from a script; `setContext(...)` reports the current view.
 */
// A plain class where there is no DOM (server rendering), so importing this module never throws there.
const ElementBase: typeof HTMLElement = typeof HTMLElement === "undefined" ? (class {} as typeof HTMLElement) : HTMLElement;

export class CritiqsElement extends ElementBase {
  static observedAttributes = ["project-id", "backend", "version", "require-project-id"];

  #instance: CritiqsInstance | null = null;
  #getContext: (() => HostContext) | undefined;
  #restoreContext: CritiqsProps["restoreContext"];
  #pushed: HostContext = {};

  get getContext() {
    return this.#getContext;
  }
  set getContext(value: (() => HostContext) | undefined) {
    this.#getContext = value;
    this.#update();
  }

  get restoreContext() {
    return this.#restoreContext;
  }
  set restoreContext(value: ((request: RestoreRequest) => void | boolean | Promise<void | boolean>) | undefined) {
    this.#restoreContext = value;
    this.#update();
  }

  /** Reports the view the reviewer is on; see `CritiqsInstance.setContext`. Kept across reconnects. */
  setContext(context: HostContext) {
    this.#pushed = { ...context };
    this.#instance?.setContext(this.#pushed);
  }

  connectedCallback() {
    this.style.display = "none";
    // A page script may set these before this module defines the element; move them onto the setters.
    for (const name of ["getContext", "restoreContext"] as const) {
      if (!Object.hasOwn(this, name)) continue;
      const value = this[name];
      delete (this as Partial<Record<typeof name, unknown>>)[name];
      (this as Record<typeof name, unknown>)[name] = value;
    }
    if (this.#instance !== null) return;
    this.#instance = mountCritiqs(this.#options());
    if (Object.keys(this.#pushed).length > 0) this.#instance.setContext(this.#pushed);
  }

  disconnectedCallback() {
    this.#instance?.destroy();
    this.#instance = null;
  }

  attributeChangedCallback() {
    this.#update();
  }

  #update() {
    this.#instance?.update(this.#options());
  }

  #options(): CritiqsProps {
    const text = (name: string) => this.getAttribute(name) ?? undefined;
    return {
      projectId: text("project-id"),
      requireProjectId: this.hasAttribute("require-project-id"),
      backend: text("backend"),
      version: text("version"),
      getContext: this.#getContext,
      restoreContext: this.#restoreContext,
    };
  }
}

if (typeof customElements !== "undefined" && customElements.get(ELEMENT_TAG) === undefined) {
  customElements.define(ELEMENT_TAG, CritiqsElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "critiqs-app": CritiqsElement;
  }
}
