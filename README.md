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

---

# vmf2mc

The reverse direction: a Source `.vmf` back into a Minecraft schematic.

```bash
node vmf2mc.js myMap.vmf                      # -> myMap.schematic
node vmf2mc.js myMap.vmf --info               # size check, writes nothing
node vmf2mc.js de_dust2.vmf --scale 48 --format sponge
```

Brushes are convex polyhedra defined by half-spaces, not voxels, so this is a
voxelization rather than a meshing job:

1. Each brush's planes are read, and the inward normals recovered from Source's
   clockwise-from-outside winding.
2. Vertices come from intersecting every plane triple and keeping the points
   that satisfy all half-spaces. That gives an exact bounding box even for
   angled and clipped brushes.
3. Every candidate cell gets **8 subsamples**, 4 in the lower half and 4 in the
   upper. Occupancy accumulates across *all* brushes before any block is
   chosen — deciding per-brush would let a stair's second brush overwrite its
   first.
4. The resulting occupancy pattern picks the block shape: full cube, bottom or
   top slab, or stairs (with facing recovered from which quadrants are filled).

A sloped Source ramp therefore comes back as a proper Minecraft staircase of
full blocks, slabs and stair blocks, rather than a blocky mess.

## Options

```
--out <file>          output path (default: input path with .schematic)
--scale <n>           Source units per block (default 32 — must match the
                      scale the vmf was built at, or geometry will shear)
--format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2). Default mcedit
--profile css|dev     material table to invert (default css)
--blocks <f.json>     extra material -> block name mappings
--mirror              match mc2source's --mirror handedness
--include-tools       keep tools/ brushes (skybox, triggers, clips)
--no-slabs            full cubes only, no half-height detection
--nodraw-block <name> block for fully-buried nodraw brushes (default stone)
--max-cells <n>       refuse maps above this cell count (default 8,000,000)
--info                report what would be converted, write nothing
```

## Round-trip fidelity

Converting `schematic -> vmf -> schematic` on the test map:

| Measure | Result |
|---|---|
| Dimensions | identical (77 × 32 × 76) |
| Occupancy (solid vs air) | **100%** — 0 cells lost, 0 gained |
| Shape (full / slab / stair) | **100%** |
| Block type | **85%** |

Geometry survives exactly. Block *type* doesn't, and that's structural rather
than a bug: the forward material table is many-to-one. `glowstone` and
`redstone_lamp_on` both map to `LIGHTS/WHITE001`, every wool colour maps to one
plaster material, and `emerald_block` / `iron_block` / `diamond_block` share a
metal wall. The reverse can't unpick a collision that the forward pass created.

If you need type-accurate round trips, make the table injective — one material
per block:

```bash
node mc2source.js map.schematic --dump-materials > mats.json
# give each block its own distinct material
node mc2source.js map.schematic --materials mats.json
node vmf2mc.js map.vmf --blocks reverse.json
```

## Two things to watch

- **`--scale` must match.** The reverse has no way to know what scale the VMF
  was authored at. Convert at 32 and reverse at 48 and everything shears.
- **Buried geometry loses its type.** mc2source textures fully-enclosed brush
  faces with `toolsnodraw`, which erases the block identity. Those cells come
  back as `--nodraw-block` (stone by default). Run the forward pass with
  `--no-nodraw` if you want the type preserved — it costs some compile time but
  makes the round trip lossless.

Note that `toolsnodraw` is treated as **solid geometry**, not a tool brush —
it's invisible but you still collide with it. Only skybox, trigger, clip, hint
and similar genuinely non-solid tool textures are dropped.

## Limitations

- **Displacements are ignored.** Terrain built from displacement surfaces won't
  appear. Only brush solids are voxelized.
- **Entities become nothing.** Spawns, lights, props and brush entity behaviour
  are dropped; a `func_door` becomes static blocks.
- **Detail below the grid vanishes.** At `--scale 32`, anything thinner than
  16 units is smaller than the smallest representable shape (a slab).

