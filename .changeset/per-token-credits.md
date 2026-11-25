---
"critiqs-react": minor
---

Charge Critiqs AI requests by their real token use. A Critiqs AI model may now have a `price` (US dollars per million input and output tokens) in `CRITIQS_MANAGED_AI_MODELS`, or `CRITIQS_MANAGED_AI_PRICE` for the single `CRITIQS_MANAGED_AI_MODEL`; each request then costs `ceil(cost × 200)` credits, at least 1, using the provider's reported cost when OpenRouter or Vercel AI Gateway reports one. A request starts only when the most it could cost fits in what its payer has left, counting requests still in flight; it is counted at its real cost once the model answers, and a failed request costs nothing. Models without a price keep their flat `credits`. Priced models show "about N credits".
