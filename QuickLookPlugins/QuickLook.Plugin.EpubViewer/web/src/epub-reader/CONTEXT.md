# EPUB Reader domain language

This context describes the language used by the EPUB reader engine and its controlled extension model. It separates book compatibility from application-code compatibility and keeps host UI concerns outside the reading model.

## Reading model

**Publication**:
An opened EPUB expressed as normalized metadata, resources, navigation, and an ordered reading sequence.
_Avoid_: Book model, parsed EPUB

**Reading Order Item**:
One resource in a Publication's ordered reading sequence; it may be a chapter, image page, cover, or another renderable unit.
_Avoid_: Chapter, page

**Reading Session**:
The publication-scoped reading state needed to continue reading, including the current location, preferences, and state contributed by reading features.
_Avoid_: Browser session, publication cache

**Reader Snapshot**:
The immutable built-in state a reader publishes to its host at one point in time.
_Avoid_: Store, mutable reader state

**Reader Command**:
A closed semantic action selected from reading input and executed by either the reader or its host, such as turning a page, stepping font size, opening search, or toggling Chrome.
_Avoid_: Reader event, input event

**Input Binding**:
A pure mapping from one normalized keyboard, wheel, click-zone, or swipe signal to a closed Reader Command. It cannot subscribe to DOM events or operate a renderer.
_Avoid_: Event handler, input plugin

**Theme Catalog**:
The validated, ordered theme definitions available to both publication rendering and host UI presentation.
_Avoid_: CSS theme switch, component theme list

**Reader Extension Configuration**:
The application-composed, prevalidated collection of typed EPUB compatibility modules, input bindings, and themes used when a Reading Session opens.
_Avoid_: Plugin bag, middleware list

**Reader Shell**:
The fixed React UI boundary that owns the reading viewport, semantic event routing, surface exclusivity, focus, modal accessibility, and Chrome lifecycle.
_Avoid_: Layout component, replaceable UI plugin

**Tool Module**:
A peer React reading tool whose descriptor supplies one toolbar/menu entry and one panel body under Reader Shell ownership.
_Avoid_: Panel flag, arbitrary plugin

**Surface Renderer**:
The single presentation provider for one semantic transient surface, such as a footnote or image viewer. The Reader Shell retains its wrapper, focus, dismissal, and isolation rules.
_Avoid_: Event interceptor, modal plugin

**Reader UI Configuration**:
The validated host configuration for Tool Modules, Surface Renderers, UI messages, and a closed set of visual and layout tokens.
_Avoid_: Props bag, arbitrary render slots

**Reader Event**:
A fact reported after reader state has been committed and its Reader Snapshot has been published.
_Avoid_: Reader command, callback

## Controlled extension

**Kernel**:
The non-replaceable part of the reader that protects publication validity, security, transaction ordering, resource ownership, rendering commits, and Reader Snapshot consistency.
_Avoid_: Core plugin, default feature

**Feature**:
A publication-scoped peer capability that adds reading behaviour without replacing Kernel invariants.
_Avoid_: Plugin, middleware

**Capability**:
A named, restricted interface through which a Feature exposes behaviour to other Features or the composition layer.
_Avoid_: Service locator entry, global API

**Provider**:
A host-supplied implementation of one replaceable infrastructure role, with one active implementation per role.
_Avoid_: Feature, plugin

**Observer**:
A read-only subscriber to Reader Events whose failure cannot invalidate committed reader state.
_Avoid_: Middleware, event handler with mutation authority

## Book compatibility

**Compatibility Module**:
A deterministic, phase-specific adaptation for authored EPUB content; it never exists to preserve an older version of this application's code or test data.
_Avoid_: Migration, generic compatibility hook

**Compatibility Profile**:
The ordered set of enabled Compatibility Modules and its deterministic identity for one Reading Session.
_Avoid_: Compatibility preferences, browser profile

**Publication Compatibility Rule**:
A Compatibility Module that selects or recovers safe publication-level meaning after archive safety checks.

**Content Document Compatibility Rule**:
A Compatibility Module that repairs or interprets a reading document consistently for analysis and rendering.

**Resource Compatibility Rule**:
A Compatibility Module that adapts publication resources after safe path and resource resolution.

**Rendition Compatibility Policy**:
A Compatibility Module that adjusts how compatible publication content is presented without replacing renderer transactions.