---

# pk32mc

Quake 3 Arena `.pk3` (or a bare `.bsp`) into a Minecraft schematic.

```bash
node pk32mc.js q3dm17.pk3 --list          # which maps are inside
node pk32mc.js q3dm17.pk3 --info          # size check, writes nothing
node pk32mc.js q3dm17.pk3 --scale 32 --out q3dm17.schematic
```

Requires `vmf2mc.js` and `mc2source.js` in the same folder — it shares their
voxelizer and schematic writers.

## Why this works so well

A `.pk3` is an ordinary ZIP holding `maps/<name>.bsp` in IBSP v46 format. Lump 8
of that BSP stores **brushes as sets of half-space planes** — structurally
identical to Source brushes, just with outward normals instead of inward. Negate
them and the same voxelizer applies unchanged, so Quake ramps come out as
Minecraft slab-and-stair staircases exactly like Source ramps do.

Quake 3 also uses roughly Minecraft-compatible proportions: a Q3 player is 56
units tall against Minecraft's 1.8 blocks, so `--scale 32` gives a natural fit.

## What gets filtered

Brushes are classified by their shader's contents and surface flags:

| Category | Handling |
|---|---|
| `CONTENTS_SOLID` | converted |
| `SURF_SKY` | skipped — the outer shell, same role as `toolsskybox` |
| `CONTENTS_PLAYERCLIP` / `MONSTERCLIP` | skipped unless `--clip` |
| `CONTENTS_LAVA` / `SLIME` / `WATER` | converted to lava / slime / water, or `--liquids skip` |
| trigger, origin, fog, areaportal | skipped |
| `SURF_HINT` / `SURF_SKIP` | skipped |

Shader paths are freeform (`textures/gothic_floor/xstepborder5`), so blocks are
chosen by keyword match — metal, wood, sand, brick, gothic, lava and so on. The
target block names are the ones the slab and stair tables know about, so sloped
brushes still come back as proper steps. Override with JSON:

```bash
echo '{"gothic_floor":"quartz_block","base_wall":"iron_block"}' > blocks.json
node pk32mc.js q3dm17.pk3 --blocks blocks.json
```

Keys match on substring, so `gothic_floor` catches every shader under it.

## Options

```
--out <file>          output path (default: map name + .schematic)
--map <name>          which bsp to use when the pk3 holds several
--list                list the bsp files inside the pk3 and exit
--scale <n>           Quake units per block (default 32)
--format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
--blocks <f.json>     shader substring -> block name overrides
--liquids solid|skip  keep water/lava/slime brushes (default solid)
--clip                also voxelize clip brushes (invisible collision)
--world-only          only model 0; skips doors, platforms and other movers
--no-slabs            full cubes only, no half-height detection
--nodraw-block <name> block for brushes with no drawable surface (stone)
--bounds x1,y1,z1,x2,y2,z2   only convert this region, in Quake units
--max-cells <n>       refuse maps above this cell count (default 8,000,000)
--mirror              flip handedness
--info                report what would be converted, write nothing
```

## The big limitation: bezier patches

Quake 3 uses **bezier patches** for curved geometry — arches, pipes, rounded
terrain, the funnel in q3dm17. These are face type 2, not brushes, so they can't
be voxelized and won't appear. `--info` reports the patch count up front:

```
patches        3 bezier patches - curved surfaces, NOT converted
```

A map that's mostly architecture (q3dm1, q3tourney2) converts nearly complete. A
map leaning on curves loses those parts. This is the same class of problem as
displacements in Source maps.

Also not converted: `.md3` models placed as `misc_model`, since their geometry
lives in separate files, and any brush entity behaviour (doors and lifts become
static blocks wherever they sat at compile time).

---

# t3d2mc

Unreal / Unreal Tournament levels (`.t3d`) into a Minecraft schematic.

