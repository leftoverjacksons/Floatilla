# Floatilla

A 3D browser sailing game. The sea is rising over a harbour town. You take one boat inland through the drowned valley, level by level, pull people off rooftops, find better boats and gear on the way, and try to reach the high ground. Each level is a stretch of the valley with the water held at one height; it rises between levels, so the bridges, shallows and streets become different chokepoints each time.

Built with Three.js + Vite. Boats and town models are built in Blender by scripts in `tools/blender`; terrain, water, sky and audio are generated in code.

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
| M | Strike / raise the mast (to get under low bridges; no sailing while it is down) |
| Tab | Crew cards |
| E | Interact: rescue, haul rooftop caches, go aboard another boat (move gear, swap boats), hail, leave by an exit |
| X | Strip a boat alongside for materials |
| C | Workshop: repairs and gear (pauses the game) |
| J | Journal |
| V | Walk the deck / take the helm. On foot, WASD walks relative to the camera, Shift hurries, E pets animals |
| L | Searchlight (if fitted) |
| Mouse | Left-drag to orbit, wheel to zoom, right-click for the action wheel |
| T | Time warp ×1 / ×6 / ×30 · P pause · H help |
| [ / ] | Debug: lower / raise the water 1 m |

## The voyage

- **Levels.** Three levels per voyage, chosen by which exit you leave by (`src/levels.js`): **The Harbour** (water 2.4 m) branches to **The Old Town** up the river or **The Works** up the creek (4.0 m), which lead to **The Upper River** or **The Fells** (9 m) and the camp on the high ground. A level's playable area is a set of capsules along the water; near its edge the fog closes in and a current sets you back. Exits are buoys burning orange flare smoke, visible from a kilometre off, and always on the chart.
- **What a level holds.** Placed once from the run's seed: boats at anchor or tied up (each carrying some gear, more and better further in), people on roofs at the waterline, rooftop caches, flotsam, and the odd survivor boat passing through. Nothing respawns.
- **Chokepoints.** Every boat has a measured height above the water (its air draft). Bridges stop anything taller than the room beneath them, so the 14 m sloop must strike her mast (M) to get under; motor boats lower their light masts. Draft decides which flooded streets a boat can enter. The level card and the exit dialog give the lowest bridge on each route and say whether your boat will fit.
- **One boat.** Come alongside any boat and go aboard: compare the two, move gear across (if the other has room), take her (everyone crosses over; your old boat stays at anchor and can be taken back), or strip her for materials. Swapping is never required.
- **Saving.** The voyage is saved when you arrive at each level. Continue or Retry starts the level again with what you had when you arrived.

## Systems

