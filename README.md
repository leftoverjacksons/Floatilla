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

Open the printed URL. Quality can be switched in-game from the action wheel (Low / Medium / High; remembered per browser). High is the default: planar water reflections, MSAA, bloom, a sky-baked environment map, 4096 px shadows. Append `?q=low` for a low-quality mode (none of those, reduced resolution) on weak GPUs.

## Controls

**Right-click** anywhere opens the action wheel with every command (hover to see what it does; click, or release the right button over an item). The keys below are shortcuts.

| Key | Action |
| --- | --- |
| W / S | Throttle lever up / down (below zero = astern). Space = all stop |
| A / D | Rudder |
| R | Raise / furl sails |
| J | Journal |
| V | Walk the deck / take the helm. On foot, WASD walks relative to the camera, Shift hurries, low cabin tops can be climbed, E pets animals; the boat holds course and throttle |
| E | Interact: rescue, loot rooftop caches, crew a derelict, hail a boat |
| X | Salvage a derelict for materials |
| C | Workshop: crafting and boat modifications (pauses the game) |
| Tab | Take the helm of another boat; it becomes the lead |
| F | Detach from the floatilla (it anchors), press again to recall it |
| G | Fleet hold / follow |
| L | Searchlight (if fitted) |
| Mouse | Left-drag to orbit, wheel to zoom, right-click for the action wheel |
| T | Time warp ×1 / ×6 / ×30 · P pause · H help |
| K / O | Save / load. Autosaves every 90 s to this browser's local storage; the title screen offers Continue |
| [ / ] | Debug: lower / raise the flood 5 m |

## Systems

- **Setting.** A natural, enclosed bay with an irregular coastline, three islands and a narrow mouth to the open sea between two headlands. A meandering river runs down a valley through the town, and a marshy creek comes in from the east; both are navigable well inland. The town grows along roads: riverbank roads, a coast road and lanes climbing the hills. Downtown towers stand at the river mouth, an old town of pitched-roof houses climbs the slopes, and there are warehouses and cranes on the creek quay, piers along the waterfront, and bridges that become barriers as the water nears their decks and then sink.

- **Start.** You, a dog, and a tired 10 m sloop (55% hull, 8 hp auxiliary, one mast, 4 deck slots, 6 berths). Everything else has to be found or built.

