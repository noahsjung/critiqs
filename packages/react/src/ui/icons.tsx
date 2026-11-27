// Small inline icons, so Critiqs loads no assets into the host app.
const base = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const CursorIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M3 2.5l9.5 5-4 1.2-1.8 3.8z" /></svg>
);
export const CommentIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M8 13.5c3.3 0 6-2.3 6-5.2S11.3 3 8 3 2 5.4 2 8.3c0 1.3.5 2.4 1.4 3.3L3 14l2.8-1z" /><path d="M8 6v4M6 8h4" /></svg>
);
export const SidebarIcon = () => (
  <svg {...base} aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" /></svg>
);
export const CloseIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
);
export const ChevronRightIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg>
);
export const ChevronDownIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
);
export const BackIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M10 3L5 8l5 5" /></svg>
);
export const FilterIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M2.5 4h11M4.5 8h7M6.5 12h3" /></svg>
);
export const MoreIcon = () => (
  <svg {...base} aria-hidden="true"><circle cx="3.5" cy="8" r=".8" fill="currentColor" /><circle cx="8" cy="8" r=".8" fill="currentColor" /><circle cx="12.5" cy="8" r=".8" fill="currentColor" /></svg>
);
export const CheckIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>
);
export const ResolveIcon = () => (
  <svg {...base} aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M5.5 8.2l1.8 1.8 3.3-3.6" /></svg>
);
export const SelectIcon = () => (
  <svg {...base} aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8l2 2 3-4" /></svg>
);
export const GripIcon = () => (
  <svg width="6" height="14" viewBox="0 0 6 14" fill="currentColor" aria-hidden="true"><circle cx="1.5" cy="2" r="1" /><circle cx="4.5" cy="2" r="1" /><circle cx="1.5" cy="7" r="1" /><circle cx="4.5" cy="7" r="1" /><circle cx="1.5" cy="12" r="1" /><circle cx="4.5" cy="12" r="1" /></svg>
);
export const CollapseIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
);
export const LogoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 15.5c3.9 0 7-2.7 7-6.1S12.9 3.2 9 3.2 2 6 2 9.4c0 1.5.6 2.9 1.6 3.9L3.2 16l3.3-1.1c.8.4 1.6.6 2.5.6z" fill="currentColor" /></svg>
);
export const EmojiIcon = () => (
  <svg {...base} aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M5.8 9.6c.5.7 1.3 1.1 2.2 1.1s1.7-.4 2.2-1.1" /><path d="M6 6.4v.2M10 6.4v.2" /></svg>
);
export const SearchIcon = () => (
  <svg {...base} aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.4 10.4L14 14" /></svg>
);
export const TagsIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M2.5 2.5h5l6 6-5 5-6-6z" /><circle cx="5.5" cy="5.5" r=".8" fill="currentColor" /></svg>
);
export const InfoIcon = () => (
  <svg {...base} aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 4.8v.2" /></svg>
);
export const MockupIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M8.5 2.5h-4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-4" /><path d="M12 2l.7 1.6L14.3 4.3l-1.6.7L12 6.6l-.7-1.6-1.6-.7 1.6-.7z" /><path d="M5.5 10.5l2-2.5 1.5 1.5" /></svg>
);
/** A ticket in a tracker: a stub with a notch on each side. */
export const TicketIcon = ({ size = 16 }: { size?: number }) => (
  <svg {...base} width={size} height={size} aria-hidden="true"><path d="M2.5 4.5h11v2a1.5 1.5 0 0 0 0 3v2h-11v-2a1.5 1.5 0 0 0 0-3z" /><path d="M9.5 5v6" strokeDasharray="1 1.5" /></svg>
);
