# frontend-audit

A measured visual-regression gate for matching live frontend renders to design mocks. Used as a Claude Code skill, but the scripts are standalone Node CLIs — anyone can run them.

The gate doesn't ask "does this look right." It asks "does the live render's `border-radius` match the goal's measured corners, does the row contain both background colors the goal has, does the Sobel edge map of this region align with the goal's edge map." If those measurements disagree, the gate exits non-zero with a named, actionable reason.

## The problem this solves

Visual review by eye is unreliable at scale. A reviewer sees a button and reads "rounded" — they miss that the corners are `16/16/3/3` instead of `16/16/16/16`. They miss a row with one bg color where the design has two. They miss a hairline border that's there in the goal and absent in the render. Three iterations later, the design has drifted.

`frontend-audit` is the cure: a script reads both the goal PNG and the live DOM, measures specific properties (radius, fill, border, cluster signatures, edge topology), and tells you exactly what's off. It runs after every UI change and refuses to let you call the work done until it exits 0.

## Quick start

```bash
# One-time setup in a new project:
bun add -d pngjs playwright && bunx playwright install chromium
echo '{"devUrl": "http://localhost:3000", "designDir": "design"}' > .frontend-audit.json
mkdir -p design

# Drop your goal PNG into design/:
cp ~/Desktop/coffee-page.png design/coffee-page.png

# Auto-author regions from the PNG (one of two paths):
bun ~/.claude/skills/frontend-audit/scripts/bootstrap-regions.mjs \
    --image=design/coffee-page.png --programmatic

# Bind each region to a stable Playwright locator on the live page:
bun ~/.claude/skills/frontend-audit/scripts/bind-selectors.mjs \
    --regions=design/coffee-page.regions.json --url=/coffee

# Snap the live render + auto-generate side-by-side diff PNGs:
bun ~/.claude/skills/frontend-audit/scripts/snap.mjs /coffee \
    --selector='main' \
    --out=design/_debug/coffee-current.png \
    --goal=design/coffee-page.png

# Run the gate:
bun ~/.claude/skills/frontend-audit/scripts/audit.mjs \
    --goal=design/coffee-page.png \
    --current=design/_debug/coffee-current.png \
    --url=/coffee
```

Exit 0 = ready to merge. Non-zero = read the failure details, fix, re-run.

## Why the gate is more reliable than your eye

| Failure mode | Eye | `audit.mjs` |
|---|---|---|
| Wrong corner radius (`16/16/3/3` vs `16/16/16/16`) | Easy to miss | `radius Δ tl=0 tr=0 bl=13 br=13` |
| Hairline border missing in render | Easy to miss | `border presence mismatch (goal=yes, cur=no)` |
| Row's two-tone bg collapsed into one | Easy to miss | `compound bg missing sub-region(s): 25% #f4f0ec` |
| Hex-level fill mismatch (`#e0d4c0` vs `#dac7af`) | Hard to judge at thumb scale | `fill Δ23 > 16 (goal #e0d4c0, cur #dac7af)` |
| Structural drift inside a region | Reads as "looks fine" | `edge-iou 0.22 < 0.4` + `edge-diff-<region>.png` |
| Missing section (badge / divider / banner) | Easy to miss in noisy diff | `Missing blobs ≥1500px²: 1  bbox=(52,1194, 1166×5)` |

## Architecture

```
goal.png    ──┐                                ┌──> per-region fill check (Δ ≤ 16)
              ├─> pixel sampling (cluster sig) ├──> per-region compound-bg check
              │   region rect on goal          ├──> per-region radius check (Δ ≤ 4)
live URL ─────┤                                ├──> per-region border presence + color
              ├─> Playwright locator           ├──> per-region edge-IoU (≥ 0.4)
              │   computed styles              │
              │                                ├──> global edge-blob match (missing/extra)
current.png ──┤                                └──> global grid luminance diff (drift sweep)
              └─> pixel sampling
                  (cluster sig + edges)
```

