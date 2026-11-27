# Personal and project AI connections: plan and status

This plan lets each person and each project connect AI their own way, and lets
a project's owner decide who pays. It extends [AI connections](technical-direction.md#ai-connections)
and [Plans and limits](technical-direction.md#plans-and-limits). Terms are in
the [glossary](glossary.md).

Status words follow [tags and AI](tags-and-ai.md): **Agreed** means the owner
asked for it; **built** means it is in this repository with local tests.

## Decisions (agreed 2026-11-23)

- Each **person** and each **project** may have an AI connection:
  - **Critiqs AI**: a model from the list the deployment offers, chosen by
    name (for example Claude Opus 5.5 or GPT-6.2 Sol), counted against a
    Critiqs plan. It is everyone's default (see [Simpler setup](#simpler-setup-agreed-2026-11-23)).
  - **Their own key**: OpenAI, Anthropic, Google Gemini, OpenRouter, Vercel AI
    Gateway, or an OpenAI-compatible endpoint, with models picked from the
    provider's list.
- The project's owners pick the project's **AI usage rule**: its
  organization's admins, or its creator while still a member.

  | Rule | Requests a person starts use |
  | --- | --- |
  | Project pays | The project's connection |
  | Each person pays | The person's own connection |
  | Project pays, personal allowed (default) | The person's connection when they have one, otherwise the project's |

- Background work with no person behind it (automatic tag grouping) always
  uses the project's connection; without one, tags aren't grouped automatically.
- When the rule leaves a person with no connection, the request is refused
  with "Set up your AI to use this" and a way to open **Your AI**. Since the
  simpler setup, this happens only where the deployment offers no Critiqs AI,
  or the person turned theirs off or saved an unready key.
- The owner may limit which models a project's connection may use, so a
  shared budget isn't spent on the most expensive model. A person's own
  connection isn't limited by the project.
- Every model call goes from the Critiqs server to the provider. Browsers
  never receive keys. Using a person's Claude or ChatGPT subscription from the
  server is not allowed by those providers' terms and is not offered.
- Critiqs AI for self-hosted servers comes later.
- **Built:** payment through Autumn on Stripe, the Free,
  Plus, and Pro plans, and per-token credits
  ([Per-token credits](#per-token-credits-agreed-2026-11-23)). Credits count
  against organizations, not people
  ([Plans and limits](technical-direction.md#free-plus-and-pro)).

## Data shape

- **Project settings** (`aiSettings`, one per project) keep their fields and
  gain:
  - `rule`: `"project" | "personal" | "either"`; absent means `"either"`.
  - `managedModel`: the Critiqs AI model's id when `mode` is `managed`;
    absent means the deployment's first model.
  - `models`: for an own key, the models picked for this connection; `model`
    stays the default and is always one of them.
  - `allowedModels`: Critiqs AI model ids the project's connection may use;
    absent or empty means all.
- **Personal settings** (`personalAiSettings`, one per person, keyed by user)
  have the same connection fields (`enabled`, `mode`, `managedModel`,
  `provider`, `model`, `models`, `baseUrl`, `secret`, `epoch`, `lastTest`).
  Personal keys are encrypted like project keys, bound to `user:<userId>`
  instead of the project's ID.
- **Critiqs AI models** come from the deployment:
  `CRITIQS_MANAGED_AI_MODELS`, a JSON list of
  `{ "id", "label", "model", "credits" }`, sharing
  `CRITIQS_MANAGED_AI_PROVIDER`, `_API_KEY`, and `_BASE_URL`. Without it, the
  existing `CRITIQS_MANAGED_AI_MODEL` is one model, `default`, labelled
  "Critiqs AI", costing 1 credit. **Built:** a model may carry a `price`,
  `{ "input", "output" }` in US dollars per million input and output tokens,
  instead of `credits`; a request on it is charged for the tokens it used, and
  its cost in credits, as shown, is an estimate.
- **Providers** gain `openrouter`: the OpenAI-compatible connection with
  OpenRouter's address (`https://openrouter.ai/api/v1`) filled in. Settings
  views list the providers a backend accepts in `deployment.providers`.

## Which connection a request uses

`chooseConnection` in `@critiqs/server` decides, before any key is decrypted:

1. Background work: the project's connection, or none.
2. A person's request under `project`: the project's connection.
3. Under `personal`: the person's connection, or refused with code
   `setup-ai`. A person who saved nothing has Critiqs AI on their own plan,
   where the deployment offers it.
4. Under `either`: the person's connection when they saved one that is turned
   on and ready, otherwise the project's.

It returns the connection and its **payer**: the project, the person, or
nobody (an own key). A failed request never falls back to another connection.
A request may name one of the connection's models; a model the connection
doesn't offer, or the project doesn't allow, is refused.

## Allowances

Critiqs AI requests are counted in **credits**: a request costs its model's
`credits`. When the project pays, credits count against the project owner's
plan (`aiRequests`, per project, as today). When a person pays, they count
against the person's plan under a new metric, `personalAiRequests`, per
person. The built-in Free plan allows 50 personal credits a day and Team 500
(placeholders). Own keys count nothing against plans.

**Built:** credits count per organization under one
metric, `aiCredits`, per month: 200 on Free, 2,000 on Plus, and 10,000 on Pro.
When the project pays, they count against the project's organization. When a
person pays, they count against the person's home organization. `aiCredits`
replaces `aiRequests` and `personalAiRequests` for charging, and the placeholder
allowances above go away.

## Compatibility

- Existing project settings keep working: no `rule` means "Project pays,
  personal allowed", and someone with no personal connection uses the
  project's, exactly as before.
- New backend calls are added; none change. `/critiqs/config` reports
  `personalAi: true` where personal settings are available, and the component
  offers Your AI only then, as it does for mockups. It reports
  `modelLists: true` where providers' model lists, OpenRouter, and the model
  choice are available; without it the component offers no Load models
  button, no OpenRouter, and no model choice in Mockup mode.

## Details settled while building Core

These fill gaps in the decisions above; each can change.

- **A project with AI turned off uses no AI**, not even people's own
  connections, so its owner can keep its feedback away from every provider.
- **Search isn't refused** when the rule needs Your AI: it runs as basic
  search, as it does without AI, with the notice "Set up your AI to use
  this." and `noticeCode: "setup-ai"` so the interface can offer Your AI.
  Mockup turns are refused with error code `setup-ai`.
- **Fields left out of a save keep their saved values** (`rule`,
  `managedModel`, `models`, `allowedModels`), so an older client saving
  project settings doesn't reset the rule or models.
- **A project's AI is never left on with a Critiqs AI model it doesn't
  allow**: any save whose result has AI on with Critiqs AI and a chosen
  model is checked, with the saved fields merged, and a draft that breaks
  this isn't tested or charged. A model the deployment reorders or retires
  never refuses a save when none was chosen.
- **Turning AI off is never refused for Critiqs AI**: such a save ignores its
  Critiqs AI fields and keeps the saved ones, even when the deployment
  retired a model or turned Critiqs AI off. A save with AI on checks only
  Critiqs AI values that differ from the saved ones, so sending settings back
  as loaded can change the rule; a connection already on Critiqs AI may be
  saved on after the operator turns it off, but none may switch to it, be
  turned on with it, or choose new models then.
  Critiqs AI's fields are ignored in a save for an own key, as an own key's
  are for Critiqs AI.
- **Which Critiqs AI model a request uses:** the one it names, when offered
  and (for the project's connection) allowed; otherwise the saved model when
  still offered and allowed; otherwise, when the project limits its models,
  the first allowed model still offered, in the deployment's order; otherwise
  it is refused as no longer offered. A connection's status comes from the
  same choice, so it never says ready when its requests would fail.
- **A person's connection is used only when ready**, judged as their settings
  show it, before any model the request names; only then is the named model
  checked against it. Under `either` an unready one gives way to the
  project's; under `personal` it asks to set up Your AI.
- **A project with no saved settings has AI on**, under rule `either`: people
  with their own AI use it there, and the project's settings say when the
  project has no connection of its own.
- **Saving personal Critiqs AI is refused** on a plan that allows 0 personal
  credits, rather than accepted and then refused on every request.
- **A person's own connection never uses the operator's default provider**
  (`CRITIQS_AI_PROVIDER`), which serves only projects that save none.
- **Connection tests of both kinds share one per-minute limit per person.**
- **The OpenRouter preset** is left to the Models step, with the model list
  (built there; see below).

## Details settled while building the Interface

- **Who pays for AI** is in the project's AI settings (Tags and AI, AI
  connection), shown only where the backend reports the rule. With the
  project's AI turned off it can't be changed, since no AI runs.
- **Allowed models** start with every model ticked. The project's own Critiqs
  AI model is always ticked, so at least one is, and choosing a model the
  project doesn't allow ticks it. Every model ticked is saved as no limit
  (`allowedModels: []`), which also allows models the deployment adds later.
- The form shows the **model requests use now**, as the server picks it: the
  saved one while offered and allowed, otherwise the first allowed. A limit
  none of whose models is offered any more shows only the first offered model
  ticked, rather than every model.
- **Turning a connection off saves the saved connection, turned off**, never
  fields typed meanwhile, so turning it on again needs nothing re-entered. A
  typed key is dropped when the provider or connection changes (since the
  simpler setup, an address typed after it keeps it, as the key is for that
  address), and
  the saved key's hint shows only for its own provider and address.
- **Dialogs keep focus**: Remove's confirmation takes it and gives it back,
  focus lost to the page returns to the dialog, and in Comment mode a key from
  the page still reaches an open dialog or menu, so Escape closes it.
- A deployment with one Critiqs AI model shows it with its credits, without a
  model picker or allowed models. With one model or none, a save leaves the
  saved model and allowed models as they are, in Your AI too, so the only
  model isn't saved as a choice. A saved model the one model replaced resets
  to it, and a limit that leaves it out narrows to it, never to every model.
- Both connection forms name the choices **Critiqs AI** and **Your own key**;
  Your AI adds **Off**. **Remove** asks before deleting Your AI and its key.
- **Set up your AI** opens Your AI from a refused mockup turn (code
  `setup-ai`) and from a search notice with `noticeCode: "setup-ai"`. No other
  call returns `setup-ai` today.

## Details settled while building Models

- **Model lists** come from the provider through the server, never the
  browser: `ai:listModels` (a project's, for its owner) and
  `ai:listPersonalModels` (one's own), and `listAiModels` and
  `listPersonalAiModels` on a self-hosted server. Each takes the saved
  settings or a draft of the provider, address, and a typed key. A typed key
  is used for that request only and never stored or logged; without one, the
  saved key is used only for the provider and address it was saved with.
- The list request follows the same rules as model calls: HTTPS, the
  operator's allowlist for custom addresses, no private addresses unless
  allowed, no redirects, a 15-second timeout, and an 8 MB answer limit. Only
  model ids (in the form requests use) and display names are read, sorted
  by name (the display name, else the id); past 500, the first 500 in that
  order are kept and the list says the provider listed more. Failures are sorted like connection
  tests (key, rate limit, network, and so on), and a provider without a list
  says to type the model's name.
- The provider list calls are OpenAI `GET /v1/models`, Anthropic
  `GET /v1/models` (with `x-api-key` and `anthropic-version`), Google
  `GET /v1beta/models` (keeping models that answer prompts), Vercel AI
  Gateway `GET https://ai-gateway.vercel.sh/v1/models` (keeping language
  models), OpenRouter `GET /api/v1/models`, and `{address}/models` for an
  OpenAI-compatible endpoint. OpenAI's list leaves out models that can't
  answer text requests, such as embedding, speech, and image models. The
  Gateway's models are listed only at its own address.
- **Model lists have their own per-minute limit per person** (10, projects'
  and one's own together), separate from connection tests, so loading models
  doesn't use up tests.
- **The picker** replaces the typed model where the backend lists models:
  **Load models** (explicit, not automatic, so typing a key doesn't send it
  until asked), a search, ticks for the models on offer (picked ones first),
  **Default model**, and a typed name with **Add** as the fallback. A
  connection offers at most 50 models. Older backends keep the typed model.
- **Load models works only when the server can list**: with a typed key, a
  saved key for the same provider and address, or a provider that needs no
  key, and an address where one is required. Otherwise it says what to
  enter, so no request is spent on a sure refusal.
- **Choosing another provider clears the models**, so one provider's models
  are never saved as another's; choosing the saved provider at the saved
  address again brings its saved models back. **Typing a key starts the
  list over**: a list loaded, or still loading, with another key is dropped.
- **OpenRouter's address is fixed by Critiqs**: saving or listing it with an
  address is refused, and the form shows no address field. Like other
  providers' own addresses, it needs no allowlist entry.
- **A person's model choice** is `aiSettings:myChoice` (`aiChoice` on a
  self-hosted server): the source the rule gives them (`project`,
  `personal`, or none, with the reason and `setup-ai` when they must set up
  Your AI), the models they may name (Critiqs AI models with credits, limited
  to the project's allowed ones when the project pays; an own key's picked
  models by id), and the default. It never includes keys, addresses, or
  Critiqs AI's provider model names. Mockup mode shows **Model** beside Send
  only when there are two or more, remembers the choice per project in this
  browser, and sends it as `model` on `ai:mockupReply`; with one model, no
  model is sent. Search keeps using the default model.
- The self-hosted server has no Mockup mode yet, so its `aiChoice` is only for
  parity.

## Details settled while building Usage

- **The project's owner** sees the project's Critiqs AI credits in its plan
  usage as "Critiqs AI credits", today or this month as the plan limits them.
  The metric keeps its name, `aiRequests`. A person's own credits never show
  there.
- **Each person's own usage** is `aiSettings:myUsage` (`personalAiUsage` on
  a self-hosted server): the signed-in person's `personalAiRequests` used and
  their plan's limit for each period the plan limits, and the plan's label.
  It takes the UTC day the browser is in, as the project's usage does, and
  can't name anyone else. Without plans it returns null; someone not yet
  recorded has the default plan with nothing used.
- **Your AI** shows it in one line under the Critiqs AI model, only while
  Critiqs AI is the chosen connection: "Today: 12 of 500 credits on your Team
  plan.", with each period the plan limits, marked when one is used up. A plan
  that allows 0 says "Your Free plan doesn't include personal Critiqs AI. Use
  your own key, or ask the project to pay." Own keys show no line, and a plan
  that doesn't limit personal credits shows none either.
- **No new configuration flag:** the call ships with `personalAi`, and a
  backend without it (an error answer) shows no usage, so Your AI still works
  there.
- **Built:** with credits counted per organization
  (`aiCredits`), these lines show the paying organization's credits for the
  month. The names `aiRequests` and `personalAiRequests` stay in the protocol
  for older clients.

## Simpler setup (agreed 2026-11-23)

The first interface gave Critiqs AI, an own key, and Off equal weight, and
showed models as "Fast · 1 credit". Noah asked for setup that is simple and
not technical: Critiqs AI on the free tier by default, an easy upgrade, and an
own key as a separate choice.

- **Critiqs AI is everyone's default.** A person who saved nothing has Critiqs
  AI on their own plan where the deployment offers it; Your AI shows it ready,
  with nothing to set up or save. Under **Each person pays** such a person
  pays from their own plan instead of being asked to set up Your AI. Under
  **Project pays, personal allowed** the project still pays for them: only a
  person who saves their own choice pays for themselves.
- **The Free plan includes 50 personal credits a day** (placeholder), so
  Critiqs AI works without setup. It stays small because anyone who can reach
  a prototype can sign in, so it could be farmed with new addresses. Agreed
  2026-11-23: Free becomes 200 credits a month for the whole organization.
- **Models are chosen by name**, as the deployment labels them. What a request
  costs shows beside each model in the open menu ("5 credits"), never on the
  closed control, and in the Mockup model choice's hint. With per-token
  credits, that cost is an estimate. Critiqs Cloud's first
  list is Claude Opus 5.5, Claude Haiku 5.5, Gemini 4 Neon, and GPT-6.2 Sol,
  through one gateway that serves all four (see the example in the React
  package's README).
- **Upgrade** links to `CRITIQS_UPGRADE_URL`, an https page the operator
  names, beside the plan's name. Usage answers carry it as `upgradeUrl`;
  other addresses are ignored. Where the deployment takes payment, Upgrade
  opens **Plan and billing** instead, and shows only while there is a higher
  plan to move to.
- **Layout** follows the [design system](design-system.md): rows, no
  descriptions, one job per page.
  - **Your AI**: Model, the plan with Upgrade and the credits used, and **Use
    your own API key**. With a key saved: Model (the key's models), the key
    (`OpenAI key ····9876`), and **Use Critiqs AI instead**, which removes the
    key after a confirmation. There is no Off.
  - **The project's AI** (Tags and AI, AI): **AI for this project** (a
    switch), Model, **Who pays**, the plan's credits, **Allowed models** (a
    page of its own), and **Use your own API key**.
  - **Your own API key** is three steps in the same dialog: the provider, the
    key (and the address, for an OpenAI-compatible endpoint or where the
    deployment allows custom endpoints), then the models to offer. Continue on
    the key step loads the provider's models, which also checks the key; a
    provider that can't list them lets models be named by hand. Without model
    lists (older backends) the key step takes the model's name and saves.
- **Saving.** Every change saves at once and says so in a toast; a refused
  save shows the server's reason and leaves the setting as it was. Saved
  settings that need a save to work (a person's AI saved off, or Critiqs AI
  settings whose model is no longer offered) show their reason with one
  button that fixes them ("Turn on", "Use Claude Opus 5.5").

## Per-token credits (agreed 2026-11-23)

Built. A fixed price per request charged a short search and a long mockup
turn the same. Credits now follow the tokens each request used.

- **One credit is one cent** of what the customer pays.
- **A request costs `ceil(api_cost_usd × 200)` credits, at least 1**: twice
  the provider's price for its tokens, rounded up to whole credits.
- **The price comes from the gateway** when the provider reports the request's
  cost. Otherwise it comes from the model's prices in configuration, in US
  dollars per million input tokens and per million output tokens. The
  reference list prices are Claude Opus 5.5 at $4 and $20, Claude Haiku 5.5 at
  $0.10 and $0.50, Gemini 4 Neon at $3 and $15, and GPT-6.2 Sol at $2 and $10.
- **Charging happens in two steps.** Before a request, Critiqs holds the
  most it could cost and refuses it when that doesn't fit in what the payer
  may still spend. After it, Critiqs releases the hold and counts what the
  request really cost, and that count never refuses work already done. A
  failed request costs nothing, and holds expire after 10 minutes.
- **The cost beside a model is an estimate**, since the answer's length isn't
  known until it arrives.

## Stack

1. **Core** (built): data shape, Critiqs AI model list, `chooseConnection`,
   credits, personal settings operations, Convex and self-hosted storage,
   tests. See [AI connections](technical-direction.md#ai-connections) for the
   calls and the details below.
2. **Interface** (built): Your AI in the avatar menu; the usage rule, Critiqs
   AI model, and allowed models in project AI settings; "Set up your AI"
   prompts; docs.
3. **Models** (built): the provider's model list in the picker, the
   OpenRouter preset, and choosing a model per request in Mockup mode.
4. **Usage** (built): Critiqs AI credits used, in the project's plan usage
   for its owner and in Your AI for each person.
5. **Simpler setup** (built): Critiqs AI by default on the free tier, models
   by name, Upgrade, and the layout above, on the design system.
6. **Per-token credits** (built): usage from each model call,
   prices in configuration, and credits counted after the call, against the
   paying organization.
