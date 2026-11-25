# Tags, tag groups, AI search, and shortcuts: plan and status

This plan covers free hashtags, shared tag groups with automatic AI grouping,
natural-language search with cited insights, the two ways a project connects
to AI, the V and hide shortcuts, and message header alignment. Behavior is in
[first-release scope](first-release.md) (F11, F16, Toolbar); the technical
choices are in [technical direction](technical-direction.md#tags-and-tag-groups).
Terms are in the [glossary](glossary.md).

Status words: **Agreed** means the owner asked for it; **built** means it is
in this repository with local tests; **needs deployment** means it works only
once an operator configures or deploys something outside the repository.

## Outcomes

| Outcome | Status |
| --- | --- |
| Author avatar and name start at the same height in message headers. | Agreed, built. |
| V returns to Browse mode outside text fields, cancelling reattachment and keeping a comment draft for C. C and layered Escape are unchanged. | Agreed, built. |
| Ctrl or Cmd with backslash (`\`) or pipe hides all of Critiqs, even while typing, and shows it again with drafts, windows, and focus intact. Not kept across reloads. | Agreed, built. |
| Hashtags: typing `#` opens suggestions; draft hashtags as padded pills inside the editable input, with the text kept plain; posted hashtags and sidebar, search and settings chips share the same pill colors, chips read with a leading `#`, and they filter; mentions look different. | Agreed, built. |
| The server derives tags from text on every new message, reply, and edit, on Convex and SQLite, keeping explicit tags and older clients working. | Agreed, built. |
| Shared tag groups expand filters and list each thread once; people's choices are final. | Agreed, built. |
| Automatic grouping of new tags in the background, never blocking comments. | Agreed, built. Real model quality needs a configured provider. |
| Critiqs-managed AI, or a project's own OpenAI, Anthropic, Google Gemini, OpenRouter, Vercel AI Gateway, or OpenAI-compatible provider, with encrypted keys and a connection test. | Agreed, built. Managed AI needs deployment (operator settings on Critiqs Cloud). |
| Natural-language search with accurate source links and labeled basic search. | Agreed, built. |
| Insights that cite only actual, authorized threads. | Agreed, built. |
| Compatible migrations, product docs, and a minor release note. | Agreed, built. |

## Architecture

- **Tags.** `@critiqs/core` parses hashtags and keys tags (NFKC, lowercase,
  spaces and underscores as hyphens). `@critiqs/server` reads each message's
  hashtags, keeps per-thread counts, and serves a thread's tags as its explicit
  tags plus its written tags. A per-project registry records each tag's first
  spelling, its groups, and how it was grouped; thread-to-tag records let search
  find threads by tag.
- **Groups.** Owners create, rename, merge, and delete groups and set a tag's
  groups; a tag may belong to several. A person's choice locks the tag. A
  starter group, Copy & wording, takes `copy`, `wording`, `text`, `microcopy`,
  `ux-copy`, and `ux-copy-change` without AI.
- **Model calls.** One interface, a structured answer to one prompt checked by
  a schema, implemented with the AI SDK and explicit provider instances. It
  loads only where model calls run: Convex Node actions, and the self-hosted
  server's worker on first use. Browsers never receive provider code or keys.
- **Transactions.** Every model call happens between transactions. Each step
  (prepare, retrieve, apply, finalize) checks the reviewer's access again; a
  grouping run applies only to tags it still holds and no person changed since.
- **Protocol 5.** Backends report protocol 5 and keep every protocol 4 call.
  The component needs protocol 5 from its backend but accepts a protocol 4
  sign-in service, whose interface did not change.

## Phases, delivered together

1. Tag groundwork: parser, server-derived tags, registry, SQLite migration 6,
   Convex backfill, protocol 5.
2. Interface: hashtag composer and chips, header alignment, V and hide.
3. Manual groups and the sidebar's group filter.
4. AI plumbing: settings, encryption, endpoint allowlist, connection test,
   both connection modes.
5. AI features: automatic grouping, search, insights.
6. Documentation, release note, and checks.

## Defaults

- Projects on a deployment with Critiqs-managed AI use it unless their owner
  connects their own provider or turns AI off. Elsewhere, a project uses the
  deployment's own configured provider, if any, or none.
- With no AI, search matches words and `#tags` and says so, and grouping is
  manual. Nothing about commenting depends on AI.
- Only the project's owner changes AI settings and groups; everyone with
  access reads groups, filters by them, and searches.
- Limits: questions up to 500 characters; 20 searches a minute per reviewer;
  10 connection tests a minute per owner; up to 50 results, 24,000 characters
  of thread text sent for insights, 30-second model requests, 30 different
  hashtags per message and 200 per thread (text beyond them is refused, not
  cut), 100 groups per project. Critiqs-managed AI requests cost their
  model's credits, counted toward the plan's `aiRequests` allowance when the
  project pays, or the person's `personalAiRequests` when they pay
  (placeholder numbers; see [AI connections](ai-connections.md)).

## Checks

- Shared contract tests on SQLite and Convex: derived tags on create, reply,
  and edit; older clients' tag lists; registry and starter group; group
  permissions and locking; grouping claims, stale answers, retries, and AI off;
  basic and AI search, deleted threads and other projects, citations, and
  limits; owner-only settings, encryption, endpoint allowlist, and no fallback.
- Provider tests against local stand-ins for OpenAI, Anthropic, Google, the
  Gateway, and an OpenAI-compatible endpoint: address, key header, model, and
  schema sent; answers parsed; refused keys, unknown models, rate limits,
  invalid answers, redirects, and timeouts reported without provider text.
- Convex actions end to end through the AI SDK to a local endpoint, and the
  tag backfill; the self-hosted server end to end; SQLite migration from
  version 5.
- React tests for V, C, Escape, hiding, drafts, focus, hashtag suggestions,
  chips, group filters, search results, and AI settings.
- The package consumer check imports the vendored AI bundle, runs AI search in
  the self-hosted server under Node, and confirms the browser bundle carries
  no provider code.

Local stand-ins establish request formats and error handling, not a real
provider's answers or quality. Live providers and Critiqs-managed AI remain
unverified until an operator supplies credentials.
