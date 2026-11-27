---
---

CI and release workflows only: actions/checkout 7.0.1, actions/setup-node 7.1.0 and actions/setup-python 7.1.0, which run on Node 24. Checked for the workflows that publish and release: every checkout there already sets persist-credentials to false, so checkout 6's new credential file doesn't apply, and the repository has no packageManager field, so setup-node doesn't start caching on its own. No Critiqs package changes.
