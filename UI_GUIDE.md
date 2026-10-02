# UI Guide — Arribo! Transit Design System

Authoritative reference for user interface patterns, button aesthetics, design tokens, and component conventions across the Arribo! Mataró transit platform.

---

## 1. Design System Philosophy

Arribo! is a high-precision transit telemetry platform serving Mataró Bus Urbà (L1–L8). The interface is built on three core visual pillars:

1. **Telemetry Precision (Emerald Accent)**: The signature brand color is Emerald (`--brand`: `#10b981` in Dark mode, `#047857` in Light mode), representing live, real-time GPS telemetry and what is selected or interactive.
2. **Glassmorphism & Depth**: Surfaces utilize multi-layered elevation tokens (`--bg-surface`, `--bg-surface-elevated`, `--bg-surface-glass`) paired with subtle backdrop blurs (`16px`) and crisp micro-borders (`1px solid var(--border-subtle)`).
3. **Tactile Micro-Interactions**: All interactive elements respond to user intent with smooth transitions (`150ms cubic-bezier(0.16, 1, 0.3, 1)`), subtle hover elevation (`translateY(-1px)`), active press compression (`translateY(0)`), and high-contrast accessible `:focus-visible` rings.

---

## 2. Standardized Design Tokens

All buttons and interactive controls reference CSS Custom Properties defined in `:root` and `[data-theme="light"]`.

### 2.0 Design System v1 (use these in new code)

The Arribo! Design System (tokens, 7 components, usage rules) is the reference. Components read tokens only: a component never carries its own `[data-theme="light"]` override, and a theme is one block of token values. `test/design_system_test.js` checks that every `var()` is defined, that the pairs below are 4.5:1 or better in both themes, and holds a ratchet on hard-coded colours, light overrides and inline styles (they may only go down).

| Token | Dark | Light | Use |
|---|---|---|---|
| `--brand` / `--brand-strong` / `--brand-soft` / `--brand-tint` | `#10b981` / `#059669` / `#34d399` / 12% | `#047857` / `#065f46` / `#059669` / 10% | Live, selected, links, progress; tint is the selected ground |
| `--action` / `--action-hover` / `--on-action` | `#10b981` / `#34d399` / `#022c1e` | `#047857` / `#065f46` / `#ffffff` | The one primary action, active pills and tabs. Dark ink in dark mode: white on emerald was 2.5:1 |
| `--text-muted` | `#8b8b95` | `#63636b` | Hints and timestamps (was `#71717a`, 3.4:1 on elevated dark) |
| `--focus-ring` | `#34d399` | `#047857` | Solid 2px `:focus-visible` outline |
| `--status-live` / `-estimated` / `-scheduled` / `-regulating`, `--danger` (+ `-tint`) | emerald / `#f59e0b` / `#38bdf8` / `#c084fc` / `#f43f5e` | emerald / `#b45309` / `#0369a1` / `#7e22ce` / `#e11d48` | Fresh GPS, GPS lost (estimated), timetable only, regulating, errors. Never decorative |
| `--punct-early` / `-on-time` / `-late` / `-severe` | aliases of scheduled / brand / estimated / danger | same | Punctuality, always with the word or signed minutes |
| `--line-1` … `--line-8`, `--on-line-N` | operator colours | same | Line identity only; ink is dark on L1, L3-L7, white on L2, L8 |
| `--radius-xs` … `--radius-xl`, `--radius-full` | 4 / 6 / 8 / 12 / 16 / 9999px | same | Chips / pills / buttons and inputs / cards / modals / nav pills and dots |
| `--space-1` … `--space-8` | 4 / 6 / 8 / 12 / 16 / 20 / 24 / 32px | same | Gaps and padding |
| `--bus-*` | illustration palette | light variant with outline | The Volvo 7900 bus illustration only |

The older names below stay valid (several now carry the corrected values) and are migrated screen by screen: `--c10-primary*`, `--brand-primary` and `--accent-live` → `--brand*`; `--accent-warning` / `-scheduled` / `-danger` / `-regulating` → the status tokens; `--border-focus` → `--focus-ring` for outlines. Names the code used without defining (`--bg-elevated`, `--bg-secondary`, `--bg-card`, `--color-on-time`…) are now defined as aliases.

### 2.1 Color & Surface Tokens

