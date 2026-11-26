import type { CopyElement } from "./markup.mjs";
import { SetupError, type Fetch } from "./setup.mjs";

export declare class NotSignedInError extends SetupError {}
/** The saved sign-in isn't approved for the backend, so its token wasn't sent there. */
export declare class BackendNotApprovedError extends SetupError {}

interface Services {
  env?: Record<string, string | undefined>;
  fetchFn?: Fetch;
  now?: () => number;
}

/** Where this computer keeps its sign-ins, in format version 2. */
export declare function credentialsFile(env?: Record<string, string | undefined>, platform?: string): string;
/** Where versions before format version 2 kept their sign-ins, beside `file`. */
export declare function legacyCredentialsFile(file: string): string;
export declare function savedSignIn(
  signInUrl: string,
  options?: { env?: Record<string, string | undefined> },
): { reviewer: { name: string | null; email: string | null }; signedInAt: number; endsAt: number | null; bindings: SignInBinding[] } | null;
/**
 * A token to send to `backendUrl` (and to `siteUrl`, where it serves screenshots and page copies),
 * refused unless the saved sign-in was approved for those origins.
 */
export declare function accessTokenFor(signInUrl: string, options: Services & { backendUrl: string; siteUrl?: string }): Promise<string>;
/** Quotes a value for a POSIX shell. */
export declare function shellQuote(value: string): string;

/** A backend a saved sign-in was approved for, and where it serves screenshots and page copies, as origins. */
export interface SignInBinding {
  backend: string;
  site: string;
}

export interface PendingSignIn {
  method: "remote" | "browser";
  url: string;
  userCode: string;
  signInUrl: string;
  backendUrl: string;
  /** The origins this sign-in will be approved for, which the approval page names. */
  binding: SignInBinding;
  /** Whether the approval page names the backend; false only for Critiqs Cloud through an older Critiqs Cloud sign-in service. */
  confirmed: boolean;
  cancel(): void;
  finish(): Promise<{
    reviewer: { name: string | null; email: string | null };
    endsAt: number | null;
    signInUrl: string;
    backendUrl: string;
    /** Everything the saved sign-in is approved for. */
    bindings: SignInBinding[];
  }>;
}
export declare function beginSignIn(
  options?: Services & { backendUrl?: string; method?: "auto" | "remote" | "browser"; sleep?: (ms: number) => Promise<void> },
): Promise<PendingSignIn>;
export declare function signOutComputer(
  options?: Services & { backendUrl?: string },
): Promise<{ reviewer: { name: string | null; email: string | null } | null; found: boolean } | null>;

export declare function threadIdOf(value: unknown): { threadId: string; messageId: string | null };
export declare function parseTime(value: unknown, name: string, now?: number, endOfDay?: boolean): number | null;
export declare function readFilters(
  args: Record<string, unknown>,
  now?: number,
): {
  status: "open" | "resolved" | "all";
  since: number | null;
  until: number | null;
  limit: number;
  author: string | null;
  tag: string | null;
  screen: string | null;
  text: string | null;
};

export interface TargetContext {
  purposeId: string | null;
  recordKey: string | null;
  label: string | null;
  role: string | null;
  tagName: string | null;
  path: string | null;
}
export interface FeedbackContext {
  screen: string;
  viewState: Record<string, string | number | boolean | null>;
  scope: "shared" | "record";
  target: TargetContext;
  page: {
    url: string | null;
    viewport: { width: number; height: number } | null;
    persona: string | null;
    revision: string | null;
    browser: string | null;
    capturedAt: string | null;
    marker: { x: number; y: number; width: number; height: number } | null;
  };
  movedTo: { screen: string; viewState: Record<string, string | number | boolean | null>; scope: "shared" | "record"; target: TargetContext } | null;
}
export interface FeedbackMessage {
  id: string;
  link: string | null;
  authorId: string | null;
  author: string;
  createdAt: string;
  editedAt: string | null;
  revision: string | null;
  body: string;
  /** A coding agent wrote it for its author (critiqs_reply), or Critiqs AI answered in a mockup thread. */
  via?: "agent" | "ai";
  /** Critiqs AI's replies: who asked. */
  askedBy?: string;
  /** Critiqs AI's replies: the mockup version this one saved. */
  mockupVersion?: number;
  /** Present when a message filter ran: whether this message matched it. */
  matches?: boolean;
}
export interface FeedbackThread {
  id: string;
  link: string | null;
  status: "open" | "resolved";
  tags: string[];
  startedBy: { id: string | null; name: string } | null;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  hasScreenshot: boolean;
  context: FeedbackContext;
  messages: FeedbackMessage[];
}
export interface ProjectSummary {
  id: string;
  name: string;
  reviewUrl: string | null;
}

