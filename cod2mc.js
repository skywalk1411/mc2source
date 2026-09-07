#!/usr/bin/env node
/**
 * cod2mc.js - Convert a Call of Duty 1 / United Offensive .bsp (.d3dbsp), or a
 * .pk3 containing one, into a Minecraft schematic.
 *
 *   node cod2mc.js cod2_mp_carentan.pk3
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * CoD reuses Quake 3's "IBSP" magic but is NOT a Quake 3 BSP, so pk32mc.js
 * correctly refuses it. Three things differ, and all three are fatal if you
 * parse a CoD map as Q3:
 *
 *   1. The lump directory is 33 entries of (length, offset) - Q3 uses 17
 *      entries of (offset, length). The two fields are SWAPPED.
 *   2. A brush is 4 bytes { uint16 numSides; uint16 material; } and its sides
 *      are consecutive; there is no firstSide index like Q3's 12-byte brush.
 *   3. The first 6 brushsides are not plane indices at all. They are raw
 *      floats holding the brush's axis-aligned bounds, in the order
 *      minX maxX minY maxY minZ maxZ. Only sides 6.. are plane indices.
 *
 * Every one of those was verified against a real file rather than assumed: the
 * lump table packs contiguously and ends exactly at EOF, sum(numSides) over
 * all 8255 brushes equals the 84222 brushsides in the lump, and the bounds
 * decoded from the 6 axial floats reproduce model 0's stored bounding box
 * exactly. Non-axial planes were checked to be outward-facing (Q3 convention).
 *
 * Requires vmf2mc.js (voxelizer) and pk32mc.js (zip reader) alongside it.
 * No dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VMF = path.join(__dirname, 'vmf2mc.js');
const PK3 = path.join(__dirname, 'pk32mc.js');
for (const [f, n] of [[VMF, 'vmf2mc.js'], [PK3, 'pk32mc.js']]) {
  if (!fs.existsSync(f)) {
    console.error(`error: ${n} must be in the same folder as cod2mc.js.`);
    process.exit(1);
  }
}
const { voxelize, writeMcEdit, writeSponge, nameToLegacy } = require(VMF);
const { readZip } = require(PK3);

/* ------------------------------------------------------------------ *
 * 1. CoD1 / UO BSP (IBSP v59)
 * ------------------------------------------------------------------ */

const LUMP = {
  TEXTURES: 0, PLANES: 2, BRUSHSIDES: 3, BRUSHES: 4,
  TRISOUPS: 6, VERTICES: 7, INDICES: 8, MODELS: 27, ENTITIES: 29,
};

// Contents flags. CoD keeps Q3's low bits and adds its own high ones.
const C_SOLID = 0x1, C_WATER = 0x20, C_LAVA = 0x8, C_SLIME = 0x10;
// Surface flags, Q3-compatible in the bits we care about.
const S_SKY = 0x4, S_NODRAW = 0x80, S_HINT = 0x100, S_SKIP = 0x200;

// Editor-only textures that may be flagged solid but must never become blocks.
const TOOL_TEX = /common\/(trigger|hint|skip|origin|portal|areaportal|nodraw|donotenter)/i;
const CLIP_TEX = /common\/(clip|nosight)/i;

