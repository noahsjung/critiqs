import { MOCKUP_LIMITS, type MockupEdit, parseEdits, type ThreadMockup } from "@critiqs/core";
import { fail } from "./errors.ts";
import type { FileInfo, ThreadRecord } from "./store.ts";

// Mockups' rules, shared by backends that store mockups (Convex so far). See
// docs/technical-direction.md#mockup-mode. A version stores, for each page
// copy, every change from the original copy; a copy without an entry in a
// version has no changes in it.

export const MOCKUP_RULES = {
  /** UTF-8 bytes of one page copy's HTML. */
  snapshotBytes: 10 * 1024 * 1024,
  snapshotsPerMockup: 6,
  titleChars: 120,
  /** Minutes an uploaded page copy waits to be added to a mockup. */
  uploadMinutes: 60,
  /** Bytes of one version's changes for every copy, serialized as JSON; a stored document holds at most 1 MiB. */
  versionBytes: 900_000,
  /** Bytes of changes stored across a mockup's versions, so reading the whole mockup stays within one request. */
  mockupBytes: 8 * 1024 * 1024,
  /** Threads one mockup lists and existing threads it links, at most. */
  threads: 200,
  links: MOCKUP_LIMITS.linkedThreads,
  /** Mockups a project lists, newest first. */
  listed: 100,
  /** Mockups of one screen a project lists besides those, newest first, when asked for that screen. */
  listedForScreen: 300,
} as const;

/** Each copy's changes in one version, by snapshot ID. */
export type VersionEdits = { snapshotId: string; edits: MockupEdit[] }[];

export function mockupTitle(title: string): string {
  const trimmed = title.trim().replace(/\s+/g, " ");
  if (trimmed === "") fail("invalid", "A mockup needs a title.");
  if (trimmed.length > MOCKUP_RULES.titleChars) fail("invalid", `Mockup titles are limited to ${MOCKUP_RULES.titleChars} characters.`);
  return trimmed;
}

/** What a page copy's upload must be: fresh HTML within the size limit. */
export function checkSnapshotFile(file: FileInfo | null, now: number): void {
  if (file === null) fail("invalid", "The uploaded page copy was not found.");
  // As with images, an upload without a declared type is allowed: copies are only ever served as text.
  const type = file.contentType?.split(";")[0]!.trim().toLowerCase();
  if (type !== undefined && type !== "text/html") fail("invalid", "A page copy must be uploaded as text/html.");
  if (file.size > MOCKUP_RULES.snapshotBytes) fail("invalid", "Page copies are limited to 10 MB.");
  if (file.createdAt < now - MOCKUP_RULES.uploadMinutes * 60_000) fail("invalid", "Upload the page copy again.");
}

/** A copy's size and scroll position as the page had them. */
export function checkSnapshotLayout(layout: { width: number; height: number; scrollY: number; viewportHeight: number; capturedAt: number }): void {
  const sizes = [layout.width, layout.height, layout.viewportHeight];
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0 || size > 1_000_000)) fail("invalid", "A page copy needs a positive size.");
  if (!Number.isFinite(layout.scrollY) || layout.scrollY < 0 || !Number.isFinite(layout.capturedAt)) fail("invalid", "A page copy needs its scroll position and time.");
}

/**
 * Existing threads to link to a mockup: its project's feedback threads that
 * aren't deleted, at most `links` together with the `linked` ones it has.
 * Checked before anything is stored, so a refused link leaves no mockup or
 * link behind.
 */
export function checkLinkedThreads(projectId: string, threads: readonly (ThreadRecord | null)[], linked: number): void {
  for (const thread of threads) {
    // Another project's thread is refused before anything about it, such as whether it was deleted, is told.
    if (thread === null || thread.projectId !== projectId) fail("invalid", "Link threads from the mockup's own project.");
    if (thread.status === "deleted") fail("invalid", "A comment to link was deleted.");
    if (thread.mockup !== undefined) fail("invalid", "Only feedback threads can be linked to a mockup.");
  }
  if (linked + threads.length > MOCKUP_RULES.links) fail("invalid", `A mockup links up to ${MOCKUP_RULES.links} threads.`);
}

/** A thread may be about one element of one copy, or about the mockup as a whole. */
export function checkThreadMockup(mockup: ThreadMockup): void {
  if (mockup.node !== null && (!Number.isSafeInteger(mockup.node) || mockup.node < 1)) fail("invalid", "Elements are numbered from 1.");
  if (mockup.node !== null && mockup.snapshotId === null) fail("invalid", "An element belongs to a page copy; name the copy.");
}

/** A version's changes to one copy. */
export function editsFor(version: VersionEdits, snapshotId: string): MockupEdit[] {
  return version.find((entry) => entry.snapshotId === snapshotId)?.edits ?? [];
}

/** A version's changes keyed by snapshot ID, as clients read them. */
export function editsRecord(version: VersionEdits): Record<string, MockupEdit[]> {
  return Object.fromEntries(version.map((entry) => [entry.snapshotId, entry.edits]));
}

export function editBytes(version: VersionEdits): number {
  return new TextEncoder().encode(JSON.stringify(version)).length;
}

/**
 * The next version's changes: each copy's changes so far followed by the new
 * ones. Every copy's list must stay within the limits `parseEdits` checks,
 * and the version within what one stored version holds.
 */
export function appendEdits(head: VersionEdits, delta: VersionEdits): VersionEdits {
  const next = new Map(head.map((entry) => [entry.snapshotId, entry.edits]));
  for (const entry of delta) {
    if (entry.edits.length === 0) continue;
    const combined = parseEdits([...(next.get(entry.snapshotId) ?? []), ...entry.edits]);
    if (combined === null) fail("invalid", "These changes would make the mockup too large or contain a change that isn't allowed.");
    next.set(entry.snapshotId, combined);
  }
  const version = [...next].map(([snapshotId, edits]) => ({ snapshotId, edits }));
  if (editBytes(version) > MOCKUP_RULES.versionBytes) fail("invalid", "These changes would make the mockup too large. Start a new mockup from the page.");
  return version;
}

/** Refuses a version that would take the mockup past its stored-changes budget. */
export function checkMockupRoom(storedBytes: number, version: VersionEdits): number {
  const total = storedBytes + editBytes(version);
  if (total > MOCKUP_RULES.mockupBytes) fail("limit", "This mockup has as many versions as it can hold. Start a new mockup from the page.");
  return total;
}
