# Floatilla — graphics and performance handoff

Branch: `codex/performance-and-clarity`

Based on `59dee63dd1e2eb70c2adf425dfde92525a2f5173` on `claude/brave-thompson-92glte`.

## Intent

Keep the Three.js/Vite game and its procedural art pipeline. Improve sharpness, readability, rendering cost and long-session GPU resource handling. Main game design remains with Claude. No balance, spawning, survival-economy, fleet-AI or flood-curve redesign is included. The one control adjustment is that Space now idles the engine **and furls sails**, then allows the boat to coast; its help text says this explicitly.

## What changed

- Medium is the default and renders straight to the antialiased canvas. Bloom, HDR render targets, grading and planar reflections run only on high. Medium retains sky-baked environment lighting: removing it made hulls, faces and glass too dark. Environment refresh has a minimum interval of 30 seconds on medium and 12 seconds on high, plus a sun-direction-change threshold.
- Shadow maps: medium 1024 / high 2048, with tighter coverage, instead of 2048 / 4096. Existing alternate-frame shadow updates are retained.
- Water geometry: low 96, medium 128, high 180 segments, versus 200. CPU buoyancy still uses the same three displaced Gerstner waves; shader quality changes only shading waves/ripples and mesh density. The coarser mesh approximates those waves, so severe seas still merit inspection.
- Water shader tiers compile out unused wave/ripple work. Every tier samples the full ripple wavelength range, rather than keeping only the shortest waves. Derivative filtering suppresses distant ripple aliasing. Low omits the procedural foam-noise calculation.
- Shore foam and shallow-water colour sample floor depth per pixel. Previously, interpolation across coarse wave triangles caused obvious stepped patches alongside straight warehouse walls. Foam is narrower and less opaque; wakes are smaller, softer and shorter lived.
- Terrain tiles use 32 segments rather than 64. Colliders and the floor map are unchanged. This reduces terrain triangles by 75%, with a tradeoff in distant terrain shape and possible shoreline/ground alignment at close range.
- Clear-weather haze is reduced and ambient fill increased. Clouds use three noise octaves instead of five. Custom haze/cloud/particle materials now participate in tone mapping. Several reversed GLSL `smoothstep` bounds were corrected.
- Procedural windows use derivative antialiasing and average coverage at distance, reducing flickering facade grids. Night lighting fades to an average rather than random subpixel flicker.
- Static repeated boat boxes/cylinders are batched per geometry/material/shadow settings. Animated sail rigs, props, oars, flag hierarchies and searchlights are excluded. Walking obstacles are computed before batching.
- Rebuilding/removing a boat disposes body-owned GPU geometry/materials and instance buffers while preserving shared primitive geometry, cached materials, the plank texture and crew assets.
- Camera starts slightly higher/further back and shortens its orbit when a city collider blocks the view. This handles warehouses/roofs, not terrain or other boats. Animated subjects and walking controls remain intact.
- Smaller HUD/minimap, two simultaneous notifications, no costly HUD backdrop blur, compact solo-fleet display, empty panels hidden, and a `U` / on-screen HUD toggle.
- Dynamic resolution resets on preset changes and stops at 80%, rather than 55%. Composer pixel ratio follows renderer changes. This preserves a readable image instead of concealing expensive rendering behind severe blur.
- FPS uses elapsed wall time before the simulation clamp. The old displayed counter could not report below 20 fps. `?profile=1` adds rolling mean/p95 frame time and renderer counters; it is off in the normal game.

## Observed performance

These are **illustrative local playtest samples**, not a controlled hardware benchmark or guaranteed speedup. Tested in the Codex in-app Chromium browser on this Windows machine at a 931 × 663 viewport. Only one game tab was left open during sampling. Original and revised scenes differ in camera framing, game time, entities and resolution; adaptive resolution was enabled. CPU submission numbers are not GPU timings. Initial shader compilation, quality changes and environment-map baking can cause hitches.

The original baseline is the exact base source above, served locally with only a measurement overlay using the same uncapped frame collector. That temporary comparison copy is not part of this branch.

| Sample | Rolling fps | Mean frame | p95 frame | Resolution scale |
| --- | ---: | ---: | ---: | ---: |
| Original medium, idle harbor | 22.2 | 45.1 ms | 59.5 ms | 55% |
| Revised medium, harbor sailing, before final ambient-light refinement | 40.9 | 24.5 ms | 33.9 ms | 80% |
| Revised medium, final ambient lighting, resumed crew/deck view | 43.4 | 23.0 ms | 28.7 ms | 100% at that moment |
| Revised high, inside harbor, two rescued characters/animals aboard | 34.6 | 28.9 ms | 40.3 ms | 80% |
| Revised medium, end of storm/night survival stress run | 41.4 | 24.2 ms | 33.8 ms | 80% |