- **Pacing.** A game day lasts 20 real minutes. The game opens with the low harbor district already under about 4 m of water, then rises only a few centimetres per hour at first; it reaches about 75 m after roughly two in-game months. Survivors, supplies and derelict boats are sparse and spaced out by timers, derelicts are badly damaged (sluggish and waterlogged until repaired), and every repeat of a module on the same boat costs 1.7× the previous one.
- **Landmarks.** Six set pieces: the breakwater lighthouse, a container ship aground in the bay, a Ferris wheel standing in the harbour, St. Brendan's church (its bell, rung once a day, reveals nearby survivors), Harbor Stadium (enterable once the flood tops its gates, ~6.8 m) and the KFLD relay station (~11 m; one broadcast brings two boats to you). Each gives a one-time haul and a written note; some hold survivors. The Journal (J) tracks them and predicts when the flood will open the rest.
- **Exploration.** The minimap shows only what your crew has spotted (sight range shrinks at night and in fog, grows with lookouts); spotted things stay marked.
- **Flood.** Plus tide and rain surge. Buildings and terrain are static; the water rises over them. Below-waterline surfaces are tinted and the band just above the waterline is wet-stained. City lights go out as the days pass.
- **Water.** An FFT ocean (Tessendorf): a fetch-limited, wind-driven Phillips spectrum is evolved and inverse-FFT'd on the GPU each frame into displacement and derivative textures at three scales (701 m, 97 m and 16 m tiles). Wind changes only amplitudes, never phases, so the sea never slides. Foam comes from the surface Jacobian (where waves fold and break) plus shallow-water edges; light glows through thin crests. The exact rendered height around the camera is read back asynchronously from the GPU for boat buoyancy, with the strongest spectral components evaluated on the CPU further out. A baked floor heightmap calms waves over shallows and submerged roofs.
- **Weather.** Clear, overcast, fog, rain and storm, as a Markov chain. Storms become more likely as days pass. Wind direction drifts and gusts, and sea state scales with wind. Includes a day/night cycle, moon, stars, a moving cloud layer, lightning with delayed thunder, and rain.
- **Wakes.** A 205 m wave field follows your boat and integrates linear deep-water waves driven by hull pressure (Tessendorf's iWave scheme, with a vertical-derivative kernel least-squares fitted to |k|, so waves disperse correctly and moving hulls leave true Kelvin wakes). Hulls push up a bow wave and a trough; white water forms where the hull meets the sea and behind the transom, then thins into lace; the turbulent trail calms the small ripples into a slick. Waves reflect off shores and quays. Bows plunging into waves throw spray and dent the water.
- **Atmosphere.** On medium and high quality, a screen-space pass adds height fog (dense on the water, thinning with altitude, so masts and hills rise out of fog banks), drifting fog banks, a forward-scattering glow around the sun, and light shafts. Rain falls as GPU-animated streaks; storms add visible lightning bolts that light up the fog, and wind-torn spray off the crests.
- **Boats.** Ten archetypes (raft, rowboat, skiff, sloop, trawler, tug, motor yacht, houseboat, barge, schooner, plus raiders). Each hull is lofted from randomized parameters: length, beam, draft, freeboard, bow fineness, deadrise and section shape. Physics: engine thrust (uses fuel), sail force from the apparent-wind angle (no-go zone, best on a reach, heel, gale damage if sails stay up), rowing fallback, quadratic drag with hull-speed limit for displacement hulls, and spring buoyancy for heave/pitch/roll from 5 wave samples. Boats collide with buildings, shoals, submerged roofs, shore, and each other.
- **Modules.** Sail, outboard, storage, shelter, armor, outriggers, net, rain catcher, solar still, planters and searchlight are built onto deck slots. You can also lengthen a hull, which rebuilds its geometry, and build new rafts or rowboats.
- **Crew.** Each person picks their own job: helm, repair, bail, trim sails, row, fish, lookout, or sleep at night. Everyone eats and drinks from shared stores. Morale scales how much work gets done. Animals add morale, and some produce food.
- **Fleet.** Sail-only AI boats beat upwind on alternating close-hauled tacks, switching on a leg timer, at the layline, or when the current tack is blocked. Followers trace the lead boat's wake (breadcrumb trail with pure-pursuit steering and obstacle feelers), so they thread streets behind you. You can detach for recon, call them back, hold position, or switch which boat you captain.
- **World.** Floating supplies, survivors on rooftops near the waterline (they end up in the water when it reaches them, and drown if nobody comes), rooftop caches, derelict boats, NPC survivor boats you can recruit with food, and raiders from day 3. Raiders back off if your boat is well crewed, armored, lit at night, or escorted.

## Models (Blender)

Authored models live in `public/models/` and are generated by Blender scripts in `tools/blender/`, so they can be rebuilt and tweaked in code:

```bash
blender -b --python tools/blender/build_sloop.py -- public/models/sloop.glb preview.png
```

`build_sloop.py` builds the 10 m cruising sloop *Little Ark*: a faired hull with fin keel and spade rudder, paint lines on exact waterline rows, a planked teak deck (texture generated in the script), a cabin trunk with portlights, a spray hood, a cockpit with benches, tiller and winches, a mast with spreaders and standing rigging, rails and lifelines, and fittings. Ambient occlusion is baked into vertex colours with Cycles. Gameplay data (deck height, walkable outline, platforms/walls, helm, rig sizes) travels in the root node's glTF extras in game coordinates, and a `BoomPivot` node carries the boom the game swings. `build_boats.py` (with the shared library `fl_common.py`: parametric hull with paint lines on exact rows, decks, inner skins for open boats and bulwarks, rails, AO bake, export) builds the other ten types:

```bash
blender -b --python tools/blender/build_boats.py -- public/models [previewDir|-] [kind ...]
```

raft, rowboat (with oars the game animates), skiff and raider (outboards with spinning props; the raider has two), trawler (wheelhouse, gantry, net drum, trawl doors, tyres), tug (two-tier wheelhouse, funnel the game smokes from, rope bow fender, tyres, bitts), motor yacht (saloon, flybridge, radar arch, swim platform), houseboat (house with pitched roof, chimney, shutters, porch), barge (containers, deckhouse) and schooner (two masts on two boom pivots, bowsprit, wheel). Every boat uses its model, stretched to its design's length and beam and tinted to its hull colour, with static parts merged per material at load.

## Code map

`src/main.js` game loop and input · `ocean.js` FFT ocean (GPU) and spectrum (CPU) · `water.js` water surface, shading, buoyancy queries · `wake.js` interactive wake simulation · `atmosphere.js` fog, sun glow and light shafts · `models.js` glTF model loading · `environment.js` time, weather, sky, flood curve · `terrain.js` heightfield + floor map · `city.js` procedural city and colliders · `boat.js` hull lofting, modules, boat physics, crew tasks · `fleet.js` fleet AI, economy, recipes · `world.js` spawning and interactions · `people.js` people and animals · `ui.js` HUD, minimap, workshop · `camera.js`, `audio.js`, `fx.js`.
