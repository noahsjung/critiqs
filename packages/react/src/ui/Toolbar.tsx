import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Rect } from "@critiqs/core";
import { useStoredState } from "../hooks.ts";
import type { Reviewer } from "../session.ts";
import { Avatar, Menu, MenuItem, useMenu } from "./common.tsx";
import { useWindowWidth } from "./sidebar-width.tsx";
import { CollapseIcon, CommentIcon, CursorIcon, GripIcon, LogoIcon, MockupIcon, SidebarIcon } from "./icons.tsx";

export type Mode = "browse" | "comment" | "mockup";

interface ToolbarProps {
  mode: Mode;
  onMode: (mode: Mode) => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  unreadCount: number;
  reviewer: Reviewer | null;
  onSignIn: () => void;
  onSignOut: () => void;
  onRename: () => void;
  /** Opens Your AI, the reviewer's own AI connection; null where the backend has none. */
  onYourAi: (() => void) | null;
  /** Opens the reviewer's organization: its name, members, and invites; null where the backend has none. */
  onOrganization: (() => void) | null;
  /** Opens the organization's plan and billing; null where the backend doesn't take payment. */
  onBilling: (() => void) | null;
  /** Opens email notification choices; absent before a project is set up. */
  onNotifications: (() => void) | null;
  /** Mockup is offered: the backend stores mockups and the project is set up. Signed out, choosing it asks to sign in. */
  mockupAvailable: boolean;
  /** The project is not set up yet: offer setup instead of commenting. */
  needsSetup: boolean;
  onSetup: () => void;
  /** Area the toolbar must not cover, such as the target being commented on. */
  avoid: Rect | null;
  /** The left edge of an open sidebar; the toolbar centers in the page beside it, where it fits. */
  sidebarLeft?: number;
}

const MARGIN = 16;

/**
 * Critiqs's main control, floating at the bottom center like the Vercel
 * Toolbar. Reviewers can drag it sideways or collapse it; it moves to the top
 * when it would cover the target being commented on.
 */