```bash
node t3d2mc.js MyLevel.t3d --info
node t3d2mc.js MyLevel.t3d --scale 32 --shell 4 --out MyLevel.schematic
```

Requires `vmf2mc.js` and `mc2source.js` alongside it.

## Getting a .t3d

This tool does **not** read `.unr` / `.ut2` directly. Those are Unreal package
files — name table, import and export tables, variable-length compact indices,
and object serialization that changes between engine versions. Export text
instead:

- **UnrealEd:** File → Export → Unreal Text (`.t3d`)
- **Command line:** `ucc batchexport MyLevel.unr Level t3d ..\Maps`
- **Clipboard:** select all brushes in UnrealEd and Edit → Copy puts `.t3d` on
  the clipboard; paste into a text file.

UnrealEd ships with the games — UnrealEd 2.0 with UT99 GOTY, UnrealEd 3 with
UT2003/2004 — so this costs one menu click and works across engine versions
where a binary parser would need per-version handling.

## Subtractive CSG

This is the real difference from the other two converters. Quake 3 and Source
store **additive** brushes: solid lumps in empty space. Unreal starts with an
infinite solid world and **subtracts** rooms out of it.

Voxels take to that directly — fill the grid with rock, then walk the brushes in
file order clearing cells for `CSG_Subtract` and filling them for `CSG_Add`.
Order matters, which is why brushes are processed exactly as they appear.

Two consequences worth understanding:

**Padding is not optional.** The rock extends beyond the outermost subtract
brush. Size the grid to the brush bounds alone and it stops exactly at the
carve, leaving the level with no walls, floor or ceiling. `--pad` adds margin,
defaulting to `shell + 1`.

**`--shell` controls how much rock you keep.** A converted level is a solid mass
with rooms carved out. `--shell 4` (the default) keeps 4 blocks of rock around
carved space and deletes the rest, giving you a walkable structure instead of a
mostly-solid brick. `--shell 0` keeps the full mass, which is closer to how the
level exists in Unreal.

Subtract brushes also paint their texture onto the rock they expose, so room
surfaces get the right material rather than generic stone.

## Non-convex brushes

Unlike Quake and Source, an Unreal brush need not be convex — L-shaped and
hollow brushes are normal. Convexity is tested per brush (does every vertex
satisfy every plane), then:

- **convex** → half-space test, fast
- **non-convex** → ray casting against the triangulated brush, exact but slower

`--info` reports how many brushes need the slow path.

## Options

```
--out <file>          output path (default: input path with .schematic)
--scale <n>           Unreal units per block (default 32)
--world solid|empty   subtractive (default) or additive-built maps
--shell <n>           keep only n blocks of rock around carved space (default 4)
--pad <n>             rock margin around the level bounds (default shell+1)
--format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
--blocks <f.json>     texture substring -> block name overrides
--movers              include Class=Mover brushes (doors, lifts) as solid
--max-cells <n>       refuse maps above this cell count (default 8,000,000)
--mirror              flip Y handedness
--info                report what would be converted, write nothing
```

## Picking a scale

A UT player is 78 units tall, so true Minecraft proportions would be about 44
units per block. But UT geometry sits on a 16/32/64 grid, and a scale of 44
misaligns every surface, producing ragged walls. `--scale 32` aligns cleanly and
makes the level about 35% larger than life, which is the better trade. Use
`--scale 64` for a more compact result.

## Limitations

- **Rotated and scaled brushes are the least-verified part.** The Unreal
  transform order (PrePivot, MainScale, Rotation, PostScale, Location) is
  applied as written, but was tested only against synthetic maps. `--info`
  reports how many brushes are rotated or scaled so you know whether it matters
  for your level.
- **Semisolid and non-solid brushes are treated as solid.** Their behaviour
  lives in poly flags this tool does not interpret.
- **Terrain, static meshes and decorations are ignored.** UT2003/2004 levels
  lean heavily on static meshes, so they convert far less completely than UT99
  levels, which are almost entirely CSG. This is the same class of problem as
  bezier patches in Quake 3 and props in Source.