The gate is a four-input convergence: goal PNG, current PNG snap, live computed styles via Playwright, and authored region geometry. Each input covers what the others can't — and the gate fails when any single check disagrees.

## Scripts

All scripts run via `bun ~/.claude/skills/frontend-audit/scripts/<name>.mjs --help` for full flags. Below is the call-site purpose.

| Script | Role |
|---|---|
| `audit.mjs` | The gate. Compares goal vs current at each region; exits 0 only on full pass. Run this last. |
| `bootstrap-regions.mjs` | Auto-author a `<name>.regions.json` from the goal PNG. Two modes: `--programmatic` (Sobel + connected components, no deps) and OmniParser default (ML, ~3GB venv, semantic labels). Auto-emits sub-regions where internal seams are detected. |
| `bind-selectors.mjs` | Walks each region with a CSS selector and rewrites it with a stable Playwright `locator` (data-testid → role+name → text → class-free CSS path). Run after bootstrap, before audit. |
| `snap.mjs` | Headless-Chromium screenshot of a selector with optional `--goal=<png>` flag that auto-generates four side-by-side diff PNGs (full + three band zooms). |
| `discover.mjs` | Inventories design/*.png and tracks which PNGs have stale or missing regions files via SHA-256 hashing. Run before bootstrap to know what needs work. |
| `inspect-shape.mjs` | Reads radius / border / shadow / bg-mode from the goal PNG by pixel analysis. Useful for setting `expect` values. |
| `sample-colors.mjs` | Histogram-cluster colors per region in the goal PNG with `--debug` crops. Returns dominant + saturation-ranked hexes so you can pick the right hex without eyedropper guesswork. |
| `check.mjs` | `getComputedStyle()` dump for any CSS selector on the live page. Cross-reference live styles against `sample-colors.mjs` / `inspect-shape.mjs` output. |
| `analyze.mjs` | Diagnostic-only structural analyzer: edge maps, blob overlay, grid luminance heatmap PNGs. Exits 0 always — use to debug why a region keeps failing edge-IoU. |
| `diff.mjs` | Side-by-side goal/current PNG generator. Standalone version of what `snap.mjs --goal` emits inline. |

## The workflow loop

```
        ┌─────────────────────────────────────────────────┐
        │                                                 │
        │   1. Make a UI change                           │
        │   2. snap.mjs --goal=<goal.png>                 │
        │   3. Read the diff PNGs                         │
        │   4. audit.mjs --goal=… --current=… --url=…     │
        │      ├─ exit 0  →  done                         │
        │      └─ exit 1  →  read failure details,        │
        │                    open edge-diff-<region>.png  │
        │                    if edge-iou flagged          │
        │                                                 │
        └─────────────────────────────────────────────────┘
```

Step 4 is non-negotiable. The gate is the contract: assistants and humans alike are expected to re-run it after every change. The gate's exit code is the only signal that decides "done."

## The locator philosophy

Class names are an implementation detail. They change during normal refactors (someone renames a Tailwind class), get mangled by framework-scoped styles (Svelte's `svelte-abc123` suffix), or are hash-only by design (CSS Modules, styled-components). A class-based selector is dead on arrival in any of those settings.

What's stable across frameworks AND across refactors is **semantics**: ARIA roles, accessible names, `data-testid` attributes, visible text content. `bind-selectors.mjs` extracts those from the live DOM and writes them into your regions file in priority order:

```json
"ship-now-btn": {
  "x": 0.255, "y": 0.395, "w": 0.1, "h": 0.05,
  "locator": { "role": "button", "name": "Ship now" }
}
```

The audit resolves locators via Playwright's locator engine (`page.getByRole`, `page.getByText`, `page.getByTestId`). When a refactor renames a class, the locator still resolves.

## The regions file

Per-PNG sidecar at `design/<name>.regions.json`:

```json
{
  "_meta": {
    "sourceImage": "coffee-page.png",
    "sourceHash": "sha256-…",
    "generatedAt": "2026-05-12T…"
  },
  "page-bg": { "x": 0.02, "y": 0.02, "w": 0.02, "h": 0.02 },
  "ship-now-btn": {
    "x": 0.08, "y": 0.41, "w": 0.10, "h": 0.04,
    "locator": { "role": "button", "name": "Ship now" },
    "expect": {
      "radius": 8,
      "border": false,
      "fill": "#d11212"
    }
  }
}
```

Coordinates are fractional (0..1) relative to the goal PNG. `expect` overrides what the audit measures on the goal side — useful when you know the exact design intent and don't want to depend on pixel heuristics. `locator` describes how to find the element on the live page; the audit prefers it to raw CSS `selector` (still supported for legacy regions).

## Configuration

`.frontend-audit.json` at the project root:

```json
{
  "devUrl": "http://localhost:3000",
  "designDir": "design"
}
```

Override `DEV_URL` in the environment to point scripts at a different server temporarily.

## Troubleshooting

**`GATE BLOCKED — N ERROR (unresolved binding)`**
A region's locator or selector doesn't match anything on the live page. The DOM changed since the regions file was authored. Re-run `bind-selectors.mjs --url=<path>` to refresh.

**Regions land on whitespace in the audit table (`SKIP` everywhere)**
The current snap was element-cropped (`snap.mjs --selector='…'`) but the goal PNG is full-page. The fractional coords don't translate. Either snap the same framing as the goal, or accept that decorative regions will SKIP (only regions with locators get the live-computed-style check).

**`edge-iou X.XX < 0.4` failures that don't seem to map to a real difference**
Open `design/_debug/edge-diff-<region>.png`. Red = goal edges, blue = current edges, purple = overlap. Look for missing structural edges (vertical/horizontal seams indicating missing dividers, columns, or borders). If the diff genuinely shows the rect is just at a different y-offset due to overall page-height differences, increase `EDGE_SHIFT_WINDOW_FRAC_Y` in `audit.mjs` or accept the offset and rebuild the regions file against a snap that matches the goal's framing.

**`compound bg missing sub-region(s): N% #xxxxxx`**
The goal has a multi-bg layout (e.g. a row with a leading badge column in a different color than the content area) that the current render is missing. Implement the missing sub-region in code. The audit names exactly which color is absent.

**Stale regions after replacing a goal PNG**
`discover.mjs` reports `stale` for regions whose `_meta.sourceHash` doesn't match the current PNG bytes. Re-author with `bootstrap-regions.mjs --force`, then re-bind with `bind-selectors.mjs`.

## Limitations

- **Element-cropped snaps + full-page goal mocks**: fractional coords don't translate between them. The audit's per-region PNG-sampling fallback can't run; only regions with locators stay covered.
- **Goal mocks with strong JPEG compression artifacts**: pixel-cluster sampling occasionally picks up edge-anti-aliasing as a distinct cluster. Use `expect.fill` to lock in the intended hex and override.
- **Pill / `rounded-full` radii**: `getComputedStyle` returns a multi-million-px radius for `rounded-full`; the audit clamps to `min(w, h) / 2` and treats both sides as "pill" if matching — no work needed, just be aware when reading the table.
- **No mobile / responsive snaps**: viewport is fixed (`--viewport=WxH`, default 1600×1200). Multi-viewport auditing isn't built.

## Used as a Claude Code skill

`SKILL.md` is the assistant-facing entry point. When a user invokes the skill (via "iterate on this design," dropping a PNG into `design/`, etc.), Claude follows the workflow in `SKILL.md` and runs the scripts described above. The gate's exit code is the assistant's "done" signal — visual judgment doesn't override the script's verdict.

You don't need Claude Code to use this — the scripts are standalone. The skill packaging just makes them assistant-discoverable.
