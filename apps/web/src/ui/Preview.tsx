import { copy } from "../copy.ts";

/**
 * Beside the form on wide screens: a browser window showing the person's own
 * link, as a sketch of a page. Once Critiqs is set up, the team's cursors
 * and comments arrive on it, once. It's a picture of what Critiqs does, so
 * screen readers get one sentence for it, and phones don't show it.
 */
export function Preview({ host, live }: { host: string | null; live: boolean }) {
  const shown = host ?? copy.preview.placeholder;
  const [priya, daniel, mei] = copy.preview.comments;
  return (
    <figure className={live ? "preview live" : "preview"} role="img" aria-label={copy.preview.label(shown)}>
      <div className="window">
        <div className="window-bar" aria-hidden="true">
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
          <span className={host === null ? "url url-none" : "url"}>
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2.5" y="5.5" width="7" height="5" rx="1.2" fill="currentColor" />
              <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            <span className="url-text">{shown}</span>
          </span>
        </div>
        <div className="page-sketch" aria-hidden="true">
          <div className="sk-nav">
            <i className="sk-logo" />
            <i />
            <i />
            <i />
          </div>
          <div className="sk-hero">
            <i className="sk-title" />
            <i className="sk-line" />
            <i className="sk-line short" />
            <i className="sk-button" />
          </div>
          <div className="sk-cards">
            <i />
            <i />
            <i />
          </div>

          <span className="cur priya">
            <Cursor />
            <b>Priya</b>
          </span>
          <span className="cur daniel">
            <Cursor />
            <b>Daniel</b>
          </span>
          <span className="cur mei">
            <Cursor />
            <b>Mei</b>
          </span>
          <span className="pv-pin pin-1">
            <span className="pin-dot priya">P</span>
            <span className="pin-text">{priya}</span>
          </span>
          <span className="pv-pin pin-2">
            <span className="pin-dot daniel">D</span>
            <span className="pin-text">{daniel}</span>
          </span>
          <span className="pv-pin pin-3">
            <span className="pin-dot mei">M</span>
            <span className="pin-text">{mei}</span>
          </span>
          <span className="pv-toolbar">
            <Logo />
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </figure>
  );
}

function Cursor() {
  return (
    <svg viewBox="0 0 18 18">
      <path d="M2 1.5 15.5 7.8 9.3 9.3 7.8 15.5Z" />
    </svg>
  );
}

/** The Critiqs mark, as on the landing page. */
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2a10 10 0 1 1 0 20H4a2 2 0 0 1-2-2v-8A10 10 0 0 1 12 2Z" fill="#0d63f3" />
      <circle cx="12" cy="12" r="3.5" fill="#fff" />
    </svg>
  );
}
