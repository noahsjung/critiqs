---
"critiqs-react": patch
---

Panel sign-ins from Critiqs's own website and browser extension (`CRITIQS_WEB_ORIGINS` and `CRITIQS_EXTENSION_IDS`) no longer share one allowance of 20 starts a minute per origin, which would have turned real people away as use grew and let anyone lock them out. A panel start is now refused only while its email address can't receive another code (five in 15 minutes, as before) or the deployment can't send one, storing nothing, and every start still counts toward the deployment's 200 a minute. Popup sign-ins keep each site's 20 a minute.
