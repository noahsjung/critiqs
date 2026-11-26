import {
  type ElementRef,
  PAGE_PROTOCOL,
  type PageDisplay,
  type PageEvent,
  type PageEvents,
  type PageMethod,
  type PagePanelEndpoint,
  type PageParams,
  type PageResult,
  type PageState,
  type RequestOptions,
} from "@critiqs/core";

/** A display with nothing drawn or watched. */
const NO_DISPLAY: PageDisplay = { hidden: false, exposedRight: null, watch: [], pins: [], selected: null, highlight: null, picking: null, picked: null };

/**
 * The panel's view of the page layer: the page's latest state, kept up to
 * date from its events, plus its requests and events. The interface reads
 * the state while rendering and sends what to draw with `display`.
 */
export class PageLink {
  #state: PageState | null;
  #listeners = new Set<() => void>();
  #display: PageDisplay | null = null;
  #sentDisplay = "";
  #stops: (() => void)[] = [];
  #closed = false;
  /** Documents whose page layers another has replaced; their late answers never bring them back. */
  #left = new Set<string>();
  /** Requests waiting on the current document's page layer; a new document cancels them. */
  #waiting = new Set<AbortController>();

  constructor(
    readonly endpoint: PagePanelEndpoint,
    {
      initial = null,
      element = null,
    }: {
      /** The page's state where it is known without asking, as in the same document. */
      initial?: PageState | null;
      /**
       * Turns a handle back into its element, where the panel shares the
       * page's document and window. Only then is the panel drawn over the
       * page, beside the elements it is about.
       */
      element?: ((ref: ElementRef) => Element | null) | null;
    } = {},
  ) {
    this.#state = initial;
    this.element = element;
    this.#stops.push(endpoint.on("state", (state) => this.#receive(state)));
    // A new page layer, such as after the frame or tab loaded another page: start again with it.
    this.#stops.push(endpoint.on("ready", () => void this.connect().catch(() => undefined)));
  }

  readonly element: ((ref: ElementRef) => Element | null) | null;

  /** Whether the panel is drawn over the page itself, sharing its window. */
  get overPage(): boolean {
    return this.element !== null;
  }

  /** Asks the page layer for its state, then sends it what to draw. Resolves once the page has answered. */
  async connect(options?: RequestOptions): Promise<PageState> {
    const { state } = await this.endpoint.request("connect", { protocol: PAGE_PROTOCOL }, options);
    this.#sentDisplay = "";
    this.#receive(state);
    if (this.#display !== null) this.display(this.#display);
    return state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The page's latest state. Throws before `connect` has finished, so the panel renders only once it has. */
  getState = (): PageState => {
    if (this.#state === null) throw new Error("Critiqs: the panel isn't connected to a page layer yet.");
    return this.#state;
  };

  /** Sends what the page layer should draw and watch. The same display again sends nothing. */
  display(display: PageDisplay): void {
    if (display === this.#display && this.#sentDisplay !== "") return;
    this.#display = display;
    const key = JSON.stringify(display);
    if (key === this.#sentDisplay || this.#closed) return;
    this.#sentDisplay = key;
    this.endpoint.request("display", display, { document: this.#state?.document ?? null }).then(
      (state) => this.#receive(state),
      (error) => {
        // Sent again with the next change, or when the page layer reconnects.
        this.#sentDisplay = "";
        if (!this.#closed) console.warn("Critiqs: the page layer didn't take the panel's display", error);
      },
    );
  }

  /**
   * Sends a request to the page layer of the document shown now. If another
   * document's page layer takes over before it answers, such as after the
   * frame loads another page, the request fails as cancelled: its handles and
   * work belonged to the page that went away.
   */
  async request<M extends PageMethod>(method: M, params: PageParams<M>, { signal, timeoutMs }: Omit<RequestOptions, "document"> = {}): Promise<PageResult<M>> {
    const controller = new AbortController();
    const forward = () => controller.abort();
    signal?.addEventListener("abort", forward);
    if (signal?.aborted) controller.abort();
    this.#waiting.add(controller);
    try {
      const document = this.#state?.document ?? null;
      return await this.endpoint.request(method, params, { signal: controller.signal, document, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    } finally {
      this.#waiting.delete(controller);
      signal?.removeEventListener("abort", forward);
    }
  }

  on<E extends PageEvent>(event: E, handler: (data: PageEvents[E]) => void): () => void {
    return this.endpoint.on(event, handler);
  }

  close(): void {
    // Nothing of the panel's stays on the page: no pins, and no Comment mode.
    if (!this.#closed && this.#state !== null) this.endpoint.request("display", NO_DISPLAY).catch(() => undefined);
    this.#closed = true;
    for (const stop of this.#stops) stop();
    this.endpoint.close();
  }

  #receive(state: PageState) {
    // Answers and events can cross; only a newer state of the same document replaces the one shown.
    if (this.#state !== null && state.document === this.#state.document && state.version <= this.#state.version) return;
    if (this.#left.has(state.document)) return;
    if (this.#state !== null && state.document !== this.#state.document) {
      this.#left.add(this.#state.document);
      for (const controller of [...this.#waiting]) controller.abort();
      this.#waiting.clear();
    }
    this.#state = state;
    for (const listener of [...this.#listeners]) listener();
  }
}