Revised medium varied roughly 29–50 fps across the inspected views; high roughly 26–39 fps after warmup. It is **not a stable 60 fps build**. One low-quality harbor sample settled at 40 fps / 25.0 ms mean / 33.7 ms p95 at 80%. The final medium lighting keeps considerably more detail and indirect light than low.

Typical recorded medium samples were around 120–145k submitted triangles versus about 230–250k in the original medium harbor. Draw calls vary strongly with view, shadow-refresh frame, spawned boats and people. These counts include all passes and are not fixed budgets.

## Browser playtest

Multiple sessions included throttle and reverse, sailing/furling, steering and collision damage, softer wakes, camera orbit/zoom, deck walking, petting animals, journal/workshop opening, HUD hiding, manual save/load, and the complete medium → high → low → medium transition. A rooftop survivor and cat were rescued; the resulting two people/two animals were saved and restored successfully. Sails, characters and deck rendering remained visible after batching.

An unattended accelerated ×30 stress run progressed from day 1 to **day 10 23:59**, ending in expected starvation/thirst game-over. The final view showed a storm, rain, night lighting and flood at 9.8 m. This is a rendering/survival stress run, **not ten days of active gameplay**. Weather transitions were not all manually observed. No console errors were captured in the checked final medium/high sessions; the existing non-finite-value guard produced a compiler warning on this graphics driver.

Not validated end-to-end: a large recruited fleet, every module/boat archetype in the browser, extended combat, full landmark progression, mobile/touch, other GPUs, and flooded downtown at 75 m. Batching tests verify transform preservation and animated-hierarchy exclusion; lifecycle tests verify ownership/disposal. They do not establish visual correctness for every boat/module combination.

## Validation

- `npm test`: 7 regression checks for slow frames/p95/window recovery, static batching transforms, shared-resource preservation and camera segment/box intersections.
- `npm run build`: production build passes.
- Browser checks above, including inspection of material/shader output and console errors.

## Screenshots

These illustrate different moments, **not pixel-matched before/after renders**. Diagnostic overlays are deliberately visible.

- [Original medium harbor](review/original-medium.jpg)
- [Revised medium harbor](review/revised-medium.jpg)
- [Revised high harbor](review/revised-high.jpg)
- [Storm/night stress-run outcome](review/storm-stress-run.jpg)

## Suggested next work for Claude

1. Keep Three.js. Profile real target hardware before changing renderer or engine. Separate CPU simulation/submission from GPU timing; this branch reports only CPU submission plus total wall-frame time.
2. Establish a repeatable fixed-camera benchmark scene with fixed resolution, weather, boat count and warmup. Record median/p95 over at least 30 seconds. Add a large-fleet case before claiming fleet scalability.
3. The city still reads as repeated boxes. Stronger neighborhood silhouettes, distinct storefronts/rooflines, larger authored landmarks and a coherent stylized material palette would improve it more than extra bloom. Characters/animals are still simple segmented primitives.
4. The water still has visible repeating ripple bands at some angles. Per-pixel floor sampling improves foam edges, but the floor map remains about 3.9 m per texel. It can produce rectangular shallow-colour patches and cannot represent fine shoreline features. Higher-resolution local shore data or an analytic shoreline-distance layer is preferable to simply increasing full-world resolution.
5. High remains expensive and reflections can look too mirror-like in sheltered streets. Consider a reduced reflection scene, lower update frequency with matching cached projection, and GPU measurements of post-processing/shadows separately. Do not turn all effects back on in medium without measuring them.
6. Inspect terrain at close shorelines before accepting the lower tessellation everywhere; distance-based terrain LOD is a better long-term replacement if this tradeoff is visible.
7. Camera obstruction currently snaps inward and can become close to the boat. Smooth outward recovery, terrain collision and paused orbit would improve it. The original paused camera does not respond to orbit input; this is still present.
8. Preset switching can compile shaders and stall once. Consider prewarming the actual tier variants behind a loading screen. A saved high preference remains respected; use `?q=medium` when reviewing the new default.
9. Review all boat archetypes/modules after static batching, especially searchlights, oars and rebuilds. The ownership rules in `boat-rendering.js` are intentional: shared caches must never be disposed when one boat disappears.
10. Gameplay issues observed but intentionally left for design: early survival resource costs, substantial damage from small harbor collisions, sparse nearby interactables, and the readability of rescue targets. No fleet-AI or balance conclusions are implied by the renderer work.

## Quick review

```sh
git switch codex/performance-and-clarity
npm ci
npm test
npm run build
npm run dev
```

Open `/?q=medium&profile=1`, start a voyage, wait for compilation/warmup, then compare low/high from the right-click wheel. `U` hides the normal HUD; the explicit developer profile remains visible. This branch does not change the Pages deployment workflow or publish over the current live game.