| Token | Dark Mode Value | Light Mode Value | Description |
|---|---|---|---|
| `--c10-primary` | `#10b981` | `#047857` | Primary transit emerald accent (alias of `--brand`) |
| `--c10-primary-dark` | `#059669` | `#065f46` | Deep emerald (`--brand-strong`) |
| `--c10-primary-light` | `#34d399` | `#059669` | Light emerald (`--brand-soft`) |
| `--c10-primary-glow` | `rgba(16, 185, 129, 0.25)` | `rgba(5, 150, 105, 0.2)` | Emerald glow for active buttons and cards |
| `--bg-main` | `#09090b` | `#f4f4f5` | Page root background |
| `--bg-surface` | `#12131a` | `#ffffff` | Primary container surface |
| `--bg-surface-elevated` | `#1e1f26` | `#f8fafc` | Elevated card & button surface |
| `--bg-surface-glass` | `rgba(18, 20, 29, 0.78)` | `rgba(255, 255, 255, 0.9)` | Translucent glass overlay |
| `--border-subtle` | `rgba(255, 255, 255, 0.08)` | `rgba(9, 9, 11, 0.08)` | Standard divider & card border |
| `--border-strong` | `rgba(255, 255, 255, 0.16)` | `rgba(9, 9, 11, 0.16)` | Button border & high-contrast border |
| `--border-focus` | `rgba(16, 185, 129, 0.6)` | `rgba(5, 150, 105, 0.6)` | Accessible focus ring color |

### 2.2 Button Tokens

| Token | Value | Description |
|---|---|---|
| `--btn-font-family` | `var(--font-sans)` (`Geist`) | Button typeface |
| `--btn-font-weight` | `700` | Bold typographic hierarchy |
| `--btn-radius-sm` | `6px` | Compact buttons (table actions, badges) |
| `--btn-radius-md` | `8px` | Standard rectangular action buttons |
| `--btn-radius-lg` | `12px` | Large modal / hero buttons |
| `--btn-radius-pill` | `9999px` | Fully rounded filter pills and header nav |
| `--btn-transition` | `all 150ms cubic-bezier(0.16, 1, 0.3, 1)` | Standard micro-interaction timing |
| `--btn-primary-bg` | `var(--action)` | Primary fill, flat (no gradient) |
| `--btn-primary-shadow` | `0 2px 8px var(--c10-primary-glow)` | Primary resting shadow |
| `--btn-secondary-bg` | `var(--bg-surface-elevated)` | Secondary resting surface |

---

## 3. Button Hierarchy & Component Patterns

### 3.1 Primary Brand Action (`.btn-primary`)

Used for main calls-to-action (e.g., sharing reports, pagination, primary modal confirmation).

```html
<button type="button" class="btn-primary">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <!-- icon svg -->
  </svg>
  <span>Acció Principal</span>
</button>
```

**Visual Spec:**
- **Background**: `var(--action)` (flat)
- **Text Color**: `var(--on-action)` (dark ink in dark mode, white in light)
- **Border**: `1px solid var(--brand-strong)`
- **Border Radius**: `8px` (`--btn-radius-md`)
- **Shadow**: `0 2px 8px var(--c10-primary-glow)`
- **Hover**: Lift `transform: translateY(-1px)`, shadow `0 4px 14px var(--c10-primary-glow)`
- **Active**: `transform: translateY(0)`, shadow `0 1px 4px var(--c10-primary-glow)`

---

### 3.2 Secondary / Surface Action (`.btn-secondary`, `.btn-csv-export`, `.btn-change-line`, `.btn-back-to-landing`)

Used for secondary operations, exports, filters, and modal navigation.

```html
<button type="button" class="btn-secondary">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <!-- icon svg -->
  </svg>
  <span>Acció Secundària</span>
</button>
```

**Visual Spec:**
- **Background**: `var(--bg-surface-elevated)`
- **Text Color**: `var(--text-secondary)`
- **Border**: `1px solid var(--border-subtle)` or `var(--border-strong)`
- **Border Radius**: `8px` (`--btn-radius-md`)
- **Shadow**: `0 1px 3px rgba(0, 0, 0, 0.25)`
- **Hover**: Lift `transform: translateY(-1px)`, `color: var(--text-primary)`, background `rgba(255, 255, 255, 0.08)` (Dark) / `rgba(0, 0, 0, 0.05)` (Light), or brand emerald fill for hero actions.
- **Active**: `transform: translateY(0)`, shadow none.

---

### 3.3 Segmented Control & Filter Pills (`.line-filter-tab`, `.observatori-pill-btn`, `.incident-filter-pill`, `.incident-view-mode-tab`, `.landing-filter-tab`)

Used for multi-option switchers, timeframes, line pickers, and view mode tabs.

```html
<!-- Dock Container -->
<div class="line-picker-filter-tabs" role="tablist">
  <button type="button" class="line-filter-tab active" role="tab" aria-selected="true">
    <span>24 hores</span>
  </button>
  <button type="button" class="line-filter-tab" role="tab" aria-selected="false">
    <span>48 hores</span>
  </button>
</div>
```

