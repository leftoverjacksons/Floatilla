# Floatilla

A 3D browser survival game. The sea is rising over a harbor city. You captain a small boat, pull survivors and animals off rooftops, salvage what floats, and grow a floatilla of mismatched, procedurally built boats. By mid-game the harbor and suburbs are gone and you are navigating between skyscrapers.

Built with Three.js + Vite. There are no asset files: terrain, city, boats, people, animals, water, sky and audio are all generated in code.

## Play online

Once GitHub Pages is enabled (Settings → Pages → Source: GitHub Actions), every push to `main` or `claude/brave-thompson-92glte` rebuilds and publishes the game at https://leftoverjacksons.github.io/Floatilla/.

## Run locally

```bash
npm install
```

```bash
npm run dev
```

Open the printed URL. Append `?q=low` for a low-quality mode (no shadows, reduced resolution) on weak GPUs.

## Controls

| Key | Action |
| --- | --- |
| W / S | Throttle lever up / down (below zero = astern). Space = all stop |
| A / D | Rudder |
| R | Raise / furl sails |
| E | Interact: rescue, loot rooftop caches, crew a derelict, hail a boat |
| X | Salvage a derelict for materials |
| C | Workshop: crafting and boat modifications (pauses the game) |
| Tab | Take the helm of another boat; it becomes the lead |
| F | Detach from the floatilla (it anchors), press again to recall it |
| G | Fleet hold / follow |
| L | Searchlight (if fitted) |
| Mouse | Drag to orbit, wheel to zoom |
| T | Time warp ×1 / ×6 / ×30 · P pause · H help |
| K / O | Save / load. Autosaves every 90 s to this browser's local storage; the title screen offers Continue |
| [ / ] | Debug: lower / raise the flood 5 m |

## Systems

- **Flood.** Water level follows a 14-day curve to about 75 m, plus tide and rain surge. Buildings and terrain are static; the water rises over them. Below-waterline surfaces are tinted and the band just above the waterline is wet-stained. City lights go out as the days pass.
- **Water.** Gerstner waves. The four longest waves displace the mesh, and the same function runs on the CPU, so boats ride the waves you see. Shorter waves and wind/rain ripples only affect shading. A baked floor heightmap (terrain + building tops) damps waves in shallow water and draws foam around shores, walls and submerged roofs.
- **Weather.** Clear, overcast, fog, rain and storm, as a Markov chain. Storms become more likely as days pass. Wind direction drifts and gusts, and sea state scales with wind. Includes a day/night cycle, moon, stars, a moving cloud layer, lightning with delayed thunder, and rain.
- **Boats.** Ten archetypes (raft, rowboat, skiff, sloop, trawler, tug, motor yacht, houseboat, barge, schooner, plus raiders). Each hull is lofted from randomized parameters: length, beam, draft, freeboard, bow fineness, deadrise and section shape. Physics: engine thrust (uses fuel), sail force from the apparent-wind angle (no-go zone, best on a reach, heel, gale damage if sails stay up), rowing fallback, quadratic drag with hull-speed limit for displacement hulls, and spring buoyancy for heave/pitch/roll from 5 wave samples. Boats collide with buildings, shoals, submerged roofs, shore, and each other.
- **Modules.** Sail, outboard, storage, shelter, armor, outriggers, net, rain catcher, solar still, planters and searchlight are built onto deck slots. You can also lengthen a hull, which rebuilds its geometry, and build new rafts or rowboats.
- **Crew.** Each person picks their own job: helm, repair, bail, trim sails, row, fish, lookout, or sleep at night. Everyone eats and drinks from shared stores. Morale scales how much work gets done. Animals add morale, and some produce food.
- **Fleet.** Sail-only AI boats beat upwind on alternating close-hauled tacks, switching on a leg timer, at the layline, or when the current tack is blocked. Followers trace the lead boat's wake (breadcrumb trail with pure-pursuit steering and obstacle feelers), so they thread streets behind you. You can detach for recon, call them back, hold position, or switch which boat you captain.
- **World.** Floating supplies, survivors on rooftops near the waterline (they end up in the water when it reaches them, and drown if nobody comes), rooftop caches, derelict boats, NPC survivor boats you can recruit with food, and raiders from day 3. Raiders back off if your boat is well crewed, armored, lit at night, or escorted.

## Code map

`src/main.js` game loop and input · `water.js` waves (GPU + CPU) · `environment.js` time, weather, sky, flood curve · `terrain.js` heightfield + floor map · `city.js` procedural city and colliders · `boat.js` hull lofting, modules, boat physics, crew tasks · `fleet.js` fleet AI, economy, recipes · `world.js` spawning and interactions · `people.js` people and animals · `ui.js` HUD, minimap, workshop · `camera.js`, `audio.js`, `fx.js`.
