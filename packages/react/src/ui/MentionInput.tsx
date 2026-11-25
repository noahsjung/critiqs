import { MAX_MESSAGE_HASHTAGS, type MentionView, type NewMention, type ParticipantInfo, parseHashtags, tagKey, type TagInfo } from "@critiqs/core";
import { type HTMLAttributes, type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTransport } from "../transport.ts";
import { Avatar } from "./common.tsx";
import { EditHistory, readText, selectIn, selectionIn, showsText, showText, type Snapshot } from "./tag-text.ts";

/** Text with the people it mentions. */
export interface MentionText {
  text: string;
  mentions: MentionView[];
}

export const EMPTY_MENTION_TEXT: MentionText = { text: "", mentions: [] };

/**
 * The mentions whose `@Name` still appears in the text, as written when they
 * were mentioned, so deleting a mention's text also removes the mention.
 */
export function mentionsInText(value: MentionText): NewMention[] {
  return value.mentions
    .filter((mention) => value.text.includes(`@${mention.label}`))
    .map((mention) => ({ userId: mention._id, label: mention.label }));
}

/** The `@query` being typed just before the caret, if any. */
export function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1 || caret - at > 40) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/[\n@]/.test(query) || /\s\s/.test(query)) return null;
  return { start: at, query };
}

/** The `#tag` being typed just before the caret, if any; the query may be empty right after `#`. */
export function activeHashtag(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const hash = before.lastIndexOf("#");
  if (hash === -1) return null;
  if (hash > 0 && !/[\s\p{Ps}\p{Pi}]/u.test(before[hash - 1]!)) return null;
  const query = before.slice(hash + 1);
  if (query.length > 50 || (query !== "" && !/^\p{L}[\p{L}\p{N}\p{M}_-]*$/u.test(query))) return null;
  return { start: hash, query };
}

/** A tag as it can be written after `#`: presets with spaces use hyphens, which match by key. */
export function hashtagFor(label: string): string {
  return label.trim().replace(/\s+/g, "-");
}

/** How a tag reads wherever it is shown as a chip: the hashtag that writes it. */
export function tagDisplay(label: string): string {
  return `#${hashtagFor(label.trim().replace(/^#+/, ""))}`;
}

const MAX_TAG_SUGGESTIONS = 8;

type Suggestion = { kind: "person"; person: ParticipantInfo } | { kind: "tag"; tag: TagInfo };

/**
 * A text box where typing `@` suggests people who have commented in the
 * project, and typing `#` suggests the project's tags, most recently used
 * first. Choosing one inserts `@Name` (recording the mention) or `#tag`.
 * Hashtags show as pills inside the text box; the text stays plain, and the
 * server reads hashtags from it when it is posted.
 */
