// Tags (F11): explicit tags chosen for a thread, and hashtags written in its
// messages. Both are matched by a key, so `#Wording`, `#wording`, and the
// preset "Wording" are one tag; the first spelling seen is kept for display.

/** Initial project tags (F11). Projects can change them later; see `startingTags` for tags by purpose. */
export const DEFAULT_TAGS: readonly string[] = ["Bug", "UX copy change", "Design change request", "User feedback"];

/** Longest tag, in characters, without the `#`. */
export const MAX_TAG_LENGTH = 50;
/** Most explicit tags one thread can carry. */
export const MAX_THREAD_TAGS = 50;
/** Most different hashtags one message can write. */
export const MAX_MESSAGE_HASHTAGS = 30;
/** Most preset tags a project can have: as many as one thread can carry explicitly. */
export const MAX_PRESET_TAGS = MAX_THREAD_TAGS;
/** Most different hashtags one thread's messages can write. */
export const MAX_THREAD_TEXT_TAGS = 200;
/**
 * Longest tag list a thread's tags can be set to: older clients send back
 * every tag a thread has, explicit and written, and its written tags are left out.
 */
export const MAX_TAG_LIST = MAX_THREAD_TAGS + MAX_THREAD_TEXT_TAGS;

/** One hashtag found in text: its key, its label as written, and where it is. */
export interface Hashtag {
  key: string;
  label: string;
  /** Index of the `#`. */
  start: number;
  /** Index after the tag's last character. */
  end: number;
}

// A hashtag starts at the start of the text, after whitespace, or after
// opening punctuation such as `(` or `“`, so URL fragments (`/page#top`),
// character references (`&#39;`), and words like `C#` are not tags. It starts
// with a letter, so `#123` and `#1` are not tags either, then continues with
// letters, numbers, combining marks, `_`, and `-`.
const BOUNDARY = /[\s\p{Ps}\p{Pi}]/u;
const TAG_START = /\p{L}/u;
const TAG_CHAR = /[\p{L}\p{N}\p{M}_-]/u;

/** Every hashtag in `text`, in order. Repeats are included; see `hashtagLabels` for unique tags. */
export function parseHashtags(text: string): Hashtag[] {
  const found: Hashtag[] = [];
  const chars = Array.from(text);
  // Offsets in UTF-16 code units, matching string indexes.
  let offset = 0;
  const offsets: number[] = [];
  for (const char of chars) {
    offsets.push(offset);
    offset += char.length;
  }
  offsets.push(offset);
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "#") continue;
    if (i > 0 && !BOUNDARY.test(chars[i - 1]!)) continue;
    const first = chars[i + 1];
    if (first === undefined || !TAG_START.test(first)) continue;
    let j = i + 1;
    while (j < chars.length && TAG_CHAR.test(chars[j]!)) j++;
    // Trailing joiners belong to the sentence, as in "#bug-" or "#copy_".
    let last = j;
    while (last > i + 2 && /[_-]/.test(chars[last - 1]!)) last--;
    const length = last - (i + 1);
    // Longer runs are not tags, rather than being cut at an arbitrary point.
    if (length <= MAX_TAG_LENGTH) {
      const label = chars.slice(i + 1, last).join("");
      found.push({ key: tagKey(label), label, start: offsets[i]!, end: offsets[last]! });
    }
    i = j - 1;
  }
  return found;
}

/** The unique hashtags in `text`, by key, each with its first spelling. */
export function hashtagLabels(text: string): string[] {
  const seen = new Map<string, string>();
  for (const tag of parseHashtags(text)) if (!seen.has(tag.key)) seen.set(tag.key, tag.label);
  return [...seen.values()];
}

/**
 * The key two tags share when they are the same tag: compatibility-normalized
 * (NFKC), lowercased, with spaces and underscores read as hyphens. So
 * `#ux_copy`, `#UX-copy`, and a preset "UX copy" match. Words are never split
 * or joined, so `#UXCopy` stays a different tag from `#ux-copy`.
 */
export function tagKey(label: string): string {
  return label
    .replace(/^#/, "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-");
}

/**
 * An explicit tag as a reviewer may set it: a preset such as "UX copy change",
 * or a free tag. Returns the cleaned label, or null when it isn't a usable tag.
 */
export function cleanTagLabel(label: string): string | null {
  const cleaned = label.replace(/^#/, "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (cleaned === "" || Array.from(cleaned).length > MAX_TAG_LENGTH) return null;
  // Control and formatting characters would make tags look alike but differ.
  if (/[\p{Cc}\p{Cf}#]/u.test(cleaned)) return null;
  return cleaned;
}

/**
 * A preset tag as a project's owner may set it: an explicit tag's rules
 * (1 to 50 characters, no control characters or `#`), and also one that
 * reviewers can write as a hashtag, because `#` suggestions insert presets as
 * hashtags, with spaces as hyphens. So it starts with a letter and holds
 * letters, numbers, spaces, `-`, and `_`. Returns the cleaned label, or null.
 */
export function cleanPresetTag(label: string): string | null {
  const cleaned = cleanTagLabel(label);
  if (cleaned === null) return null;
  const written = `#${cleaned.replace(/\s+/g, "-")}`;
  const [tag, ...more] = parseHashtags(written);
  return tag !== undefined && more.length === 0 && tag.start === 0 && tag.end === written.length ? cleaned : null;
}

/** Tags without repeats by key, keeping each first spelling, in order. */
export function uniqueTags(labels: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const label of labels) {
    const key = tagKey(label);
    if (key !== "" && !seen.has(key)) seen.set(key, label);
  }
  return [...seen.values()];
}

/** Whether `labels` include a tag with the same key as `label`. */
export function hasTag(labels: readonly string[], label: string): boolean {
  const key = tagKey(label);
  return labels.some((candidate) => tagKey(candidate) === key);
}