function parseCodBsp(buf) {
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'IBSP') {
    throw new Error(`not an IBSP file (magic "${magic}"). ` +
      'Source/GoldSrc maps go through bsp2mc.js.');
  }
  const version = buf.readInt32LE(4);
  if (version === 46 || version === 47) {
    throw new Error('this is a Quake 3 BSP (IBSP v46), not Call of Duty.\n' +
      '       Use: node pk32mc.js yourmap.pk3');
  }
  if (version !== 59) {
    const known = { 4: 'Call of Duty 2', 22: 'Call of Duty 4' };
    throw new Error(
      `IBSP v${version}${known[version] ? ` (${known[version]})` : ''} is not supported.\n` +
      '       cod2mc.js reads Call of Duty 1 / United Offensive maps (IBSP v59).\n' +
      (known[version]
        ? '       That title rearranged the lumps again and needs its own reader.'
        : '       Unrecognised IBSP version.'));
  }

  // NOTE the field order: CoD stores (length, offset), Q3 stores (offset, length).
  const lump = (i) => {
    const o = 8 + i * 8;
    return { len: buf.readInt32LE(o), off: buf.readInt32LE(o + 4) };
  };

  const T = lump(LUMP.TEXTURES);
  const textures = [];
  for (let o = T.off; o + 72 <= T.off + T.len; o += 72) {
    textures.push({
      name: buf.toString('ascii', o, o + 64).replace(/\0.*$/, ''),
      flags: buf.readUInt32LE(o + 64),
      contents: buf.readUInt32LE(o + 68),
    });
  }

  const P = lump(LUMP.PLANES);
  const planes = [];
  for (let o = P.off; o + 16 <= P.off + P.len; o += 16) {
    planes.push({
      n: [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)],
      d: buf.readFloatLE(o + 12),
    });
  }

  // A brushside is 8 bytes. For sides 0..5 the first 4 bytes are a FLOAT (an
  // axial bound); for sides 6.. they are an INT plane index. Keep both
  // readings and let the brush walker decide which one applies.
  const BS = lump(LUMP.BRUSHSIDES);
  const nSides = Math.floor(BS.len / 8);
  const sideDist = new Float32Array(nSides);
  const sidePlane = new Int32Array(nSides);
  const sideTex = new Int32Array(nSides);
  for (let i = 0; i < nSides; i++) {
    const o = BS.off + i * 8;
    sideDist[i] = buf.readFloatLE(o);
    sidePlane[i] = buf.readInt32LE(o);
    sideTex[i] = buf.readInt32LE(o + 4);
  }

  // Brushes are 4 bytes and their sides are implicit: brush n owns the sides
  // that follow brush n-1's. Accumulate a running offset.
  const B = lump(LUMP.BRUSHES);
  const nBrush = Math.floor(B.len / 4);
  const brushes = [];
  let cursor = 0;
  for (let i = 0; i < nBrush; i++) {
    const n = buf.readUInt16LE(B.off + i * 4);
    brushes.push({ first: cursor, nSides: n, texture: buf.readUInt16LE(B.off + i * 4 + 2) });
    cursor += n;
  }
  if (cursor !== nSides) {
    console.warn(`warning: brush sides sum to ${cursor} but the lump holds ${nSides}. ` +
      'The file may be truncated; continuing.');
  }

  const M = lump(LUMP.MODELS);
  const models = [];
  for (let o = M.off; o + 48 <= M.off + M.len; o += 48) {
    models.push({
      mins: [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)],
      maxs: [buf.readFloatLE(o + 12), buf.readFloatLE(o + 16), buf.readFloatLE(o + 20)],
      brush: buf.readInt32LE(o + 40), nBrushes: buf.readInt32LE(o + 44),
    });
  }

  // Render geometry. CoD brushes carry collision only - what you actually SEE
  // is this triangle soup, and its materials (terrain, ground, grass) often
  // appear on no brushside at all. Keep vertex positions plus the material of
  // the soup each vertex belongs to, so caulk-only collision brushes can be
  // given the material of the surface drawn over them.
  const TS = lump(LUMP.TRISOUPS);
  const V = lump(LUMP.VERTICES);
  const nVert = Math.floor(V.len / 44);
  const vertXYZ = new Float32Array(nVert * 3);
  for (let i = 0; i < nVert; i++) {
    const o = V.off + i * 44;
    vertXYZ[i * 3] = buf.readFloatLE(o);
    vertXYZ[i * 3 + 1] = buf.readFloatLE(o + 4);
    vertXYZ[i * 3 + 2] = buf.readFloatLE(o + 8);
  }
  // Triangles. Indices are trisoup-relative, so add the soup's firstVertex.
  const IX = lump(LUMP.INDICES);
  const nIdx = Math.floor(IX.len / 2);
  const idx = new Uint16Array(nIdx);
  for (let i = 0; i < nIdx; i++) idx[i] = buf.readUInt16LE(IX.off + i * 2);

  let nTri = 0;
  for (let o = TS.off; o + 16 <= TS.off + TS.len; o += 16) nTri += buf.readUInt16LE(o + 10) / 3;
  nTri = Math.floor(nTri);
  const triV = new Int32Array(nTri * 3);
  const triTex = new Int32Array(nTri);
  let t = 0, triSoups = 0;
  for (let o = TS.off; o + 16 <= TS.off + TS.len; o += 16) {
    const mat = buf.readUInt16LE(o);
    const firstVert = buf.readUInt32LE(o + 4);
    const nIc = buf.readUInt16LE(o + 10);
    const firstIdx = buf.readUInt32LE(o + 12);
    triSoups++;
    for (let k = 0; k + 2 < nIc && t < nTri; k += 3, t++) {
      triV[t * 3] = firstVert + idx[firstIdx + k];
      triV[t * 3 + 1] = firstVert + idx[firstIdx + k + 1];
      triV[t * 3 + 2] = firstVert + idx[firstIdx + k + 2];
      triTex[t] = mat;
    }
  }

  const E = lump(LUMP.ENTITIES);
  const entities = buf.toString('ascii', E.off, E.off + E.len).replace(/\0.*$/, '');

  return {
    version, textures, planes, sideDist, sidePlane, sideTex, brushes, models,
    entities, vertXYZ, nVert, triV, triTex, nTri: t, triSoups,
  };
}

