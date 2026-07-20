# Codex Code Report 260331-1

## Scope

This round escalated from page-level polishing to framework-level layout review for the Vuetify UI shell, focusing on:

- app shell and page scroll containment
- theme token completeness and default overlay readability
- common layout best practices for `v-app`, `v-main`, and page wrappers
- common icon-button accessibility in shared layout surfaces
- responsive behavior for shell-level navigation surfaces

## Systemic Problems Confirmed

### 1. Theme foreground tokens were incomplete

`ui/history-v3/src/plugins/vuetify.ts` defined custom `background`, `surface`, and semantic colors, but did not define the corresponding `on-*` foreground tokens. Vuetify auto-derived some of them incorrectly.

Observed result:

- `on-surface` / `on-surface-variant` were missing or wrong
- default tooltip/overlay text could become effectively invisible
- theme-dependent surfaces were vulnerable beyond the models page

### 2. Scroll containment pattern was inconsistent

`ui/history-v3/src/pages/vuetify/VModelsPage.vue` used `fill-height` without the same `flex-grow-1 overflow-y-auto` content shell used by other Vuetify pages.

Observed result:

- page content could exceed viewport height
- no usable vertical scrollbar appeared for the models page

### 3. Vuetify root container protections were missing

There was no shared safeguard for:

- `color-scheme` synchronization with theme
- root container `min-width: 0`
- `v-main` horizontal overflow protection

Observed result:

- native controls / scrollbars were not guaranteed to follow the active theme
- page-level long content could cause avoidable overflow behavior

### 4. Shared icon-button accessibility was incomplete

Common icon buttons in shared layout surfaces relied on tooltips alone.

Observed result:

- missing explicit `aria-label` on icon-only actions
- keyboard/screen-reader affordances were weaker than they should be

### 5. `v-main` did not guarantee a stable flex/scroll contract

Vuetify route pages depended on each page root guessing how much height was available under the app bar.

Observed result:

- pages could become taller than the viewport without exposing a usable scrollbar
- `fill-height` behavior depended on page-local wrappers instead of the shell contract
- a single missing `overflow-y-auto` wrapper could make an entire page feel broken

### 6. History navigation was desktop-only

`ui/history-v3/src/pages/vuetify/VHistoryPage.vue` used a permanent left drawer at all breakpoints.

Observed result:

- request list and detail panel competed for width on narrow screens
- there was no mobile-first way to reopen the list once the layout became cramped
- the page shell was not aligned with responsive admin-console navigation patterns

## Changes Implemented

### Theme layer

Updated `ui/history-v3/src/plugins/vuetify.ts`:

- added explicit `on-background`
- added explicit `on-surface`
- added explicit `on-surface-variant`
- added explicit `on-primary`, `on-secondary`, `on-success`, `on-error`, `on-warning`, `on-info`

This restores default Vuetify foreground behavior for overlays and theme-driven content instead of relying on local component workarounds.

### Global Vuetify shell

Updated `ui/history-v3/src/styles/vuetify-overrides.css`:

- added `.v-theme--light { color-scheme: light; }`
- added `.v-theme--dark { color-scheme: dark; }`
- aligned `.v-application` background/text with theme tokens
- added `min-width: 0` for `.v-application__wrap` and `.v-main`
- added `min-height: 0` for `.v-application__wrap` and `.v-main`
- made `.v-main` a column flex container
- made direct route-page roots flex items with `flex: 1 1 auto`
- added `overflow-x: hidden` for `.v-main`

This establishes baseline shell behavior instead of fixing overflow/theme issues per page.

### Models page scroll containment

Updated `ui/history-v3/src/pages/vuetify/VModelsPage.vue`:

- wrapped page content in `flex-grow-1 overflow-y-auto`
- aligned the page with the established scroll-container pattern already used by other Vuetify pages

### Shared accessibility fixes

Updated:

- `ui/history-v3/src/components/layout/NavBar.vue`
- `ui/history-v3/src/pages/vuetify/VHistoryPage.vue`
- `ui/history-v3/src/components/models/ModelCard.vue`
- `ui/history-v3/src/components/config/ConfigKeyValueList.vue`
- `ui/history-v3/src/components/config/ConfigStringList.vue`
- `ui/history-v3/src/components/config/ConfigRewriteRules.vue`

Changes:

- added `aria-label` for icon-only theme toggle
- added `aria-label` for history refresh button
- added `aria-label` for pagination buttons in history
- added `aria-label` for JSON dialog close button
- added `aria-label` for config row removal buttons
- added `aria-label` for rewrite rule collapse/remove buttons

### History page responsive shell

Updated `ui/history-v3/src/pages/vuetify/VHistoryPage.vue`:

- switched the request list drawer to `permanent` on desktop and `temporary` on mobile
- bound the drawer mode to Vuetify display breakpoints instead of a fixed layout assumption
- added a compact mobile header action to reopen the request list

This removes a desktop-only shell assumption from one of the core pages.

## Models Page Work Completed Earlier In The Same Track

The models page had already received substantial structural fixes before this framework pass, including:

- unified raw JSON presentation
- corrected raw JSON mode behavior
- stable model-card summary layout
- global primary-limit metrics
- metadata cleanup and de-duplication
- tooltip readability fixes moved back to theme layer once root cause was confirmed

## Remaining Audit Targets

These are still worth deeper follow-up if the user wants the framework fully normalized:

1. URL-synced UI state
   Current filters/tabs are mostly local state; best-practice deep-linking is still incomplete.

2. Additional icon-only actions
   The main shared surfaces are improved, but a full accessibility sweep should still cover all remaining icon buttons in Vuetify pages.

3. Overlay family consistency
   Tooltip root cause is fixed at theme level, but menus/dialogs/snackbars should still be spot-checked under both light and dark themes.

## Validation

Executed successfully:

- `npm run typecheck:ui`
- `npm run test:ui`