- **Setting.** A natural, enclosed bay with an irregular coastline, three islands and a narrow mouth to the open sea between two headlands. A meandering river runs down a valley through the town, and a marshy creek comes in from the east. Downtown towers stand at the river mouth, an old town of pitched-roof houses climbs the slopes, there are warehouses and cranes on the creek quay, piers along the waterfront, and four high road bridges.
- **Start.** You, a dog, and a tired 10 m sloop: a good sailer with a tall mast, a weak 8 hp auxiliary, 6 berths. Someone is waiting at the end of a pier.
- **Crew.** Each person is a card (Tab): a role from before the flood, two or three traits, a short bio, a history that grows as things happen to them, and a portrait (placeholder until artwork exists: see [docs/portraits.md](docs/portraits.md)). Traits change the boat: Old Salt (points higher, more drive), Mechanic (engine power, fuel), Strong Back (rowing), Sharp Eyes (sight range, early warnings), Pilot (depth and bridge clearance readouts), Carpenter, Nurse, Cook, Steady, Skittish. Some are earned: Storm-tested (a gale under sail), Low-Bridge Hand (under a bridge with the mast struck), Rescuer (hauling someone out of the water). People pick their own jobs: helm, repair, bail, trim, row, fish, lookout, sleep. Everyone eats and drinks from shared stores.
- **Gear.** Mostly found aboard other boats, and moved across when alongside: mast & sail (a jury rig for any hull), outboard, storage, shelter (berths), armour, outriggers, net, rain catcher, solar still, planters, searchlight, mast tabernacle (strike the mast twice as fast) and depth sounder (found only). The workshop can patch the hull and build simple gear from salvage.
- **Landmarks.** The breakwater lighthouse, a container ship aground in the bay, a Ferris wheel in the harbour, St. Brendan's church, Harbor Stadium and the KFLD relay station. Each gives a one-time haul and a written note; some hold survivors.
- **Exploration.** The minimap shows only what your crew has spotted (sight range shrinks at night and in fog, grows with lookouts and sharp eyes); spotted things stay marked. Areas outside the level are dimmed.
- **Water.** An FFT ocean (Tessendorf): a fetch-limited, wind-driven Phillips spectrum is evolved and inverse-FFT'd on the GPU each frame into displacement and derivative textures at three scales (701 m, 97 m and 16 m tiles). Wind changes only amplitudes, never phases, so the sea never slides. Foam comes from the surface Jacobian (where waves fold and break) plus shallow-water edges; light glows through thin crests. The exact rendered height around the camera is read back asynchronously from the GPU for boat buoyancy. A baked floor heightmap calms waves over shallows and submerged roofs. Below-waterline surfaces are tinted and the band just above the waterline is wet-stained; waves break over quays and pier decks near the waterline.
- **Weather.** Clear, overcast, fog, rain and storm, as a Markov chain. Wind direction drifts and gusts, and sea state scales with wind. Includes a day/night cycle, moon, stars, a moving cloud layer, lightning with delayed thunder, and rain. Storms add surge on top of the tide.
- **Wakes.** A 205 m wave field follows your boat and integrates linear deep-water waves driven by hull pressure (Tessendorf's iWave scheme, with a vertical-derivative kernel least-squares fitted to |k|, so waves disperse correctly and moving hulls leave true Kelvin wakes). White water forms where the hull meets the sea and behind the transom, then thins into lace. Waves reflect off shores and quays. Bows plunging into waves throw spray.
- **Atmosphere.** On medium and high quality, a screen-space pass adds height fog (dense on the water, thinning with altitude), drifting fog banks, a forward-scattering glow around the sun, and light shafts. Rain falls as GPU-animated streaks; storms add visible lightning bolts and wind-torn spray.
- **Boats.** Ten archetypes (raft, rowboat, skiff, sloop, trawler, tug, motor yacht, houseboat, barge, schooner, plus raiders). Physics: engine thrust (uses fuel), sail force from the apparent-wind angle (no-go zone, best on a reach, heel, gale damage if sails stay up), rowing fallback, quadratic drag with a hull-speed limit, and spring buoyancy for heave/pitch/roll. Boats collide with buildings, shoals, submerged roofs, bridges (by height), shore and each other.

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

The town is built from a kit (`build_town.py`): five house types, three shops, two warehouses, pier bays and pier ends, stone quay segments (with and without ladders), shipping containers, two cars, broadleaf and pine trees and a lamp post. All of it goes into one `town.glb`, each asset with a detailed and a distant mesh. Base colour times baked ambient occlusion is stored per vertex; a part id per vertex marks what the game tints per instance (walls, roofs, foliage), glass (lit at night while the town has power) and lamps. The game draws each asset with one instanced mesh per 300 m tile, switching tiles to the distant mesh away from the camera.

```bash
blender -b --python tools/blender/build_town.py -- public/models [previewDir]
```

## Code map

`src/main.js` game loop, level start and exits, input · `levels.js` level definitions, playable areas, run state · `crew.js` roles, traits, portraits · `flare.js` exit flare smoke · `ocean.js` FFT ocean (GPU) and spectrum (CPU) · `water.js` water surface, shading, buoyancy queries · `wake.js` interactive wake simulation · `atmosphere.js` fog, sun glow and light shafts · `townkit.js` instanced town models · `waterfront.js` waves breaking over quays · `models.js` glTF model loading · `environment.js` time, weather, sky, flood curve · `terrain.js` heightfield + floor map · `city.js` procedural city and colliders · `boat.js` hull lofting, modules, boat physics, crew tasks · `fleet.js` AI steering, economy, recipes · `world.js` level contents and interactions · `people.js` people and animals · `ui.js` HUD, minimap, workshop, crew cards, boat comparison · `camera.js`, `audio.js`, `fx.js`.