**Visual Spec:**
- **Container**: Glassmorphic dock `background: var(--bg-main)` or `var(--bg-surface-elevated)`, `border: 1px solid var(--border-subtle)`, rounded `8px` (`--btn-radius-md`), padding `2px` to `4px`.
- **Idle Item**: `background: transparent`, `color: var(--text-secondary)`, `border: 1px solid transparent`, `border-radius: 6px`.
- **Hover Item**: `background: rgba(255, 255, 255, 0.08)` (Dark) / `rgba(0, 0, 0, 0.05)` (Light), `color: var(--text-primary)`, `transform: translateY(-1px)`.
- **Active Item**: `background: var(--action) !important`, `color: var(--on-action) !important`, `border-color: var(--c10-primary) !important`, `box-shadow: 0 2px 10px var(--c10-primary-glow) !important`.
- **Toolbar Wrapper**: Controls that contain multiple segmented docks should wrap them inside an unboxed flex toolbar (`.observatori-filter-toolbar`) with `flex-wrap: wrap; gap: 0.5rem;`.
- **Full-Width View Mode Docks**: For full-width switcher bars (`.incident-view-mode-tabs-container`), child tabs (`.incident-view-mode-tab`) expand equally with `flex: 1 1 0; min-width: 0; text-align: center; justify-content: center;` to fill the container rectangle cleanly without dead space. Titles and badge metadata are wrapped in `.incident-tab-title` and `.incident-tab-meta` to keep text, icons, and counter ranges atomic when wrapping. On mobile viewports (≤ 768px), the container stacks vertically (`flex-direction: column`) with `width: 100%` full-width touch targets.

---

### 3.4 Header Navigation Pill (`.btn-header-nav`)

Used in top navigation bars across all views (`index.html`, `dades.html`, `plan.html`).

```html
<a href="/dades" class="btn-header-nav">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <!-- icon svg -->
  </svg>
  <span>Dades</span>
</a>
```

**One style for every destination:** transparent ground, `var(--text-secondary)` label, `1px solid var(--border-strong)`, `--radius-full`; hover `var(--bg-hover-strong)` with `var(--text-primary)` and a `--brand-strong` border; the current page (`aria-current="page"`) in `--brand` on `--brand-tint`. The old per-destination hues (`.map-btn` green, `.planner-btn` violet, `.journalism-btn` sky, `.incidents-btn` amber) are retired; the classes may stay in the markup but carry no colour.

---

### 3.5 Circular Icon Buttons (`.btn-icon`, `.modal-close-btn`)

Used for theme toggle, audio alarms, refresh, and dialog close controls.

```html
<button type="button" class="btn-icon" aria-label="Canviar tema clar o fosc">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
    <!-- icon svg -->
  </svg>
</button>
```

**Visual Spec:**
- **Dimensions**: `36px × 36px` (or `32px × 32px` in compact toolbars).
- **Border Radius**: `50%`.
- **Border**: `1px solid var(--border-subtle)`.
- **Hover**: `background: var(--bg-surface)`, `border-color: var(--border-focus)`, `transform: translateY(-1px)`, `box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25)`.
- **Close Modal Hover**: `background: var(--c10-primary)`, `color: #ffffff`, `box-shadow: 0 2px 10px var(--c10-primary-glow)`.

---

### 3.6 Contextual Table & Report Actions (`.btn-locate-incident-stop`, `.btn-report-action`)

Used for in-table geographic stop locator and report exports with semantic color coding and verified WCAG AA contrast.

```html
<!-- Table Locate Button (Sky Blue Accent) -->
<button type="button" class="btn-locate-incident-stop" title="Veure aquesta parada al mapa">
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
    <line x1="8" y1="2" x2="8" y2="18"/>
    <line x1="16" y1="6" x2="16" y2="22"/>
  </svg>
  <span>Mapa</span>
</button>

<!-- Semantic Report Copy: Investigation (Rose) -->
<button type="button" class="btn-report-action btn-report-investigation">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
  <span>Copiar informe d'investigació</span>
</button>

<!-- Semantic Report Copy: Anomalies (Amber) -->
<button type="button" class="btn-report-action btn-report-anomalies">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
  <span>Copiar informe d'anomalies</span>
</button>
```

**Semantic Color Tokens:**
- **Investigation / Critical**: Dark: `#fb7185` on `rgba(244, 63, 94, 0.12)`; Light: `#be123c` on `rgba(225, 29, 72, 0.08)`. Solid hover: `#e11d48` with `#ffffff` text.
- **Anomalies / Warning**: Dark: `#f59e0b` on `rgba(245, 158, 11, 0.12)`; Light: `#b45309` on `rgba(217, 119, 6, 0.08)`. Solid hover: `#d97706` with `#ffffff` text.
- **Stop Locator**: Dark: `#38bdf8` on `var(--bg-surface-elevated)`; Light: `#0284c7` on `var(--bg-surface)`. Solid hover: `#0284c7` with `#ffffff` text.
```

---

## 4. Accessibility & Interaction Guidelines

1. **Always Provide `:focus-visible`**:
   Never use `outline: none` without a high-visibility replacement. The standard outline is:
   ```css
   outline: 2px solid var(--border-focus);
   outline-offset: 2px;
   ```
2. **Touch Target Size**:
   All interactive buttons have a minimum hit area of at least 32px height (desktop) and 40px (mobile) with `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent`.
3. **Typography**:
   All buttons use `font-family: inherit` with `font-weight: 700` and `user-select: none`.
4. **Disabled States**:
   Disabled buttons use `opacity: 0.45; pointer-events: none; cursor: not-allowed;` with no hover lift or shadow.
