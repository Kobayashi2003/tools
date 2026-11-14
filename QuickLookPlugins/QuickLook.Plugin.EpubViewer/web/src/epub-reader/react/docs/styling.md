# React styling

Reader CSS follows component ownership while preserving one explicit package
cascade. The public style entry is [`styles.css`](../../styles.css); consumers
do not import individual internal stylesheets.

## Ownership rules

- A stylesheet used by one component is placed beside that component and uses
  the same basename: `EpubSearchPanel.tsx` and `EpubSearchPanel.css`.
- Styles used by an extracted child component move with that child under its
  feature directory.
- Feature siblings may share a feature-local base only when the rules describe
  one stable visual primitive.
- Cross-component tokens and behavior live under `react/styles`.
- Showcase-only presentation lives under `showcase` and must not define Reader
  component behavior.

Do not create a generic `utils.css` or move selectors away from their owner only
to reduce file count.

## Shared styles

The intentional shared files are:

- `styles/tokens.css` — spacing, radii, colors, shadows, and other common custom
  properties;
- `styles/responsive.css` — adaptations involving several Shell regions;
- `styles/motion.css` — reader-wide reduced-motion behavior that must win late
  in the cascade;
- `panels/panel-base.css` — structural panel, form, list, and empty-state
  primitives shared by built-in panels;
- `overlays/annotation-colors.css` — the semantic color mapping shared by
  selection and mark surfaces;
- `reader/shell/immersive-chrome.css` — coordinated immersive-mode overrides.

A rule belongs in one of these files only when at least two owners consume the
same behavior. Otherwise keep it component-local.

## Cascade order

`styles.css` loads styles in this order:

1. tokens;
2. source-selection presentation;
3. Shell and persistent Chrome;
4. Shell hosts and overlays;
5. panel base and feature panels;
6. cross-component responsive behavior;
7. immersive-mode overrides;
8. reduced-motion overrides.

Later layers intentionally adapt earlier component declarations. Reordering
imports is a behavior change and requires browser and visual verification.

Applications copy `styles.css` unchanged, so it holds nothing of the Component
Atlas demo: `index.tsx` and the browser conformance page import
`showcase/showcase.css` themselves, after it.

## Tokens a host may set

Hosts style the reader through themes and configuration, with one layout
exception: `--epub-host-chrome-top`, the height of a host bar above the
toolbar ([ADR 0003](../../docs/adr/0003-host-header-through-a-layout-token.md)).
It is read with a `0px` fallback and never defined inside the Shell, so the
value an ancestor sets comes through. `--epub-chrome-top` adds it to the
toolbar height; anything that must keep clear of the chrome reads that.

## Selectors and state

Component selectors use the existing `epub-` BEM-style namespace. State that is
local to a component uses `is-*`, `has-*`, ARIA state, or a component element
modifier. Whole-reader presentation state is expressed on
`.epub-reader-shell` through documented `data-*` attributes.

Prefer:

- logical properties for writing-mode and direction support;
- CSS custom properties for validated theme and layout input;
- container or media queries in the shared responsive layer when several
  regions must change together;
- ARIA selectors when visual state must match accessibility state.

Avoid selectors that depend on incidental DOM depth, unrelated Showcase
wrappers, or private markup inside contributed content.

## Theme boundary

Core theme definitions supply a closed set of validated publication and host UI
tokens. `ReaderShell` maps optional host palette values to `--epub-color-*`
properties. Component CSS consumes those properties and must not introduce
network-backed assets or arbitrary host-provided declarations.

Layout policy remains in TypeScript configuration and rendition planning; CSS
only presents the resolved Shell attributes and custom properties.

## Adding or changing styles

1. Identify the component or shared behavior that owns the rule.
2. Reuse an existing token before adding a literal repeated value.
3. Keep the selector scoped to the owner and preserve keyboard/focus states.
4. Check compact, wide, fullscreen, immersive, reduced-motion, light, and dark
   behavior when applicable.
5. Add a new import to `styles.css` in the correct cascade position.
6. Run formatting, production build, browser interactions, and visual baseline
   checks.

CSS file placement is an internal detail; `styles.css` remains the stable entry
for hosts and conformance pages.
