# Plan and billing

Organizations choose Free, Plus or Pro, see their AI credits and usage, set a cap, and add storage.

## Sub-features

- `plan`: the current plan and its limits.
- `upgrade`: an upgrade through Autumn checkout.
- `credits`: monthly AI credits, usage and the overage cap.

## How to get to it (user POV)

From the widget's account menu, or the website, as an organization owner.

## Driving it with walk.sh

Not driven yet. Plans are off in a default instance. A walk needs, before the website starts:
`CRITIQS_PLANS=enabled`, `CRITIQS_BILLING=autumn`, a placeholder `AUTUMN_SECRET_KEY`, and stored prices
(`bunx convex run billing:storePrices '<prices JSON>'`). Add these as an opt-in flag to `stack.sh` when the
walk is written; checkout itself can't run against a placeholder key.

## Gotchas

- Real Autumn calls need a sandbox key from your secret store or environment; never put it in the kit or in evidence.