export declare function listComments(
  args: Record<string, unknown>,
  services?: Services,
): Promise<{
  project: ProjectSummary;
  filters: {
    status: "open" | "resolved" | "all";
    author: string | null;
    since: string | null;
    until: string | null;
    tag: string | null;
    screen: string | null;
    text: string | null;
    limit: number;
  };
  total: number;
  returned: number;
  truncated: boolean;
  threads: FeedbackThread[];
}>;

export declare function readThread(
  args: Record<string, unknown>,
  services?: Services,
): Promise<{
  project: ProjectSummary;
  thread: Omit<FeedbackThread, "messages" | "hasScreenshot"> & {
    statusChangedBy: string | null;
    statusChangedAt: string | null;
    screenshot: { status: "captured" } | { status: "supplied" | "failed"; failureReason: string };
    movedBy: string | null;
    movedAt: string | null;
    messages: (FeedbackMessage & {
      mine: boolean;
      mentions: { id: string; name: string; as: string }[];
      reactions: { emoji: string; count: number; mine: boolean }[];
      linked?: true;
    })[];
  };
}>;

export declare const MAX_INLINE_IMAGE_BYTES: number;
export declare function readScreenshot(
  args: Record<string, unknown>,
  services?: Services & { cwd?: string },
): Promise<{
  threadId: string;
  kind: string;
  mimeType: string;
  bytes: number;
  file: string | null;
  page: string | null;
  viewport: { width: number; height: number } | null;
  marker: { x: number; y: number; width: number; height: number } | null;
  capturedAt: string | null;
  image: string | null;
}>;

export declare function signInStatus(
  options?: Services & { backendUrl?: string },
): Promise<{ signInUrl: string; backendUrl: string; saved: ReturnType<typeof savedSignIn>; approved: boolean }>;

export declare const MAX_REPLY_LENGTH: number;
export declare function postReply(
  args: Record<string, unknown>,
  services?: Services,
): Promise<{
  project: ProjectSummary;
  threadId: string;
  messageId: string;
  link: string | null;
  body: string;
  revision: string | null;
  mentioned: { id: string; name: string }[];
  via: "agent";
}>;

export interface MockupSource {
  url: string;
  screen: string;
  viewState: Record<string, string | number | boolean | null>;
  revision: string | null;
  persona: string | null;
}
/** A version's author: Critiqs AI, for the person who asked, or a person. */
type VersionAuthor = { author: "Critiqs AI"; byAi: true; askedBy: string } | { author: string; byAi: false };
/** How an element a change names looks in the original copy; null with `addedByChange` when an earlier change added it. */
type Original = { original: CopyElement | null; addedByChange?: true };
/** One change, as `MockupEdit` in critiqs-react's types, with `original` when it names an element. */
export type MockupChange =
  | { kind: "css"; css: string }
  | (Original &
      (
        | { kind: "text"; node: number; text: string }
        | { kind: "attribute"; node: number; name: string; value: string | null }
        | { kind: "insert"; node: number; position: "before" | "after" | "prepend" | "append"; html: string }
        | { kind: "replace"; node: number; html: string }
        | { kind: "remove"; node: number }
      ));

export declare function listMockups(
  args: Record<string, unknown>,
  services?: Services,
): Promise<{
  project: ProjectSummary;
  filters: { screen: string | null; text: string | null; limit: number };
  total: number;
  returned: number;
  truncated: boolean;
  mockups: {
    id: string;
    title: string;
    source: MockupSource;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    versionCount: number;
    threadCount: number;
    copies: { id: string; width: number }[];
  }[];
}>;

export declare function readMockup(
  args: Record<string, unknown>,
  services?: Services & { cwd?: string },
): Promise<{
  project: ProjectSummary;
  mockup: { id: string; title: string; source: MockupSource; createdBy: string; createdAt: string; updatedAt: string; versionCount: number };
  /** Version 0 is the original copies, with no author. */
  version: { number: number; latest: boolean; summary: string; createdAt: string | null; restoredFrom: number | null; threadId: string | null; messageId: string | null } & (
    | VersionAuthor
    | { author: null; byAi: false }
  );
  /** Each page copy, with every change the version makes to it, in order. */
  copies: { id: string; width: number; height: number; capturedAt: string; edits: MockupChange[] }[];
  /** Oldest first. */
  versions: ({ number: number; summary: string; createdAt: string; restoredFrom: number | null } & VersionAuthor)[];
  threads: {
    id: string;
    status: "open" | "resolved";
    createdAt: string;
    lastMessageAt: string;
    messageCount: number;
    /** The copy and element the thread is on; null when it is on the whole mockup. */
    pin: ({ copyId: string; node: number | null } & Partial<Original>) | null;
    messages: FeedbackMessage[];
  }[];
  linkedThreads: {
    id: string;
    link: string | null;
    status: "open" | "resolved";
    screen: string;
    messageCount: number;
    firstMessage: { author: string; body: string; createdAt: string } | null;
  }[];
  saved: { folder: string; copies: string[]; edits: string } | null;
}>;
