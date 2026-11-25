# Galgame tools

Utilities for visual novels. Each tool has its own directory and shares the pnpm configuration in this directory for linting, formatting, and tests.

- [NNN Voice Continue](nnn-voice-continue/README.md) generates patches that keep dialogue voice playing across unvoiced text in supported NNN engine games.

## Development checks

Run these commands from the `Galgame` directory.

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm test
```

Run `pnpm format` to apply the shared formatting settings.
