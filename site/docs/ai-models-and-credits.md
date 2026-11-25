# AI models and credits

> Understand Critiqs AI models, token pricing, how credits are calculated per request, monthly plan allowances, and what affects cost.

Critiqs AI works on Critiqs Cloud with no provider account or API key to set up. Usage is measured in **Critiqs AI credits**, where **1 credit equals 1 US cent ($0.01)**.

Commenting, replying, mentioning reviewers, tagging, filtering, basic search, and exporting never use credits. Credits apply only when you run **Mockup mode**, AI search (plain-language questions and cited insights), or automatic tag grouping through Critiqs AI. If you connect your own AI provider key instead, Critiqs charges no credits. See [Your AI](/docs/your-ai).

## How credits are calculated

Before calling a model, Critiqs reserves the request's estimated worst-case cost against the payer's remaining balance (including allowed extra credits, minus active holds). Because of that hold, a small balance above zero can still be refused if it cannot cover the worst-case estimate.

Once the model answers, Critiqs releases the hold and charges the request's actual cost. For a priced model, Critiqs uses the provider's reported USD cost when one is available, and otherwise computes it from the request's input and output tokens at the model's configured token prices:

```text
credits = ceil(api_cost_usd × 200)
```

The minimum charge is **1 credit** per request. Because 1 credit is $0.01 (100 credits per US dollar), multiplying the dollar cost by 200 means you pay twice the API cost, rounded up to the next whole credit. A failed request releases its hold and costs nothing.

Models configured without token prices charge a flat credit amount per request instead.

### Worked examples

- **A typical Mockup change on Claude Haiku 5.5:** 6,000 input tokens ($0.0006) and 1,000 output tokens ($0.0005) cost $0.0011 at list price. `ceil(0.0011 × 200) = ceil(0.22) = 1` credit.
- **The same change on Claude Opus 5.5:** 6,000 input tokens ($0.024) and 1,000 output tokens ($0.02) cost $0.044 at list price. `ceil(0.044 × 200) = ceil(8.8) = 9` credits.

## Reference model list and prices

Each deployment configures its own Critiqs AI models and prices. The reference list below shows four models and example list prices as chosen by name in **Your AI**, **Tags and AI**, and the **Model** menu in **Mockup mode**:

| Model | Input tokens (USD per million) | Output tokens (USD per million) |
| --- | --- | --- |
| Claude Opus 5.5 | $4.00 | $20.00 |
| Claude Haiku 5.5 | $0.10 | $0.50 |
| Gemini 4 Neon | $3.00 | $15.00 |
| GPT-6.2 Sol | $2.00 | $10.00 |

## Estimated credits per mockup change

| Model | Estimated credits per Mockup change | Estimated changes on Free (200) | Estimated changes on Plus (2,000) | Estimated changes on Pro (10,000) |
| --- | --- | --- | --- | --- |
| Claude Haiku 5.5 | About 1 | About 200 | About 2,000 | About 10,000 |
| GPT-6.2 Sol | 3 to 8 | 25 to 65 | 250 to 650 | 1,250 to 3,300 |
| Gemini 4 Neon | 4 to 12 | 16 to 50 | 160 to 500 | 830 to 2,500 |
| Claude Opus 5.5 | 5 to 16 | 12 to 40 | 125 to 400 | 625 to 2,000 |

These ranges are estimates based on Mockup requests measured on a sample app: about 3,000 to 10,000 tokens in (the instructions, the visible part of the page, the thread, and the changes so far) and 500 to 2,000 tokens out. A long Mockup turn that continues further down the page can make up to 5 requests, and each request costs credits.

## Why bigger pages and longer threads cost more

Because credits follow actual token usage, two things raise the cost of a request:

- **Bigger pages:** Each Mockup mode turn sends a structured description of the frozen page copy (elements, classes, text, and computed styles) plus the edits made so far. A dense page with many elements uses more input tokens than a simple form. On very long pages, Critiqs AI can make follow-up passes further down the page, up to 5 requests in a single Mockup turn, and each pass counts as another model request.
- **Longer threads and linked comments:** Every follow-up message in a mockup thread sends the thread's conversation history and any linked comments attached with **+ Add existing comment**. Starting a fresh mockup thread for an unrelated visual change keeps input tokens smaller than continuing a long thread.
- **Multi-width copies:** A mockup with several width copies applies each new turn across its copies, which requires more work than a single-width copy.
- **AI search:** A plain-language search makes one model call to interpret the question into filters. It makes a second call for cited insights (from up to 24,000 characters of matching threads) only when the first call succeeds and finds matching threads.

## Monthly credits by plan

> **Plan:** On Critiqs Cloud, monthly credits are included with each plan. While Critiqs is in beta, Plus is $10/month (regularly $20) and Pro is $50/month (regularly $100).

| Plan | Included Critiqs AI credits per month | Extra credits beyond allowance |
| --- | --- | --- |
| Free | 200 credits | Not available; use your own API key or upgrade |
| Plus | 2,000 credits | $1 per 100 credits, with an admin spending cap |
| Pro | 10,000 credits | $1 per 100 credits, with an admin spending cap |

Credits count per organization. When a project pays for Critiqs AI, its requests count against the project's organization. When a person pays for their own requests, they count against their home organization while they belong to it, or fall back to their own usage account on the default plan if they have no eligible home organization. Admins set the cap on extra credits in **Plan and billing**.

## Checking usage and controlling spend

- **Project usage:** Organization admins and the project creator (while a member) see project credit usage under the **\<plan name\> plan** block (for example, **Free plan** or **Plus plan**) in the **Project** panel and in the **AI** tab of **Tags and AI**.
- **Personal usage:** Any signed-in reviewer can open **Your AI…** from their avatar menu to see their personal credit usage and click **Upgrade** if needed.
- **Allowed models:** Organization admins and the project creator (while a member) can open **Tags and AI**, switch to the **AI** tab, and open **Allowed models** to restrict which Critiqs AI models reviewers can select when the project pays. For example, you can allow Claude Haiku 5.5 and GPT-6.2 Sol while turning off Claude Opus 5.5 on a shared budget.
- **Who pays:** Organization admins and the project creator (while a member) choose whether the project or each individual reviewer pays for requests they start. See [Your AI](/docs/your-ai).
