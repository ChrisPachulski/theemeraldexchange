# Advanced-options UX checklist (Sonarr/Radarr power actions)

Companion to `2026-06-22-arr-advanced-options-design.md`. Apply to BOTH the web (React) and Apple (SwiftUI tvOS/iOS) polish passes. Grounded in Sonarr/Radarr's own UIs + NN/G + Apple HIG (2024–2026). One line each, imperative.

## [Release browser]
- Columns in this order: Indexer · Source/Age · Title · Quality · Language · Size · Peers (seed/leech) · Custom-format score · Reject indicator · Grab.
- Rejection reasons are a VISIBLE column/inline text, NOT hover-only (the #1 documented *arr pain point); full reason on focus/tap.
- Sortable columns; default sort = seeders desc (or CF score); PERSIST the user's last sort/filter across opens (don't reset like *arr does).
- Right-align numeric columns (size, seeders, score); humanize sizes (1.4 GB) and ages (2d).
- Filter chips additive + clear: All / Season Pack / Not Season Pack / English + custom-regex; show active-filter count, one-tap "Clear filters", result count ("12 of 47").
- Rejected releases stay visible but de-emphasized (dimmed + reason), not hidden — user may still "grab anyway".
- Each row's Grab is the single primary action; secondary release detail goes in a per-row overflow, not competing buttons.

## [Action menu]
- One labeled "Advanced" entry (admin-only); group by intent: [Update] Refresh & scan, Search monitored · [Find] Interactive search · [Organize] Preview rename, Manage episodes · [Info] History · [Config] Monitoring toggle, Edit.
- Menu/sheet for the cluster (≥6 actions); inline buttons only for the 1–2 most-frequent. Don't scatter 9 buttons on the detail view.
- Irreversible/heavy actions (Apply rename, Grab over-cap) visually separated within the menu (divider + distinct treatment).
- Interactive search, preview-rename, history each open their own full sheet/page (table-heavy); not a popover.

## [Confirms/overrides]
- Only confirm real-consequence actions: Apply rename, Grab-over-cap. Refresh/scan/search/monitor-toggle need NO confirm (reversible) — avoid cry-wolf.
- Confirm buttons use verb+noun, never Yes/No/OK: "Apply rename" / "Keep current names"; "Grab anyway" / "Cancel".
- Over-cap grab: state specifics in the body ("18.2 GB exceeds 15 GB cap"); mark the grab CTA as override; badge the row "Over cap".
- Spatially displace confirm from trigger; no destructive default focus; prefer Undo/recovery over a gate where feasible.
- Preview-rename: per-file existing→new path diff so user verifies exact affected files before Apply.

## [States: loading/empty/error]
- Interactive search & history: skeleton rows mirroring real columns, not a centered spinner.
- Action triggers (Grab, Apply, Refresh): spinner ON the button + disable to prevent double-submit; suppress loaders under ~300ms.
- Empty: "No releases found" + active query/filters + "Clear filters"/"Search again". Never a blank panel.
- Error: show the actual failure + Retry; distinguish "0 results" (empty) from "search failed" (error).
- Manage-episodes / toggles: optimistic with rollback-on-failure feedback.

## [tvOS focus]
- Every sheet/menu receives initial focus on open (primary action or first row) and returns focus to the trigger on dismiss.
- Wrap the release list and each filter-chip row in `.focusSection()`; no focus traps — Menu button always exits.
- Filter chips horizontal above the vertical list; up/down crosses cleanly between chips, list, Grab (focus guides if geometry breaks).
- Confirm dialogs trap focus to the two buttons; default focus on the SAFE option for over-cap/destructive; never auto-focus destructive CTA.
- Large hit targets; rely on system focus highlight, don't invent a competing one.

## [Accessibility]
- Web: full keyboard nav — sortable headers are buttons; rows/chips tabbable; semantic `<table>`/`<th scope>`, not divs.
- Never status-by-color-alone: over-cap/rejected/season-pack badges carry text/icon + label; contrast ≥4.5:1.
- VoiceOver: each row reads composed label (title, quality, size, seeders, reject reason); Grab announces target + over-cap; toggles announce state.
- Filter chips announce selected/unselected; result-count change announced via aria-live.

## [Cross-platform consistency]
- Same column set, sort/filter semantics, action grouping, identical confirm wording (verb+noun) across web/tvOS/iOS — only input model differs.
- "Advanced" gating, over-cap badge, rejection-reason visibility behave identically on all three.

## Sources
- https://wiki.servarr.com/sonarr/settings
- https://github.com/Radarr/Radarr/issues/8122
- https://github.com/Sonarr/Sonarr/issues/7813
- https://github.com/Sonarr/Sonarr/issues/4132
- https://www.nngroup.com/articles/confirmation-dialog/
- https://www.nngroup.com/articles/proximity-consequential-options/
- https://www.nngroup.com/articles/skeleton-screens/
- https://developer.apple.com/documentation/uikit/focus-based_navigation/about_focus_interactions_for_apple_tv
- https://m3.material.io/components/menus/guidelines
- https://www.w3.org/WAI/tutorials/tables/