- **Movers become static.** A door is converted wherever it sat when exported.

---

# map2mc

Radiant `.map` source files into a Minecraft schematic. Covers **Call of Duty
1/2/4** (CoD Radiant), Quake 1/2/3, and GoldSrc / Half-Life.

```bash
node map2mc.js mp_carentan.map --info
node map2mc.js mp_carentan.map --scale 32 --out carentan.schematic
```

Requires `vmf2mc.js`, `pk32mc.js` and `mc2source.js` alongside it.

## Why .map and not .d3dbsp

Call of Duty ships compiled maps, and every generation is a different problem:

| Title | Container | Map file | Status |
|---|---|---|---|
| CoD1 / UO | `.pk3` (ZIP) | `.d3dbsp` IBSP **v59** | id Tech 3 fork, lumps rearranged |
| CoD2 | `.iwd` (ZIP) | `.d3dbsp` IBSP **v4** | version reset, layout changed again |
| CoD4 | `.iwd` + `.ff` | `.d3dbsp` IBSP **v22** | much content moved into fastfiles |
| WaW and later | `.ff` / `.xpak` | proprietary | compressed, later titles encrypted |

CoD reuses id's `IBSP` magic but rearranges the lumps, so a Quake 3 parser would
read it as garbage rather than failing. `pk32mc.js` now detects these versions
and says so instead:

```
error: this is a Call of Duty 1 / United Offensive .d3dbsp (IBSP v59), not a Quake 3 BSP.
```

Writing per-version `.d3dbsp` parsers from memory, with no sample to verify
against, would be guesswork — and a synthetic test file would only prove the
parser agrees with its own assumptions. `.map` is the documented text format
those BSPs are compiled *from*, and it works across every CoD generation at once.

Sources come from the CoD mod tools (free for CoD1/2/4), community decompilers,
or your own Radiant work.

## Dialects and winding

Three brush dialects are handled: **classic Quake**, **Valve 220** (GoldSrc),
and **brushDef3**. The dialect is auto-detected and reported.

Winding conventions differ between editors and are frequently inconsistent even
within one file. Rather than assume one, each plane is oriented against the
**brush centroid** — which lies inside any convex brush — so the parser is
dialect-agnostic and tolerant of faces that disagree with each other. Brushes
with no defining points (brushDef3) fall back to trying both global signs.

## Tool textures

Radiant tool brushes are compiler hints, not geometry, and are filtered:
`caulk`, `clip`, `playerclip`, `weaponclip`, `nodraw`, `portal`, `hint`, `skip`,
`trigger`, `origin`, `areaportal`, `lightgrid`, `antiportal` and friends. Sky
brushes are dropped as the outer shell. Override with `--tools` and `--sky`.

## Options

```
--out <file>          output path (default: input path with .schematic)
--scale <n>           map units per block (default 32)
--format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
--blocks <f.json>     texture substring -> block name overrides
--tools               also voxelize caulk/clip/nodraw brushes
--sky                 keep sky brushes
--no-entities         skip brush entities (doors, movers)
--no-slabs            full cubes only, no half-height detection
--nodraw-block <name> block for brushes with no visible face (default stone)
--bounds x1,y1,z1,x2,y2,z2   only convert this region, in map units
--max-cells <n>       refuse maps above this cell count (default 8,000,000)
--mirror              flip handedness
--info                report what would be converted, write nothing
```

## Limitations

- **Curves are ignored.** `patchDef2`, `patchDef3` and CoD `mesh` blocks are not
  brushes. Reported in `--info`, same class of loss as bezier patches in Quake 3.
- **Models and static meshes are ignored** — `misc_model`, CoD's XModels. CoD4
  and later lean on these heavily, so they convert less completely than CoD1/2.
- **Brush entities become static**, wherever they sat when the map was saved.
