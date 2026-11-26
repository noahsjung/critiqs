---
---

No release: release tooling only. The Publish workflow's npm job refuses a tarball whose package isn't `critiqs` or `critiqs-*`, the PyPI job uploads only a wheel and source archive of each Critiqs project at the version, every artifact check counts links as files, the package check scans every npm package for secrets and stray files (not only `critiqs` and `critiqs-react`), and Dependabot watches the gem's and the Python packages' dependencies.