/* ------------------------------------------------------------------ *
 * 1b. Surface lookup - "what is drawn on top of this brush?"
 * ------------------------------------------------------------------ */

const CELL = 128;  // spatial-hash cell, in CoD units

// Terrain triangles are often hundreds of units across, so sampling their
// VERTICES misses most columns - a 32-unit column usually contains no vertex
// at all. These queries therefore work on the triangles themselves: project to
// XY, test containment, and interpolate the height.
function buildSurfaceIndex(bsp) {
  const X = bsp.vertXYZ, TV = bsp.triV;
  const grid = new Map();
  const key = (x, y) => x * 100000 + y;

  for (let t = 0; t < bsp.nTri; t++) {
    const a = TV[t * 3] * 3, b = TV[t * 3 + 1] * 3, c = TV[t * 3 + 2] * 3;
    const x0 = Math.min(X[a], X[b], X[c]), x1 = Math.max(X[a], X[b], X[c]);
    const y0 = Math.min(X[a + 1], X[b + 1], X[c + 1]), y1 = Math.max(X[a + 1], X[b + 1], X[c + 1]);
    const cx0 = Math.floor(x0 / CELL), cx1 = Math.floor(x1 / CELL);
    const cy0 = Math.floor(y0 / CELL), cy1 = Math.floor(y1 / CELL);
    // A pathologically large triangle would be pasted into thousands of cells;
    // those are skybox/backdrop pieces and are no use as ground material.
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 4096) continue;
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = key(cx, cy);
        let arr = grid.get(k);
        if (!arr) { arr = []; grid.set(k, arr); }
        arr.push(t);
      }
  }

  // Height of triangle t at (px,py), or null if the point is outside it.
  const heightAt = (t, px, py) => {
    const a = TV[t * 3] * 3, b = TV[t * 3 + 1] * 3, c = TV[t * 3 + 2] * 3;
    const ax = X[a], ay = X[a + 1], bx = X[b], by = X[b + 1], cx = X[c], cy = X[c + 1];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-9) return null;                   // degenerate in plan
    const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
    const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
    const w2 = 1 - w0 - w1;
    const E = -0.001;
    if (w0 < E || w1 < E || w2 < E) return null;
    return w0 * X[a + 2] + w1 * X[b + 2] + w2 * X[c + 2];
  };

  return {
    // The material of the surface covering the column at (px,py), taking the
    // triangle whose height sits closest to zTop. Used per output block, so a
    // road, a grass verge and a courtyard on one ground slab stay distinct.
    materialAt(px, py, zTop, tol) {
      const arr = grid.get(key(Math.floor(px / CELL), Math.floor(py / CELL)));
      if (!arr) return null;
      let bestT = -1, bestD = Infinity;
      for (const t of arr) {
        const z = heightAt(t, px, py);
        if (z === null) continue;
        const dz = Math.abs(z - zTop);
        if (dz < bestD && dz <= tol) { bestD = dz; bestT = t; }
      }
      return bestT < 0 ? null : bsp.textures[bsp.triTex[bestT]];
    },

    // Fallback for brushes we do not tile: the material covering the most of
    // the brush's top face, sampled on a coarse lattice.
    materialFor(lo, hi) {
      const counts = new Map();
      const step = Math.max(16, Math.min(hi[0] - lo[0], hi[1] - lo[1]) / 4);
      for (let px = lo[0] + step / 2; px < hi[0]; px += step)
        for (let py = lo[1] + step / 2; py < hi[1]; py += step) {
          const tex = this.materialAt(px, py, hi[2], 48);
          if (tex) counts.set(tex, (counts.get(tex) || 0) + 1);
        }
      let best = null, bestN = 0;
      for (const [tex, n] of counts) if (n > bestN) { best = tex; bestN = n; }
      return best;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 2. Brush -> inward half-spaces
 * ------------------------------------------------------------------ */

// The voxelizer wants inward normals with inside = dot(n,p) >= d.
// The 6 axial bounds become 6 trivial planes; even sides are mins (n = +axis,
// d = min), odd sides are maxs (n = -axis, d = -max). The remaining sides are
// stored outward (inside = dot(n,p) <= d) exactly as in Q3, so negating n and
// d together flips them inward.
const AXIS_PLANES = [
  [0, [1, 0, 0], 1], [1, [-1, 0, 0], -1],
  [2, [0, 1, 0], 1], [3, [0, -1, 0], -1],
  [4, [0, 0, 1], 1], [5, [0, 0, -1], -1],
];

function brushHalfSpaces(bsp, br) {
  const out = [];
  const texOf = (i) => bsp.textures[bsp.sideTex[i]];

  for (const [k, n, sign] of AXIS_PLANES) {
    const si = br.first + k;
    const t = texOf(si);
    out.push({
      n, d: sign * bsp.sideDist[si],
      material: t ? t.name : '', flags: t ? t.flags : 0,
    });
  }
  for (let k = 6; k < br.nSides; k++) {
    const si = br.first + k;
    const pl = bsp.planes[bsp.sidePlane[si]];
    if (!pl) continue;
    const t = texOf(si);
    out.push({
      n: [-pl.n[0], -pl.n[1], -pl.n[2]], d: -pl.d,
      material: t ? t.name : '', flags: t ? t.flags : 0,
    });
  }
  return out;
}

// The 6 inward half-spaces of an axis-aligned box, in the form the voxelizer
// wants. Used when a big collision brush is cut into per-column tiles.
function boxPlanes(lo, hi) {
  return [
    { n: [1, 0, 0], d: lo[0] }, { n: [-1, 0, 0], d: -hi[0] },
    { n: [0, 1, 0], d: lo[1] }, { n: [0, -1, 0], d: -hi[1] },
    { n: [0, 0, 1], d: lo[2] }, { n: [0, 0, -1], d: -hi[2] },
  ].map(p => ({ ...p, material: '', flags: 0 }));
}

function brushBounds(bsp, br) {
  const d = bsp.sideDist, f = br.first;
  return {
    lo: [d[f], d[f + 2], d[f + 4]],
    hi: [d[f + 1], d[f + 3], d[f + 5]],
  };
}

/* ------------------------------------------------------------------ *
 * 3. Texture name -> Minecraft block
 * ------------------------------------------------------------------ */

// CoD encodes the surface type in the texture name itself:
//   textures/cod2/rock@v_stonewall_01
//                 ^^^^ material prefix before '@'
// That is far more reliable than guessing from the artist's texture name, so
// it is tried first. Names without an '@' fall through to keyword matching.
const MATERIAL_PREFIX = {
  rock: 'cobblestone', stone: 'cobblestone', concrete: 'stone_bricks',
  brick: 'bricks', plaster: 'quartz_block', paper: 'quartz_block',
  wood: 'planks', foliage: 'grass_block', grass: 'grass_block',
  dirt: 'dirt', sand: 'sandstone', gravel: 'cobblestone',
  metal: 'iron_block', metal_masked: 'iron_bars', grate: 'iron_bars',
  glass: 'glass', glass_nosight: 'glass', glass_masked: 'glass',
  cloth: 'wool', carpet: 'wool', flag: 'wool',
  water: 'water', ice: 'snow_block', snow: 'snow_block',
  asphalt: 'stone_bricks', ceramic: 'quartz_block',
};

const NAME_RULES = [
  [/lava|magma/, 'lava'],
  [/water|liquid/, 'water'],
  [/glass|window/, 'glass'],
  [/light|lamp|glow|flare|fluoresc/, 'glowstone'],
  [/grate|mesh|fence|wire|barbed/, 'iron_bars'],
  [/metal|steel|iron|pipe|drain|gutter|tank/, 'iron_block'],
  [/wood|plank|crate|timber|shutter|door|beam/, 'planks'],
  [/carpet|cloth|banner|flag|curtain/, 'wool'],
  [/sand|desert|dune/, 'sandstone'],
  [/dirt|mud|earth|ground/, 'dirt'],
  [/grass|moss|vine|hedge|foliage|tree/, 'grass_block'],
  [/snow|ice|frost/, 'snow_block'],
  [/brick/, 'bricks'],
  [/plaster|wallpaper|wallparer|stucco|marble|tile|white/, 'quartz_block'],
  [/rock|stone|cobble|cliff|granite|roof/, 'cobblestone'],
  [/wall|floor|ceil|trim|support|column|core|blackish/, 'stone_bricks'],
];

const NODRAW_MAT = '__NODRAW__';

// Ground that should have soil under it rather than the generic buried block.
const SOFT_GROUND = /grass|dirt|mud|ground|sand|foliage|gravel/i;
// A synthetic name; it resolves through the 'dirt' material prefix rule above.
const SUBSOIL = 'textures/synthetic/dirt@subsoil';

function buildResolver(overrideFile) {
  const overrides = overrideFile ? JSON.parse(fs.readFileSync(overrideFile, 'utf8')) : {};
  const cache = new Map();
  return {
    get(tex) {
      if (cache.has(tex)) return cache.get(tex);
      let name = null;
      for (const [k, v] of Object.entries(overrides)) {
        if (tex === k || tex.toLowerCase().includes(k.toLowerCase())) { name = v; break; }
      }
      const low = tex.toLowerCase();
      if (!name) {
        const at = low.indexOf('@');
        if (at > 0) {
          const prefix = low.slice(low.lastIndexOf('/', at) + 1, at);
          name = MATERIAL_PREFIX[prefix] || null;
        }
      }
      if (!name) for (const [re, block] of NAME_RULES) if (re.test(low)) { name = block; break; }
      if (!name) { cache.set(tex, null); return null; }
      const leg = nameToLegacy(name);
      const out = leg ? { ...leg, full: name } : null;
      cache.set(tex, out);
      return out;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4. Main
 * ------------------------------------------------------------------ */

const HELP = `
cod2mc - Call of Duty 1 / UO .pk3 / .bsp (IBSP v59) -> Minecraft schematic

  node cod2mc.js <map.pk3|map.bsp> [options]

  --out <file>          output path (default: map name + .schematic)
  --map <name>          which bsp to use when the pk3 holds several
                        (full path, "name.bsp" or bare name all work)
  --list                list the bsp files inside the pk3 and exit
  --scale <n>           CoD units per block (default 32; a CoD player is
                        ~60 units tall, so 32 is roughly Minecraft-proportioned.
                        Lower = more detail and far more blocks)
  --format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
  --blocks <f.json>     texture substring -> block name overrides, as JSON
  --liquids solid|skip  keep water/lava brushes (default solid)
  --clip                also voxelize clip brushes (invisible collision)
  --world-only          only model 0; skips doors and other movers
  --no-slabs            full cubes only, no half-height detection
  --no-surface-materials  do not borrow materials from the render mesh for
                        collision-only (all-caulk) brushes
  --max-tiles <n>       most per-column tiles to cut one wide ground brush
                        into when sampling its materials (default 40000)
  --nodraw-block <name> block for brushes with no drawable surface (stone)
  --bounds x1,y1,z1,x2,y2,z2   only convert this region, in CoD units
  --max-cells <n>       refuse maps above this cell count (default 8,000,000)
  --mirror              flip handedness
  --info                report what would be converted, write nothing
`;

function parseArgs(argv) {
  const o = {
    scale: 32, format: 'mcedit', out: null, map: null, blocks: null,
    liquids: 'solid', clip: false, worldOnly: false, slabs: true,
    nodrawBlock: 'stone', bounds: null, maxCells: 8e6, mirror: false,
    info: false, list: false, surfaceMaterials: true, maxTiles: 40000,
  };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const val = () => argv[++i];
    if (!a.startsWith('--')) { files.push(a); continue; }
    switch (a) {
      case '--out': o.out = val(); break;
      case '--map': o.map = val(); break;
      case '--scale': o.scale = parseFloat(val()); break;
      case '--format': o.format = val(); break;
      case '--blocks': o.blocks = val(); break;
      case '--liquids': o.liquids = val(); break;
      case '--nodraw-block': o.nodrawBlock = val(); break;
      case '--max-cells': o.maxCells = parseInt(val()); break;
      case '--max-tiles': o.maxTiles = parseInt(val()); break;
      case '--bounds': {
        const n = val().split(',').map(Number);
        if (n.length !== 6 || n.some(isNaN)) throw new Error('--bounds needs x1,y1,z1,x2,y2,z2');
        o.bounds = n; break;
      }
      case '--clip': o.clip = true; break;
      case '--world-only': o.worldOnly = true; break;
      case '--no-slabs': o.slabs = false; break;
      case '--no-surface-materials': o.surfaceMaterials = false; break;
      case '--mirror': o.mirror = true; break;
      case '--info': o.info = true; break;
      case '--list': o.list = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error('Unknown option ' + a);
    }
  }
  o.input = files[0];
  return o;
}

function loadBsp(opt) {
  const raw = fs.readFileSync(opt.input);
  if (raw.toString('ascii', 0, 4) === 'IBSP') {
    return {
      bspBuf: raw,
      mapName: path.basename(opt.input).replace(/\.(bsp|d3dbsp)$/i, ''),
    };
  }
  const zip = readZip(raw);
  const bsps = zip.entries.filter(e => /\.(bsp|d3dbsp)$/i.test(e.name));
  if (!bsps.length) throw new Error('no .bsp or .d3dbsp found inside the pk3');
  if (opt.list) {
    console.log(`${bsps.length} map(s) in ${path.basename(opt.input)}:`);
    for (const b of bsps) console.log('  ' + b.name);
    return null;
  }
  let pick = bsps[0];
  if (opt.map) {
    // Accept "maps/mp/foo.bsp", "foo.bsp" or "foo" - all name the same map.
    const norm = (s) => s.toLowerCase().replace(/\\/g, '/').replace(/\.(bsp|d3dbsp)$/, '');
    const want = norm(opt.map);
    pick = bsps.find(b => norm(b.name) === want)
        || bsps.find(b => norm(path.basename(b.name)) === want)
        || bsps.find(b => norm(b.name).endsWith('/' + want));
    if (!pick) throw new Error(`--map "${opt.map}" not in pk3. Try --list.`);
  } else if (bsps.length > 1) {
    console.warn(`note: pk3 has ${bsps.length} maps, using ${pick.name}. Use --list / --map to pick.`);
  }
  return {
    bspBuf: zip.read(pick),
    mapName: path.basename(pick.name).replace(/\.(bsp|d3dbsp)$/i, ''),
  };
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.input) { console.log(HELP); process.exit(opt.input ? 0 : 1); }
  if (opt.blocks && !fs.existsSync(opt.blocks)) {
    console.error(`error: --blocks file not found: ${opt.blocks}`);
    process.exit(1);
  }

  const loaded = loadBsp(opt);
  if (!loaded) return;                       // --list already printed
  const { bspBuf, mapName } = loaded;

  const bsp = parseCodBsp(bspBuf);
  const resolver = buildResolver(opt.blocks);

  let range = { from: 0, to: bsp.brushes.length };
  if (opt.worldOnly && bsp.models.length)
    range = { from: bsp.models[0].brush, to: bsp.models[0].brush + bsp.models[0].nBrushes };

  const surfaces = opt.surfaceMaterials ? buildSurfaceIndex(bsp) : null;

  const brushes = [];
  let skipSky = 0, skipClip = 0, skipTool = 0, skipNonSolid = 0, skipBad = 0;
  let liquidBrushes = 0, fromSurface = 0, tiled = 0;

  for (let bi = range.from; bi < range.to; bi++) {
    const br = bsp.brushes[bi];
    if (!br || br.nSides < 6) { skipBad++; continue; }
    const btex = bsp.textures[br.texture];
    const contents = btex ? btex.contents : 0;
    const bname = btex ? btex.name : '';

    const isLiquid = !!(contents & (C_WATER | C_LAVA | C_SLIME)) || /water|liquid/i.test(bname);
    const isClip = CLIP_TEX.test(bname);

    if (isClip && !opt.clip) { skipClip++; continue; }
    if (isLiquid && opt.liquids === 'skip') { skipNonSolid++; continue; }
    if (!isLiquid && !isClip && !(contents & C_SOLID)) { skipNonSolid++; continue; }
    if (!isClip && TOOL_TEX.test(bname)) { skipTool++; continue; }
    if (btex && (btex.flags & S_SKY)) { skipSky++; continue; }

    const { lo, hi } = brushBounds(bsp, br);
    if (!(hi[0] > lo[0] && hi[1] > lo[1] && hi[2] > lo[2])) { skipBad++; continue; }

    const planes = brushHalfSpaces(bsp, br);
    if (planes.some(p => p.flags & S_SKY)) { skipSky++; continue; }
    if (planes.every(p => p.flags & (S_HINT | S_SKIP))) { skipNonSolid++; continue; }

    // Name the brush after its most common drawable side texture.
    const drawable = planes.filter(p => p.material && !(p.flags & (S_NODRAW | S_HINT | S_SKIP)));
    let material = NODRAW_MAT, best = -1;
    if (drawable.length) {
      const counts = new Map();
      for (const p of drawable) counts.set(p.material, (counts.get(p.material) || 0) + 1);
      for (const [m, c] of counts) if (c > best) { material = m; best = c; }
    } else if (surfaces) {
      // Every side is caulk/nodraw: this is a collision-only brush (ground,
      // terrain base, sealing hull). Ask the render mesh what is drawn on it.
      //
      // A map-wide ground slab would get ONE material for the whole thing,
      // turning every road, field and courtyard into the same block. If the
      // brush is a plain box and wide enough to span different surfaces, cut
      // it into one column per output block and sample each column separately.
      const boxy = br.nSides === 6;
      const wide = (hi[0] - lo[0]) > opt.scale * 4 && (hi[1] - lo[1]) > opt.scale * 4;
      const tiles = boxy && wide
        ? Math.ceil((hi[0] - lo[0]) / opt.scale) * Math.ceil((hi[1] - lo[1]) / opt.scale)
        : 0;

      if (tiles && tiles <= opt.maxTiles) {
        let named = 0;
        const fallback = surfaces.materialFor(lo, hi);
        for (let x = lo[0]; x < hi[0]; x += opt.scale) {
          for (let y = lo[1]; y < hi[1]; y += opt.scale) {
            const tlo = [x, y, lo[2]];
            const thi = [Math.min(x + opt.scale, hi[0]), Math.min(y + opt.scale, hi[1]), hi[2]];
            if (!(thi[0] > tlo[0] && thi[1] > tlo[1])) continue;
            // Sample the render mesh at the middle of this column, near the
            // brush's top face - that is the surface a player walks on.
            const t = surfaces.materialAt(
              (tlo[0] + thi[0]) / 2, (tlo[1] + thi[1]) / 2, hi[2], opt.scale * 2) || fallback;
            if (t) named++;
            const surfMat = t ? t.name : NODRAW_MAT;

            // Only the block you can actually stand on gets the surface
            // material. A ground slab is metres thick; skinning it all in
            // grass would drown the map in one block. What is buried becomes
            // subsoil - dirt under soft ground, otherwise the nodraw block.
            const split = thi[2] - opt.scale;
            if (split > tlo[2]) {
              brushes.push({
                planes: boxPlanes(tlo, [thi[0], thi[1], split]),
                lo: [tlo[0], tlo[1], tlo[2]], hi: [thi[0], thi[1], split],
                material: SOFT_GROUND.test(surfMat) ? SUBSOIL : NODRAW_MAT,
              });
            }
            const top = [tlo[0], tlo[1], Math.max(split, tlo[2])];
            brushes.push({ planes: boxPlanes(top, thi), lo: top, hi: thi, material: surfMat });
          }
        }
        if (named) { fromSurface++; tiled++; }
        continue;                       // tiles replace the original brush
      }

      const t = surfaces.materialFor(lo, hi);
      if (t) { material = t.name; fromSurface++; }
    }
    if (isLiquid) {
      material = (contents & C_LAVA) ? 'textures/liquids/lava' : 'textures/liquids/water';
      liquidBrushes++;
    }

    brushes.push({ planes, lo, hi, material });
  }

  if (!brushes.length) throw new Error('no usable solid brushes found in this bsp');

  const S = opt.scale;
  const LO = [Infinity, Infinity, Infinity], HI = [-Infinity, -Infinity, -Infinity];
  for (const b of brushes) for (let k = 0; k < 3; k++) {
    LO[k] = Math.min(LO[k], b.lo[k]); HI[k] = Math.max(HI[k], b.hi[k]);
  }
  if (opt.bounds) {
    const b = opt.bounds;
    for (let k = 0; k < 3; k++) {
      LO[k] = Math.max(LO[k], b[k]); HI[k] = Math.min(HI[k], b[k + 3]);
    }
    if (HI.some((v, k) => v <= LO[k])) throw new Error('--bounds does not overlap any geometry');
  }
  const width = Math.max(1, Math.round((HI[0] - LO[0]) / S));
  const height = Math.max(1, Math.round((HI[2] - LO[2]) / S));
  const length = Math.max(1, Math.round((HI[1] - LO[1]) / S));
  const cells = width * height * length;

  const spawns = (bsp.entities.match(/mp_\w+_spawn|info_player_\w+/g) || []).length;

  const report = () => {
    console.log(`map            ${mapName} (IBSP v${bsp.version}, Call of Duty 1/UO)`);
    console.log(`brushes        ${brushes.length} used; skipped ${skipSky} sky, ${skipClip} clip, ${skipTool} tool, ${skipNonSolid} non-solid, ${skipBad} degenerate`);
    console.log(`bounds         ${Math.round(HI[0] - LO[0])} x ${Math.round(HI[1] - LO[1])} x ${Math.round(HI[2] - LO[2])} units`);
    console.log(`grid at ${S}u    ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells`);
    if (spawns) console.log(`spawns         ${spawns} spawn entities`);
    if (liquidBrushes) console.log(`liquids        ${liquidBrushes} brushes`);
    if (fromSurface) console.log(`surface mats   ${fromSurface} caulk-only brushes textured from the render mesh` +
      (tiled ? `, ${tiled} of them sampled per column` : ''));
  };

  if (opt.info || cells > opt.maxCells) {
    report();
    if (cells > opt.maxCells) {
      console.error(`\nerror: ${cells.toLocaleString()} cells exceeds --max-cells ${opt.maxCells.toLocaleString()}.`);
      console.error('       Raise --scale, crop with --bounds, or raise --max-cells.');
      process.exit(1);
    }
    if (opt.info) return;
  }

  const vopt = {
    scale: S, mirror: opt.mirror, slabs: opt.slabs,
    nodrawBlock: opt.nodrawBlock, format: opt.format,
  };
  const r = voxelize(brushes, LO, HI, { width, height, length, cells }, vopt, resolver, NODRAW_MAT);

  const grid = {
    width, height, length, blocks: r.blocks, data: r.data,
    stateName: (i) => (r.stateNames ? r.stateNames[i] : 'minecraft:stone'),
  };
  const ext = opt.format === 'sponge' ? '.schem' : '.schematic';
  const outFile = opt.out || path.join(path.dirname(opt.input), mapName + ext);
  fs.writeFileSync(outFile, opt.format === 'sponge' ? writeSponge(grid) : writeMcEdit(grid));

  report();
  console.log(`fill           ${(100 * r.solidCells / cells).toFixed(2)}% of the grid`);
  console.log(`filled         ${r.solidCells.toLocaleString()} blocks (${r.slabs.toLocaleString()} slabs, ${r.stairs.toLocaleString()} stairs)`);
  console.log(`wrote          ${outFile}`);

  if (r.unresolved.size) {
    const list = [...r.unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.warn(`\n!! ${r.unresolved.size} texture(s) matched no rule, defaulted to stone:`);
    for (const [m, c] of list) console.warn(`   ${String(c).padStart(7)}  ${m}`);
    console.warn('   Map them with --blocks map.json, e.g. {"v_stonewall": "cobblestone"}');
  }
  console.log('\nnote: CoD static models (xmodel props - carts, rubble, furniture) are not');
  console.log('      brushes and are not stored as geometry in the BSP, so they are not');
  console.log('      converted. Only brush geometry comes across.');
}

module.exports = {
  parseCodBsp, brushHalfSpaces, brushBounds, boxPlanes,
  buildSurfaceIndex, buildResolver,
};

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}