export function MentionInput({
  projectId,
  value,
  onChange,
  onKeyDown,
  placeholder,
  autoFocus,
  className,
  ...rest
}: {
  projectId: string;
  value: MentionText;
  onChange: (value: MentionText) => void;
  placeholder?: string;
  autoFocus?: boolean;
} & Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "children" | "contentEditable" | "dangerouslySetInnerHTML" | "placeholder">) {
  const field = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const listId = useId();
  const typing = activeMention(value.text, caret);
  // A finished mention, such as one just chosen or one already in an edited message, isn't being typed.
  const finished =
    typing !== null &&
    value.mentions.some((mention) => value.text.startsWith(`@${mention.label}`, typing.start) && typing.query.trimEnd() === mention.label);
  const hashtag = activeHashtag(value.text, caret);
  // Whichever trigger is nearer the caret is the one being typed.
  const mention = finished ? null : typing;
  const active = hashtag !== null && (mention === null || hashtag.start > mention.start) ? { ...hashtag, kind: "tag" as const } : mention === null ? null : { ...mention, kind: "person" as const };
  const open = active !== null && dismissed !== active.start;
  const transport = useTransport();
  const suggestions = transport.useParticipants(open && active.kind === "person" ? projectId : null, active?.kind === "person" ? active.query : "");
  const tagState = transport.useTags(open && active.kind === "tag" ? projectId : null);
  const options: Suggestion[] = !open
    ? []
    : active.kind === "person"
      ? (suggestions.status === "ready" ? suggestions.data : []).map((person) => ({ kind: "person", person }))
      : (tagState.status === "ready" ? tagState.data.tags : [])
          .filter((tag) => {
            const query = tagKey(active.query);
            // A tag already written in full isn't suggested again.
            return tag.key.startsWith(query) && !(query !== "" && tag.key === query && active.query === hashtagFor(tag.label));
          })
          .slice(0, MAX_TAG_SUGGESTIONS)
          .map((tag) => ({ kind: "tag", tag }));

  useEffect(() => setHighlighted(0), [active?.query, active?.kind]);

  // The list floats in the viewport, so a window around the text box can't clip it:
  // below the text box when it fits, otherwise above it.
  const list = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const shown = open && options.length > 0;
  useLayoutEffect(() => {
    if (!shown || field.current === null) return setPlace(null);
    // Follow the text box every frame while open: the window around it moves
    // when the page scrolls or resizes, a frame after the event.
    let frame = 0;
    let last = "";
    const measure = () => {
      frame = requestAnimationFrame(measure);
      if (field.current === null) return;
      const rect = field.current.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const wanted = Math.min(220, list.current?.scrollHeight ?? 220);
      const next =
        below >= wanted || below >= above
          ? { left: rect.left, width: rect.width, top: rect.bottom + 4, maxHeight: Math.max(80, Math.min(220, below)) }
          : { left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(80, Math.min(220, above)) };
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setPlace(next);
      }
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  // The box's content is set from script, never rendered by React: the
  // browser edits it directly, and it is redrawn only when its pills no longer
  // match its text. Text it reported, undo, and IME composition are kept here.
  const history = useRef<EditHistory | null>(null);
  history.current ??= new EditHistory({ text: value.text, selection: [value.text.length, value.text.length] });
  const reported = useRef(value.text);
  const composing = useRef(false);
  const focused = () => {
    const root = field.current?.getRootNode() as Document | ShadowRoot | undefined;
    return root !== undefined && root.activeElement === field.current;
  };

  const report = (text: string, selection: [number, number], kind: string | null, mentions = value.mentions) => {
    reported.current = text;
    history.current!.record({ text, selection }, kind);
    setCaret(selection[0]);
    onChange({ text, mentions });
  };

  // Changes made here are drawn at once, before the next key can reach the
  // box, rather than when React next renders.
  const show = (element: HTMLDivElement, text: string, selection: [number, number]) => {
    showText(element, text);
    if (focused()) selectIn(element, selection);
  };

  /** Replaces the selection, or a range of the text, as one step to undo. */
  const replace = (insert: string, range?: [number, number], mentions?: MentionView[]) => {
    const element = field.current;
    if (element === null) return;
    const text = readText(element);
    const [start, end] = range ?? selectionIn(element) ?? [text.length, text.length];
    const position = start + insert.length;
    const next = text.slice(0, start) + insert + text.slice(end);
    show(element, next, [position, position]);
    report(next, [position, position], null, mentions);
  };

  const goTo = (snapshot: Snapshot | null) => {
    const element = field.current;
    if (snapshot === null || element === null) return;
    show(element, snapshot.text, snapshot.selection);
    reported.current = snapshot.text;
    setCaret(snapshot.selection[0]);
    setDismissed(null);
    onChange({ text: snapshot.text, mentions: value.mentions });
  };

  useLayoutEffect(() => {
    const element = field.current;
    if (element === null || composing.current) return;
    if (value.text !== reported.current) {
      // Set from outside, such as a restored or cleared draft: undo starts over.
      reported.current = value.text;
      history.current!.reset({ text: value.text, selection: [value.text.length, value.text.length] });
    }
    if (showsText(element, value.text)) return;
    // Redraw the pills where typing changed them, keeping the caret's place in the text.
    const selection = focused() ? selectionIn(element) : null;
    showText(element, value.text);
    if (selection !== null) {
      const length = value.text.length;
      selectIn(element, [Math.min(selection[0], length), Math.min(selection[1], length)]);
    }
  });

  useEffect(() => {
    const element = field.current;
    if (element === null || !autoFocus) return;
    element.focus();
    const end = readText(element).length;
    selectIn(element, [end, end]);
    setCaret(end);
  }, []);

  const handlers = useRef({ replace, goTo });
  handlers.current = { replace, goTo };
  useEffect(() => {
    const element = field.current;
    if (element === null) return;
    // React's synthetic beforeinput doesn't say what kind of input it is.
    const beforeInput = (event: InputEvent) => {
      if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
        event.preventDefault();
        handlers.current.replace("\n");
      } else if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        handlers.current.goTo(event.inputType === "historyUndo" ? history.current!.undo() : history.current!.redo());
      }
    };
    const selectionChange = () => {
      // A caret moved by an edit not yet reported belongs to that edit.
      if (composing.current || !focused() || readText(element) !== reported.current) return;
      const selection = selectionIn(element);
      if (selection === null) return;
      history.current!.moved(selection);
      setCaret(selection[0]);
    };
    element.addEventListener("beforeinput", beforeInput);
    document.addEventListener("selectionchange", selectionChange);
    return () => {
      element.removeEventListener("beforeinput", beforeInput);
      document.removeEventListener("selectionchange", selectionChange);
    };
  }, []);

  const choose = (option: Suggestion) => {
    if (active === null) return;
    const insert = option.kind === "person" ? `@${option.person.name} ` : `#${hashtagFor(option.tag.label)} `;
    const person = option.kind === "person" ? option.person : null;
    const mentions =
      person === null || value.mentions.some((mention) => mention._id === person._id && mention.label === person.name)
        ? value.mentions
        : [...value.mentions, { _id: person._id, name: person.name, label: person.name }];
    replace(insert, [active.start, caret], mentions);
    setDismissed(active.start);
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys that pick from an input method's own candidates aren't for Critiqs.
    if (event.nativeEvent.isComposing) return;
    if (open && options.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlighted((index) => (index + step + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (!(event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          choose(options[Math.min(highlighted, options.length - 1)]!);
          return;
        }
      }
    }
    if (open && event.key === "Escape") {
      // Closes the suggestions only, not the thread or the composer around them.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(active!.start);
      return;
    }
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === "z" || (key === "y" && event.ctrlKey))) {
      event.preventDefault();
      goTo(key === "y" || event.shiftKey ? history.current!.redo() : history.current!.undo());
      return;
    }
    // Ctrl or Cmd with Enter posts, from the form around the box; it never adds a line.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.preventDefault();
    onKeyDown?.(event);
  };

  const tagCount = new Set(parseHashtags(value.text).map((tag) => tag.key)).size;
  const tooManyTags = tagCount > MAX_MESSAGE_HASHTAGS;

  return (
    <div className="mention-input">
      <div className="tag-editor">
        {value.text === "" && placeholder !== undefined && (
          <div className="tag-placeholder" aria-hidden="true">
            {placeholder}
          </div>
        )}
        <div
          {...rest}
          ref={field}
          className={className === undefined ? "tag-field" : `tag-field ${className}`}
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          role="combobox"
          aria-multiline="true"
          aria-placeholder={placeholder}
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown ? `${listId}-${highlighted}` : undefined}
          onInput={(event) => {
            const element = event.currentTarget;
            const text = readText(element);
            const selection = selectionIn(element) ?? [text.length, text.length];
            if (composing.current) {
              // Undo and pills wait until the composed text is committed.
              reported.current = text;
              setCaret(selection[0]);
              onChange({ text, mentions: value.mentions });
              return;
            }
            setDismissed(null);
            const type = (event.nativeEvent as InputEvent).inputType ?? "";
            report(text, selection, type.startsWith("insertText") ? "insert" : type.startsWith("delete") ? type : null);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            const element = event.currentTarget;
            const text = readText(element);
            setDismissed(null);
            report(text, selectionIn(element) ?? [text.length, text.length], null);
          }}
          onPaste={(event) => {
            // Pasted text arrives as plain text, with its line breaks.
            event.preventDefault();
            replace(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
          }}
          onKeyDown={keyDown}
        />
      </div>
      {tooManyTags && (
        <div className="error tag-limit" role="status">
          A message can use up to {MAX_MESSAGE_HASHTAGS} different hashtags; this one uses {tagCount}. Remove some to post it.
        </div>
      )}
      {shown && (
        <ul
          ref={list}
          className="mention-suggestions"
          role="listbox"
          id={listId}
          aria-label={active!.kind === "person" ? "People to mention" : "Tags"}
          style={place === null ? { visibility: "hidden" } : place}
        >
          {options.map((option, index) => (
            <li
              key={option.kind === "person" ? option.person._id : option.tag.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              onPointerDown={(event) => {
                // Keep focus in the text box.
                event.preventDefault();
                choose(option);
              }}
              onPointerEnter={() => setHighlighted(index)}
            >
              {option.kind === "person" ? (
                <>
                  <Avatar name={option.person.name} imageUrl={option.person.imageUrl} />
                  <span>{option.person.name}</span>
                </>
              ) : (
                <>
                  <span className="tag-chip">{tagDisplay(option.tag.label)}</span>
                  {option.tag.preset && <span className="note">project tag</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A message body with its mentions highlighted, showing each person's current
 * name on hover, and its hashtags as filled tag chips. With `onTag`, a
 * hashtag is a button that filters the sidebar by its tag.
 */
export function MessageBody({ body, mentions, onTag }: { body: string; mentions: MentionView[]; onTag?: (tag: string) => void }) {
  const byText = new Map(mentions.map((mention) => [`@${mention.label}`, mention]));
  const texts = [...byText.keys()].sort((a, b) => b.length - a.length);
  const pattern = texts.length === 0 ? null : new RegExp(`(${texts.map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  const parts = pattern === null ? [body] : body.split(pattern);
  let key = 0;
  return (
    <>
      {parts.map((part) => {
        const mention = byText.get(part);
        if (mention !== undefined) {
          return (
            <span key={key++} className="mention" title={mention.name === mention.label ? undefined : `Now ${mention.name}`}>
              {part}
            </span>
          );
        }
        // Hashtags in the plain text between mentions.
        const pieces: ReactNode[] = [];
        let from = 0;
        for (const tag of parseHashtags(part)) {
          if (tag.start > from) pieces.push(part.slice(from, tag.start));
          const text = part.slice(tag.start, tag.end);
          pieces.push(
            onTag === undefined ? (
              <span key={key++} className="hashtag">
                {text}
              </span>
            ) : (
              <button key={key++} type="button" className="hashtag" title={`Show threads tagged ${text}`} onClick={() => onTag(tag.label)}>
                {text}
              </button>
            ),
          );
          from = tag.end;
        }
        if (from < part.length) pieces.push(part.slice(from));
        return pieces.length === 1 && typeof pieces[0] === "string" ? pieces[0] : <span key={key++}>{pieces}</span>;
      })}
    </>
  );
}
