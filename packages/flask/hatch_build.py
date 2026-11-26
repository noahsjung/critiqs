"""Puts Critiqs's browser bundle (element.js from the `critiqs` npm package)
in the package as a static file. In the repository it comes from
packages/critiqs/dist, which `bun run build` makes; an sdist already holds it.
"""

from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

BUNDLE = "flask_critiqs/static/element.js"


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if version == "editable":
            return
        root = Path(self.root)
        # hatchling adds the nearest .gitignore to every sdist; here that is the
        # repository's, which says nothing about this package.
        for path in [path for path in build_data["force_include"] if Path(path).name == ".gitignore" and Path(path).parent != root]:
            del build_data["force_include"][path]
        built = root.parent / "critiqs" / "dist" / "element.js"
        if built.is_file():
            target = BUNDLE if self.target_name == "wheel" else f"src/{BUNDLE}"
            build_data["force_include"][str(built)] = target
        elif not (root / "src" / BUNDLE).is_file():
            raise FileNotFoundError(
                f"Critiqs's browser bundle is missing: build it first with `bun run build` in {root.parent / 'critiqs'}."
            )