export function Toolbar(props: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useStoredState("critiqs:toolbar-offset", 0);
  const [collapsed, setCollapsed] = useStoredState("critiqs:toolbar-collapsed", false);
  const [dragging, setDragging] = useState<{ startX: number; startOffset: number } | null>(null);
  const [atTop, setAtTop] = useState(false);
  const account = useMenu();

  useEffect(() => {
    if (props.avoid === null || ref.current === null) return setAtTop(false);
    const bar = ref.current.getBoundingClientRect();
    const bottomBar = { top: window.innerHeight - MARGIN - bar.height, bottom: window.innerHeight - MARGIN };
    const overlapsX = props.avoid.x < bar.right && props.avoid.x + props.avoid.width > bar.left;
    const overlapsY = props.avoid.y < bottomBar.bottom && props.avoid.y + props.avoid.height > bottomBar.top - 8;
    setAtTop(overlapsX && overlapsY);
  }, [props.avoid]);

  // Beside an open sidebar, the toolbar keeps to the page left of it, so a wide sidebar never sits under it.
  // Its width is measured after each layout, collapsed or not, so placing it never uses a stale width.
  const [barWidth, setBarWidth] = useState(0);
  // Centered by pixels, so it follows the window as it resizes.
  const windowWidth = useWindowWidth();
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setBarWidth(element.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsed]);
  const area = props.sidebarLeft !== undefined && barWidth > 0 && props.sidebarLeft >= barWidth + 2 * MARGIN ? props.sidebarLeft : windowWidth;
  const clampOffset = (value: number) => {
    const limit = Math.max(0, area / 2 - barWidth / 2 - MARGIN);
    return Math.max(-limit, Math.min(limit, value));
  };

  const style = {
    left: `${area / 2 + clampOffset(offset)}px`,
    transform: "translateX(-50%)",
    ...(atTop ? { top: MARGIN } : { bottom: MARGIN }),
  };

  const dragHandlers = {
    onPointerDown: (event: ReactPointerEvent) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging({ startX: event.clientX, startOffset: offset });
    },
    onPointerMove: (event: ReactPointerEvent) => {
      if (dragging !== null) setOffset(clampOffset(dragging.startOffset + event.clientX - dragging.startX));
    },
    onPointerUp: () => setDragging(null),
  };

  if (collapsed) {
    return (
      <div ref={ref} className="toolbar collapsed" style={style} role="toolbar" aria-label="Critiqs">
        <button type="button" className="icon-btn" title="Show Critiqs toolbar" aria-label="Show Critiqs toolbar" onClick={() => setCollapsed(false)}>
          <LogoIcon />
          {props.unreadCount > 0 && <span className="badge">{props.unreadCount}</span>}
        </button>
      </div>
    );
  }

  // The menu is a sibling: inside the transformed toolbar, its fixed position would be offset.
  /** The side panel follows the mode: the project in Browse mode, its comments in Comment mode. */
  const panelName = props.mode === "browse" ? "Project" : props.mode === "mockup" ? "Mockup" : "Comments";
  const unread = props.unreadCount === 1 ? "1 unread comment" : `${props.unreadCount} unread comments`;
  return (
    <>
      <div ref={ref} className="toolbar" style={style} role="toolbar" aria-label="Critiqs">
        <span className="handle" title="Drag to move" {...dragHandlers}>
          <GripIcon />
        </span>
        {props.needsSetup ? (
          <button type="button" className="setup-btn" onClick={props.onSetup}>
            Set up Critiqs
          </button>
        ) : (
          <>
            <button
              type="button"
              className="icon-btn"
              aria-pressed={props.mode === "browse"}
              title="Browse mode: use the prototype (V)"
              aria-label="Browse mode"
              onClick={() => props.onMode("browse")}
            >
              <CursorIcon />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-pressed={props.mode === "comment"}
              title="Comment mode: select an element to comment on (C)"
              aria-label="Comment mode"
              onClick={() => props.onMode(props.mode === "comment" ? "browse" : "comment")}
            >
              <CommentIcon />
            </button>
            {props.mockupAvailable && (
              <button
                type="button"
                className="icon-btn"
                aria-pressed={props.mode === "mockup"}
                title="Mockup mode: freeze the page and ask Critiqs AI for changes (M)"
                aria-label="Mockup mode"
                onClick={() => props.onMode(props.mode === "mockup" ? "browse" : "mockup")}
              >
                <MockupIcon />
              </button>
            )}
            <span className="divider" />
            <button
              type="button"
              className="icon-btn"
              aria-pressed={props.sidebarOpen}
              title={props.unreadCount > 0 ? `${panelName} (${unread})` : panelName}
              aria-label={props.unreadCount > 0 ? `${panelName}, ${unread}` : panelName}
              onClick={props.onToggleSidebar}
            >
              <SidebarIcon />
              {props.unreadCount > 0 && <span className="badge">{props.unreadCount}</span>}
            </button>
          </>
        )}
        <span className="divider" />
        {props.reviewer === null ? (
          <button type="button" className="sign-in" onClick={props.onSignIn}>
            Sign in
          </button>
        ) : (
          <button
            type="button"
            className="who"
            title={`Signed in as ${props.reviewer.name}`}
            aria-label={`Signed in as ${props.reviewer.name}`}
            aria-haspopup="menu"
            onClick={account.toggle}
          >
            <Avatar name={props.reviewer.name} imageUrl={props.reviewer.pictureUrl} />
          </button>
        )}
        <button type="button" className="icon-btn" title="Collapse toolbar" aria-label="Collapse toolbar" onClick={() => setCollapsed(true)}>
          <CollapseIcon />
        </button>
      </div>
        {account.open && props.reviewer !== null && (
          <Menu anchor={account.anchor!} onClose={account.close} placement={atTop ? "below" : "above"}>
            <div className="identity">
              <div className="name">{props.reviewer.name}</div>
              <div className="email">{props.reviewer.email}</div>
            </div>
            <hr />
            {!props.needsSetup && (
              <MenuItem
                onSelect={() => {
                  account.close();
                  props.onSetup();
                }}
              >
                Project setup
              </MenuItem>
            )}
            <MenuItem
              onSelect={() => {
                account.close();
                props.onRename();
              }}
            >
              Change display name…
            </MenuItem>
            {props.onYourAi !== null && (
              <MenuItem
                onSelect={() => {
                  account.close();
                  props.onYourAi?.();
                }}
              >
                Your AI…
              </MenuItem>
            )}
            {props.onOrganization !== null && (
              <MenuItem
                onSelect={() => {
                  account.close();
                  props.onOrganization?.();
                }}
              >
                Organization…
              </MenuItem>
            )}
            {props.onBilling !== null && (
              <MenuItem
                onSelect={() => {
                  account.close();
                  props.onBilling?.();
                }}
              >
                Plan and billing…
              </MenuItem>
            )}
            {props.onNotifications !== null && (
              <MenuItem
                onSelect={() => {
                  account.close();
                  props.onNotifications?.();
                }}
              >
                Email notifications…
              </MenuItem>
            )}
            <MenuItem
              onSelect={() => {
                account.close();
                props.onSignOut();
              }}
            >
              Sign out
            </MenuItem>
            <hr />
            <div className="shortcuts" aria-label="Keyboard shortcuts">
              <div className="menu-label">Shortcuts</div>
              <dl>
                <dt><kbd>C</kbd></dt>
                <dd>Comment mode</dd>
                <dt><kbd>V</kbd></dt>
                <dd>Browse mode</dd>
                {props.mockupAvailable && (
                  <>
                    <dt><kbd>M</kbd></dt>
                    <dd>Mockup mode</dd>
                    <dt><kbd>O</kbd></dt>
                    <dd>Hold to compare with the live page, in Mockup mode</dd>
                  </>
                )}
                <dt><kbd>Esc</kbd></dt>
                <dd>Close or cancel</dd>
                <dt><kbd>{isApple() ? "⌘" : "Ctrl"}</kbd> <kbd>\</kbd></dt>
                <dd>Hide or show Critiqs</dd>
              </dl>
            </div>
          </Menu>
        )}
    </>
  );
}

function isApple(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
