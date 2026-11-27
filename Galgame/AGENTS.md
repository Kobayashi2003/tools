# Galgame tools

## Small local tools

Narrowly scoped local utilities may use a single script or a minimal project.
For these tools, this section overrides the language-specific scaffolding and
development-check requirements in the Code-level AGENTS.md.

- Use the runtime or build tool directly when it is enough. Keep manifests,
  lockfiles, runtime pins, and launchers when they serve a build, runtime, or
  patch reproducibility need.
- Linters, formatters, static type checkers, and test frameworks are optional.
  Use an existing test, a direct build, or a sample run to check the affected
  behavior as appropriate.
- Document the prerequisites, run command, and supported builds in the tool's
  README.

## Patch handling

- Patch installation. Check that the patch matches the game build. Before replacing any file, save a restorable copy of the version being replaced.
- Compatibility. Record the games and builds processed and the verification performed in the tool's README.
