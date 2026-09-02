# mc2source

Converts a Minecraft `.schematic` into a Source engine map (`.vmf`), ready to
open in Hammer and compile for **Counter-Strike: Source**, or to import into
**Counter-Strike 2**'s Source 2 Hammer.

Node 16+, no dependencies.

```bash
node mc2source.js myMap.schematic              # -> myMap.vmf
node mc2source.js myMap.schematic --info       # just print block stats
node mc2source.js myMap.schematic --scale 48 --profile dev --obj
```

## What it does

| Stage | Detail |
|---|---|
| Parse | Handles both **MCEdit legacy** (`Blocks` + `Data` + `AddBlocks`, numeric IDs) and **Sponge** v1/v2/v3 (`Palette` + varint `BlockData`) schematics. Gzip, zlib or raw NBT. |
| Classify | Plants, torches, rails, redstone wire, signs etc. are dropped. Glass/leaves/fences are kept but marked transparent so they don't hide neighbouring faces. |
| Mesh | **Greedy 3D box merging** — runs of identical blocks collapse into single brushes. Typically 30–60× fewer brushes than one-cube-per-block, which is the difference between a map that compiles and one that blows past VBSP's 8192-brush limit. |
| Sub-blocks | Slabs become half-height brushes (top or bottom half, read from the block's data value / `type=` property). Stairs become two brushes — a half-height slab plus a quarter step on the tall side — so a Minecraft staircase climbs in 16-unit increments instead of 32. Slabs still merge horizontally; stairs don't merge, since a merged run would smear its step across the whole thing. |
| Texture | Block name → Source material, via an editable table. Faces buried inside geometry get `tools/toolsnodraw`. |
| Optimise | Thin brushes become `func_detail` (batched 512 per entity) so VVIS doesn't choke on them. |
| Seal | Wraps everything in a six-brush `toolsskybox` shell, so the map compiles without a leak. |
| Populate | `light_environment`, `sky_camera`, `info_map_parameters`, T/CT spawns snapped to the dominant floor level, and a `func_buyzone` over each spawn cluster. |

## Options

```
--out <file>            output path (default: input path with .vmf)
--scale <n>             Source units per block (default 32)
--profile css|dev       material set (default css)
--materials <f.json>    override/extend the block→material table
--dump-materials        print the active table as JSON and exit
--detail auto|all|none  which brushes become func_detail (default auto)
--detail-min <n>        auto: brushes thinner than n blocks → func_detail (2)
--texscale <n>          texture scale on every face (default 0.25)
--lightmap <n>          luxel size (default 16; use 32 for much faster VRAD)
--sky <name>            skyname keyvalue (default sky_day02_05)
--spawns <n>            spawn points per team (default 10, 0 to skip)
--max-height <n>        ignore blocks above this Y layer
--water solid|skip      how to treat water/lava (default solid)
--mirror                keep MC's handedness (map comes out mirrored)
--no-skybox             skip the sealing shell
--no-nodraw             texture hidden faces normally
--obj                   also write .obj/.mtl
--info                  print schematic stats and exit
```

### Picking a scale

Scales above 36 break stair and slab walkability — see Limitations.

A Source player is 72 units tall and 32 wide. A Minecraft block is nominally
~39 units, but that makes doorways and corridors uncomfortably tight.

- `--scale 32` (default) — 1 block ≈ waist height. A 3-block Minecraft doorway
  is a 96-unit opening: comfortable. Rooms feel roughly Minecraft-sized.
- `--scale 48` — everything feels large and open; good for detailed builds
  where the original 1-block corridors would otherwise be impassable.
- `--scale 64` — "giant world" feel. Watch the ±16384 unit map bounds.

## CS:S workflow

1. Copy the `.vmf` to `.../Counter-Strike Source/cstrike/mapsrc/`.
2. Open it in Hammer, `Alt+P` to check for problems.
3. Run the map (F9). Set VVIS to Normal, VRAD to Fast for the first pass —
   full VRAD on a big voxel map takes a while.
4. In game: `sv_cheats 1; nav_generate` to build a bot navigation mesh.

If the compile reports a leak, the shell didn't seal — check the log's
pointfile and make sure nothing sticks out past the skybox.

## CS2 workflow

Source 2 has no brushes, so a VMF can't be compiled directly. Two routes:

**A. Hammer's VMF import (best for editable geometry).** Source 2 Hammer will
read a legacy VMF and convert the brushes into Source 2 meshes. Materials and
entity classnames won't survive — expect to reassign materials and replace the
spawn entities with CS2's `info_player_terrorist` / `info_player_counterterrorist`.
Run with `--profile dev` for this route, since the CS:S material paths mean
nothing to CS2 anyway.

**B. The `--obj` route (best for a static prop).** The `.obj`/`.mtl` pair
imports into Blender or straight into ModelDoc to become a static prop, which
you then place in a small hand-built Hammer map. Better visual fidelity, but
the geometry isn't editable in Hammer and needs its own collision hull.

Route A is the one you want if you intend to actually play on the layout.

## Materials

The block→material table is a best-effort guess at HL2/CS:S material paths.
Anything the game can't find shows up as the purple-and-black checkerboard,
which is cosmetic and easy to fix:

```bash
node mc2source.js map.schematic --dump-materials > mats.json
# edit mats.json
node mc2source.js map.schematic --materials mats.json
```

Entries are either a string or `{"top": ..., "side": ..., "bottom": ...}`.
Lookup falls back through prefixes, so `red_stained_glass` will find a
`stained_glass` or `glass` entry if there's no exact match. In Hammer you can
also just select one bad face, right-click → *Select All Faces With This
Texture*, and replace them in bulk.

## Limitations

- **Fences, doors, panes and carpets still become full cubes.** Slabs and
  stairs are handled; everything else thinner than a block is not.
- **Step height is tied to `--scale`.** Source's step height is 18 units, so a
  half-block step is only walkable when `--scale` is 36 or below. At the
  default 32 a slab step is 16 units and climbs cleanly; at `--scale 48` it's
  24 units and players have to jump every step. The converter warns you when
  the map contains slabs or stairs and the scale is too high.
- **No bomb site, hostages, or nav mesh.** The map runs as an
  elimination-only round out of the box. Add `func_bomb_target` /
  `info_hostage_spawn` in Hammer, and `nav_generate` in game.
- **Water is a solid brush**, not a `func_water`. Use `--water skip` to leave
  it out and carve it manually.
- **Lighting is one `light_environment`.** Interiors will be dark. Glowstone
  and lit redstone lamps map to bright materials but emit no light — add
  `light` entities, or make those materials emissive in the VRAD pass.
- **Block entities** (chests, furnaces, signs) become plain blocks.
