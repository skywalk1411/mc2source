#!/usr/bin/env node
/**
 * bsp2mc.js - Convert a compiled GoldSrc or Source .bsp into a Minecraft
 * schematic, with no decompilation step.
 *
 *   node bsp2mc.js de_dust2.bsp --scale 32
 *
 * The two formats need different strategies:
 *
 *   Source (VBSP)  keeps real brushes - LUMP_BRUSHES and LUMP_BRUSHSIDES
 *                  survive compilation - so brush planes feed straight into
 *                  the shared half-space voxelizer.
 *
 *   GoldSrc (v30)  does NOT. Brushes are discarded at compile time, which is
 *                  exactly why GoldSrc decompilers are lossy: they reconstruct
 *                  brushes from the tree. Voxelization doesn't need brushes
 *                  though - it needs "is this point solid", and the BSP tree
 *                  answers that exactly, the same way the engine's collision
 *                  does. Leaf contents give solid/empty/water directly.
 *
 * No dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VMF = path.join(__dirname, 'vmf2mc.js');
if (!fs.existsSync(VMF)) {
  console.error('error: vmf2mc.js must be in the same folder as bsp2mc.js.');
  process.exit(1);
}
const { voxelize, writeMcEdit, writeSponge, nameToLegacy } = require(VMF);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* ------------------------------------------------------------------ *
 * 1. GoldSrc / Quake 1 BSP
 * ------------------------------------------------------------------ */

const GL = { ENTITIES: 0, PLANES: 1, TEXTURES: 2, VERTEXES: 3, NODES: 5,
  TEXINFO: 6, FACES: 7, LEAVES: 10, EDGES: 12, SURFEDGES: 13, MODELS: 14 };

// leaf contents
const C_EMPTY = -1, C_SOLID = -2, C_WATER = -3, C_SLIME = -4, C_LAVA = -5, C_SKY = -6;

function parseGoldSrc(B) {
  const version = B.readInt32LE(0);
  const lump = (i) => {
    const o = 4 + i * 8;
    return { ofs: B.readInt32LE(o), len: B.readInt32LE(o + 4) };
  };
  const slice = (i) => { const l = lump(i); return B.subarray(l.ofs, l.ofs + l.len); };

  const pb = slice(GL.PLANES), planes = [];
  for (let o = 0; o + 20 <= pb.length; o += 20) {
    planes.push({
      n: [pb.readFloatLE(o), pb.readFloatLE(o + 4), pb.readFloatLE(o + 8)],
      d: pb.readFloatLE(o + 12),
    });
  }

  const nb = slice(GL.NODES), nodes = [];
  for (let o = 0; o + 24 <= nb.length; o += 24) {
    nodes.push({
      plane: nb.readInt32LE(o),
      children: [nb.readInt16LE(o + 4), nb.readInt16LE(o + 6)],
      firstFace: nb.readUInt16LE(o + 20), numFaces: nb.readUInt16LE(o + 22),
    });
  }

  const lb = slice(GL.LEAVES), leaves = [];
  for (let o = 0; o + 28 <= lb.length; o += 28) {
    leaves.push({ contents: lb.readInt32LE(o) });
  }

  const mb = slice(GL.MODELS), models = [];
  for (let o = 0; o + 64 <= mb.length; o += 64) {
    models.push({
      mins: [mb.readFloatLE(o), mb.readFloatLE(o + 4), mb.readFloatLE(o + 8)],
      maxs: [mb.readFloatLE(o + 12), mb.readFloatLE(o + 16), mb.readFloatLE(o + 20)],
      headnode: mb.readInt32LE(o + 36),
      firstFace: mb.readInt32LE(o + 56), numFaces: mb.readInt32LE(o + 60),
    });
  }

  const vb = slice(GL.VERTEXES), verts = [];
  for (let o = 0; o + 12 <= vb.length; o += 12) {
    verts.push([vb.readFloatLE(o), vb.readFloatLE(o + 4), vb.readFloatLE(o + 8)]);
  }

  const eb = slice(GL.EDGES), edges = [];
  for (let o = 0; o + 4 <= eb.length; o += 4) edges.push([eb.readUInt16LE(o), eb.readUInt16LE(o + 2)]);

  const sb = slice(GL.SURFEDGES), surfedges = [];
  for (let o = 0; o + 4 <= sb.length; o += 4) surfedges.push(sb.readInt32LE(o));

  const fb = slice(GL.FACES), faces = [];
  for (let o = 0; o + 20 <= fb.length; o += 20) {
    faces.push({
      plane: fb.readUInt16LE(o), side: fb.readUInt16LE(o + 2),
      firstEdge: fb.readInt32LE(o + 4), numEdges: fb.readInt16LE(o + 8),
      texinfo: fb.readInt16LE(o + 10),
    });
  }

  const tib = slice(GL.TEXINFO), texinfo = [];
  for (let o = 0; o + 40 <= tib.length; o += 40) texinfo.push({ miptex: tib.readInt32LE(o + 32) });

  // textures lump: count, offsets[], then miptex records with a 16-byte name
  const tb = slice(GL.TEXTURES), textures = [];
  if (tb.length >= 4) {
    const count = tb.readInt32LE(0);
    for (let i = 0; i < count; i++) {
      const off = tb.readInt32LE(4 + i * 4);
      if (off < 0 || off + 16 > tb.length) { textures.push(''); continue; }
      textures.push(tb.toString('ascii', off, off + 16).replace(/\0.*$/, '').trim().toUpperCase());
    }
  }

  const entities = slice(GL.ENTITIES).toString('ascii').replace(/\0.*$/, '');
  return { kind: 'goldsrc', version, planes, nodes, leaves, models, verts, edges,
    surfedges, faces, texinfo, textures, entities };
}

// Exactly the engine's point classification: descend the tree, read leaf contents.
function makePointContents(m) {
  const headnode = m.models.length ? m.models[0].headnode : 0;
  const { nodes, planes, leaves } = m;
  return (p) => {
    let n = headnode;
    for (let guard = 0; guard < 512; guard++) {
      if (n < 0) {
        const leaf = leaves[-1 - n];
        return leaf ? leaf.contents : C_EMPTY;
      }
      const nd = nodes[n];
      if (!nd) return C_EMPTY;
      const pl = planes[nd.plane];
      if (!pl) return C_EMPTY;
      n = (dot(pl.n, p) - pl.d >= 0) ? nd.children[0] : nd.children[1];
    }
    return C_EMPTY;
  };
}

// Face polygon, walking surfedges (negative index means the edge runs backwards).
function facePoly(m, f) {
  const out = [];
  for (let i = 0; i < f.numEdges; i++) {
    const se = m.surfedges[f.firstEdge + i];
    if (se === undefined) break;
    const e = m.edges[Math.abs(se)];
    if (!e) break;
    const v = m.verts[se >= 0 ? e[0] : e[1]];
    if (v) out.push(v);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. Source BSP
 * ------------------------------------------------------------------ */

const SL = { PLANES: 1, TEXDATA: 2, TEXINFO: 6, BRUSHES: 18, BRUSHSIDES: 19,
  DISPINFO: 26, TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44, ENTITIES: 0 };

const SC_SOLID = 1, SC_WINDOW = 2, SC_GRATE = 8, SC_SLIME = 16, SC_WATER = 32;
const SC_PLAYERCLIP = 0x10000, SC_MONSTERCLIP = 0x20000, SC_DETAIL = 0x8000000;
const SURF_SKY2D = 0x2, SURF_SKY = 0x4, SURF_NODRAW = 0x80, SURF_HINT = 0x100,
  SURF_SKIP = 0x200, SURF_TRIGGER = 0x40;

function parseSource(B) {
  const version = B.readInt32LE(4);
  const lumps = [];
  for (let i = 0; i < 64; i++) {
    const o = 8 + i * 16;
    lumps.push({
      ofs: B.readInt32LE(o), len: B.readInt32LE(o + 4),
      version: B.readInt32LE(o + 8), fourCC: B.readInt32LE(o + 12),
    });
  }
  const slice = (i) => {
    const l = lumps[i];
    if (l.fourCC !== 0) {
      throw new Error(`lump ${i} is LZMA-compressed (console/packed bsp). ` +
        'Only uncompressed PC maps are supported.');
    }
    return B.subarray(l.ofs, l.ofs + l.len);
  };

  const pb = slice(SL.PLANES), planes = [];
  for (let o = 0; o + 20 <= pb.length; o += 20) {
    planes.push({
      n: [pb.readFloatLE(o), pb.readFloatLE(o + 4), pb.readFloatLE(o + 8)],
      d: pb.readFloatLE(o + 12),
    });
  }

  const bb = slice(SL.BRUSHES), brushes = [];
  for (let o = 0; o + 12 <= bb.length; o += 12) {
    brushes.push({
      first: bb.readInt32LE(o), num: bb.readInt32LE(o + 4), contents: bb.readInt32LE(o + 8),
    });
  }

  const sb = slice(SL.BRUSHSIDES), sides = [];
  for (let o = 0; o + 8 <= sb.length; o += 8) {
    sides.push({
      plane: sb.readUInt16LE(o), texinfo: sb.readInt16LE(o + 2),
      dispinfo: sb.readInt16LE(o + 4), bevel: sb.readInt16LE(o + 6),
    });
  }

  const tib = slice(SL.TEXINFO), texinfo = [];
  for (let o = 0; o + 72 <= tib.length; o += 72) {
    texinfo.push({ flags: tib.readInt32LE(o + 64), texdata: tib.readInt32LE(o + 68) });
  }

  const tdb = slice(SL.TEXDATA), texdata = [];
  for (let o = 0; o + 32 <= tdb.length; o += 32) texdata.push({ nameId: tdb.readInt32LE(o + 12) });

  const tsb = slice(SL.TEXDATA_STRING_TABLE), tableOfs = [];
  for (let o = 0; o + 4 <= tsb.length; o += 4) tableOfs.push(tsb.readInt32LE(o));

  const tdata = slice(SL.TEXDATA_STRING_DATA);
  const names = tableOfs.map((off) => {
    if (off < 0 || off >= tdata.length) return '';
    let end = off;
    while (end < tdata.length && tdata[end] !== 0) end++;
    return tdata.toString('ascii', off, end).toUpperCase();
  });

  const disp = slice(SL.DISPINFO);
  const entities = slice(SL.ENTITIES).toString('ascii').replace(/\0.*$/, '');

  return { kind: 'source', version, planes, brushes, sides, texinfo, texdata,
    names, dispCount: Math.floor(disp.length / 176), entities };
}

function sideTexture(m, side) {
  const ti = m.texinfo[side.texinfo];
  if (!ti || ti.texdata < 0) return '';
  const td = m.texdata[ti.texdata];
  if (!td) return '';
  return m.names[td.nameId] || '';
}

/* ------------------------------------------------------------------ *
 * 3. Texture -> block
 * ------------------------------------------------------------------ */

const TEX_RULES = [
  [/LAVA|MAGMA/, 'lava'],
  [/SLIME|TOXIC|NUKE.*GREEN/, 'slime_block'],
  [/WATER|CANAL|OCEAN/, 'water'],
  [/GLASS|WINDOW/, 'glass'],
  [/LIGHT|LAMP|GLOW|FLUOR|WHITE00/, 'glowstone'],
  [/GRATE|GRILL|FENCE|BARS|CHAINLINK/, 'iron_bars'],
  [/GOLD|BRASS/, 'gold_block'],
  [/METAL|STEEL|IRON|VENT|PIPE|DUCT|MACHINE|COMPUTER|PANEL/, 'iron_block'],
  [/WOOD|PLANK|CRATE|BARREL|DOOR/, 'planks'],
  [/CARPET|CLOTH|CURTAIN/, 'wool'],
  [/SAND|DUST|DESERT/, 'sandstone'],
  [/DIRT|MUD|GROUND/, 'dirt'],
  [/GRASS|MOSS|VINE|FOLIAGE/, 'grass_block'],
  [/SNOW|ICE|FROST/, 'snow_block'],
  [/BRICK/, 'bricks'],
  [/MARBLE|TILE|PLASTER|MARB/, 'quartz_block'],
  [/ROCK|STONE|CLIFF|GRANITE|RK\d/, 'cobblestone'],
  [/CONCRETE|CRETE|CEMENT|WALL|FLOOR|CEIL|LAB|OUT_|C\dA\d/, 'stone_bricks'],
];

const TOOL_RE = /^(TOOLS\/|AAATRIGGER|CLIP|SKY|NULL|HINT|SKIP|ORIGIN|BEVEL|NODRAW|TRIGGER)/;

function buildTexResolver(overrideFile) {
  const overrides = overrideFile ? JSON.parse(fs.readFileSync(overrideFile, 'utf8')) : {};
  const cache = new Map();
  const unresolved = new Map();
  return {
    unresolved,
    get(tex) {
      if (!tex) return null;
      if (cache.has(tex)) return cache.get(tex);
      let name = null;
      for (const [k, v] of Object.entries(overrides))
        if (tex.includes(k.toUpperCase())) { name = v; break; }
      if (!name) for (const [re, b] of TEX_RULES) if (re.test(tex)) { name = b; break; }
      if (!name) unresolved.set(tex, (unresolved.get(tex) || 0) + 1);
      const leg = nameToLegacy(name || 'stone');
      const out = leg ? { ...leg, full: name || 'stone' } : null;
      cache.set(tex, out);
      return out;
    },
  };
}

// Local slab/stair tables so GoldSrc ramps still come out as steps.
const SLAB_FOR = {
  stone: [44, 0, 'smooth_stone'], cobblestone: [44, 3, 'cobblestone'],
  bricks: [44, 4, 'brick'], stone_bricks: [44, 5, 'stone_brick'],
  sandstone: [44, 1, 'sandstone'], quartz_block: [44, 7, 'quartz'],
  planks: [126, 0, 'oak'],
};
const STAIR_FOR = {
  stone: [109, 'stone_brick'], cobblestone: [67, 'cobblestone'], bricks: [108, 'brick'],
  stone_bricks: [109, 'stone_brick'], sandstone: [128, 'sandstone'],
  quartz_block: [156, 'quartz'], planks: [53, 'oak'],
};
const FACING = ['east', 'west', 'south', 'north'];

/* ------------------------------------------------------------------ *
 * 4. Main
 * ------------------------------------------------------------------ */

const HELP = `
bsp2mc - GoldSrc / Source .bsp -> Minecraft schematic (no decompile step)

  node bsp2mc.js <map.bsp> [options]

  GoldSrc v30 (Half-Life, CS 1.6, TFC, DoD) and Quake 1 v29 are classified
  through the BSP tree, because those formats discard brushes at compile time.
  Source VBSP (CS:S, HL2, TF2) still stores brushes, which are voxelized
  directly.

  --out <file>          output path (default: map name + .schematic)
  --scale <n>           map units per block (default 32)
  --format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
  --blocks <f.json>     texture substring -> block name overrides
  --liquids solid|skip  keep water/slime/lava volumes (default solid)
  --clip                include clip brushes (Source only)
  --no-slabs            full cubes only, no half-height detection
  --bounds x1,y1,z1,x2,y2,z2   only convert this region, in map units
  --max-cells <n>       refuse maps above this cell count (default 8,000,000)
  --mirror              flip handedness
  --info                report what would be converted, write nothing
`;

function parseArgs(argv) {
  const o = {
    scale: 32, format: 'mcedit', out: null, blocks: null, liquids: 'solid',
    clip: false, slabs: true, bounds: null, maxCells: 8e6, mirror: false, info: false,
  };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const val = () => argv[++i];
    if (!a.startsWith('--')) { files.push(a); continue; }
    switch (a) {
      case '--out': o.out = val(); break;
      case '--scale': o.scale = parseFloat(val()); break;
      case '--format': o.format = val(); break;
      case '--blocks': o.blocks = val(); break;
      case '--liquids': o.liquids = val(); break;
      case '--max-cells': o.maxCells = parseInt(val(), 10); break;
      case '--bounds': {
        const n = val().split(',').map(Number);
        if (n.length !== 6 || n.some(isNaN)) throw new Error('--bounds needs x1,y1,z1,x2,y2,z2');
        o.bounds = n; break;
      }
      case '--clip': o.clip = true; break;
      case '--no-slabs': o.slabs = false; break;
      case '--mirror': o.mirror = true; break;
      case '--info': o.info = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error('Unknown option ' + a);
    }
  }
  o.input = files[0];
  return o;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.input) { console.log(HELP); process.exit(opt.input ? 0 : 1); }

  const B = fs.readFileSync(opt.input);
  const magic = B.toString('ascii', 0, 4);
  let m;
  if (magic === 'VBSP') m = parseSource(B);
  else if (magic === 'IBSP') {
    throw new Error('this is an IBSP file (Quake 3 or Call of Duty), not GoldSrc/Source.\n' +
      '       Use pk32mc.js for Quake 3, or map2mc.js for Call of Duty sources.');
  } else {
    const v = B.readInt32LE(0);
    if (v !== 30 && v !== 29)
      throw new Error(`unrecognised bsp (magic "${magic}", version ${v}). ` +
        'Expected VBSP, or GoldSrc v30 / Quake 1 v29.');
    m = parseGoldSrc(B);
  }

  const tex = buildTexResolver(opt.blocks);
  const S = opt.scale;
  const rock = { ...nameToLegacy('stone'), full: 'stone' };
  const LO = [Infinity, Infinity, Infinity], HI = [-Infinity, -Infinity, -Infinity];

  let brushes = null, pointContents = null;
  let skipped = { sky: 0, clip: 0, nonsolid: 0, degenerate: 0 }, liquidCount = 0;

  if (m.kind === 'source') {
    // Brushes survive compilation: planes straight into the shared voxelizer.
    brushes = [];
    for (const br of m.brushes) {
      const isLiquid = !!(br.contents & (SC_SLIME | SC_WATER));
      const isClip = !!(br.contents & (SC_PLAYERCLIP | SC_MONSTERCLIP)) && !(br.contents & SC_SOLID);
      if (isClip && !opt.clip) { skipped.clip++; continue; }
      if (isLiquid && opt.liquids === 'skip') { skipped.nonsolid++; continue; }
      if (!isLiquid && !isClip && !(br.contents & SC_SOLID)) { skipped.nonsolid++; continue; }

      const planes = [], mats = [];
      let sky = false;
      for (let i = 0; i < br.num; i++) {
        const sd = m.sides[br.first + i];
        if (!sd) continue;
        const pl = m.planes[sd.plane];
        if (!pl) continue;
        const ti = m.texinfo[sd.texinfo];
        const flags = ti ? ti.flags : 0;
        if (flags & (SURF_SKY | SURF_SKY2D)) sky = true;
        // Source planes point outward; the voxelizer wants inward.
        planes.push({ n: [-pl.n[0], -pl.n[1], -pl.n[2]], d: -pl.d });
        if (!(flags & (SURF_NODRAW | SURF_HINT | SURF_SKIP | SURF_TRIGGER))) {
          const t = sideTexture(m, sd);
          if (t && !TOOL_RE.test(t)) mats.push(t);
        }
      }
      if (sky) { skipped.sky++; continue; }
      if (planes.length < 4) { skipped.degenerate++; continue; }

      const verts = brushVerts(planes);
      if (verts.length < 4) { skipped.degenerate++; continue; }

      const counts = new Map();
      for (const t of mats) counts.set(t, (counts.get(t) || 0) + 1);
      let material = '', best = -1;
      for (const [t, c] of counts) if (c > best) { material = t; best = c; }
      if (isLiquid) { material = (br.contents & SC_SLIME) ? 'SLIME' : 'WATER'; liquidCount++; }

      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const v of verts) for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]);
      }
      brushes.push({ planes, lo, hi, material: material || '__NODRAW__' });
    }
    if (!brushes.length) throw new Error('no usable brushes in this bsp');
    for (const b of brushes) for (let k = 0; k < 3; k++) {
      LO[k] = Math.min(LO[k], b.lo[k]); HI[k] = Math.max(HI[k], b.hi[k]);
    }
  } else {
    pointContents = makePointContents(m);
    const mdl = m.models[0];
    for (let k = 0; k < 3; k++) { LO[k] = mdl.mins[k]; HI[k] = mdl.maxs[k]; }
  }

  if (opt.bounds) {
    for (let k = 0; k < 3; k++) {
      LO[k] = Math.max(LO[k], opt.bounds[k]); HI[k] = Math.min(HI[k], opt.bounds[k + 3]);
    }
    if (HI.some((v, k) => v <= LO[k])) throw new Error('--bounds does not overlap any geometry');
  }

  const width = Math.max(1, Math.round((HI[0] - LO[0]) / S));
  const height = Math.max(1, Math.round((HI[2] - LO[2]) / S));
  const length = Math.max(1, Math.round((HI[1] - LO[1]) / S));
  const cells = width * height * length;

  const report = () => {
    console.log(`format         ${m.kind === 'source' ? 'Source VBSP v' + m.version
      : 'GoldSrc/Quake BSP v' + m.version}`);
    if (m.kind === 'source') {
      console.log(`brushes        ${brushes.length} used; skipped ${skipped.sky} sky, ` +
        `${skipped.clip} clip, ${skipped.nonsolid} non-solid, ${skipped.degenerate} degenerate`);
      if (m.dispCount) console.log(`displacements  ${m.dispCount} - surfaces NOT converted`);
    } else {
      console.log(`tree           ${m.nodes.length} nodes, ${m.leaves.length} leaves, ` +
        `${m.faces.length} faces, ${m.textures.length} textures`);
      console.log(`method         BSP leaf contents (no brush lump in this format)`);
    }
    console.log(`bounds         ${Math.round(HI[0] - LO[0])} x ${Math.round(HI[1] - LO[1])} x ${Math.round(HI[2] - LO[2])} units`);
    console.log(`grid at ${S}u    ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells`);
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

  let blocks, data, stateNames, solidCells = 0, slabs = 0, stairs = 0, unresolved;
  const wantStates = opt.format === 'sponge';

  if (m.kind === 'source') {
    const resolver = {
      get(t) {
        if (t === 'WATER') return { ...nameToLegacy('water'), full: 'water' };
        if (t === 'SLIME') return { ...nameToLegacy('slime_block'), full: 'slime_block' };
        return tex.get(t);
      },
    };
    const vopt = { scale: S, mirror: opt.mirror, slabs: opt.slabs,
      nodrawBlock: 'stone', format: opt.format };
    const r = voxelize(brushes, LO, HI, { width, height, length, cells }, vopt,
      resolver, '__NODRAW__');
    ({ blocks, data, stateNames, solidCells, slabs, stairs, unresolved } = r);
  } else {
    // GoldSrc: 8 subsamples per cell against the tree, same shape logic.
    blocks = Buffer.alloc(cells);
    data = Buffer.alloc(cells);
    stateNames = wantStates ? new Array(cells).fill('minecraft:air') : null;
    unresolved = tex.unresolved;
    const idx = (x, y, z) => (y * length + z) * width + x;
    const q = S / 4;
    const pop = (v) => ((v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1));

    // Surface textures: push each face slightly into the solid and tag that cell.
    const faceTex = new Map();
    for (const f of m.faces) {
      const poly = facePoly(m, f);
      if (poly.length < 3) continue;
      const pl = m.planes[f.plane];
      if (!pl) continue;
      const nrm = f.side ? [-pl.n[0], -pl.n[1], -pl.n[2]] : pl.n.slice();
      const ti = m.texinfo[f.texinfo];
      const name = ti ? (m.textures[ti.miptex] || '') : '';
      if (!name || TOOL_RE.test(name)) continue;
      // Sample the polygon as a triangle fan. Density must scale with the
      // triangle: a fixed grid leaves most cells of a large floor untagged.
      for (let t = 1; t + 1 < poly.length; t++) {
        const edge = Math.max(
          Math.hypot(poly[t][0] - poly[0][0], poly[t][1] - poly[0][1], poly[t][2] - poly[0][2]),
          Math.hypot(poly[t + 1][0] - poly[0][0], poly[t + 1][1] - poly[0][1], poly[t + 1][2] - poly[0][2]));
        const N = Math.min(256, Math.max(2, Math.ceil(edge / (S * 0.5))));
        for (let a = 0; a <= N; a++) for (let b = 0; a + b <= N; b++) {
          const u = a / N, v = b / N, w = 1 - u - v;
          const p = [0, 1, 2].map(k => poly[0][k] * w + poly[t][k] * u + poly[t + 1][k] * v
            - nrm[k] * (S * 0.5));
          const bx = Math.floor((p[0] - LO[0]) / S);
          const bz = opt.mirror ? Math.floor((p[1] - LO[1]) / S) : Math.floor((HI[1] - p[1]) / S);
          const by = Math.floor((p[2] - LO[2]) / S);
          if (bx < 0 || by < 0 || bz < 0 || bx >= width || by >= height || bz >= length) continue;
          const i = idx(bx, by, bz);
          if (!faceTex.has(i)) faceTex.set(i, name);
        }
      }
    }

    const SOLIDS = new Set([C_SOLID]);
    if (opt.liquids !== 'skip') { SOLIDS.add(C_WATER); SOLIDS.add(C_SLIME); SOLIDS.add(C_LAVA); }

    for (let by = 0; by < height; by++) {
      for (let bz = 0; bz < length; bz++) {
        for (let bx = 0; bx < width; bx++) {
          const cx = LO[0] + (bx + 0.5) * S;
          const cy = opt.mirror ? LO[1] + (bz + 0.5) * S : HI[1] - (bz + 0.5) * S;
          const cz = LO[2] + (by + 0.5) * S;
          let lm = 0, um = 0, liquid = 0;
          for (let k = 0; k < 4; k++) {
            const dx = (k & 1) ? q : -q, dy = (k & 2) ? q : -q;
            const c1 = pointContents([cx + dx, cy + dy, cz - q]);
            const c2 = pointContents([cx + dx, cy + dy, cz + q]);
            if (SOLIDS.has(c1)) { lm |= 1 << k; if (c1 !== C_SOLID) liquid = c1; }
            if (SOLIDS.has(c2)) { um |= 1 << k; if (c2 !== C_SOLID) liquid = c2; }
          }
          if (!lm && !um) continue;
          const i = idx(bx, by, bz);

          let blk;
          if (liquid) {
            const n = liquid === C_LAVA ? 'lava' : liquid === C_SLIME ? 'slime_block' : 'water';
            blk = { ...nameToLegacy(n), full: n };
          } else {
            const t = faceTex.get(i);
            blk = (t ? tex.get(t) : null) || rock;
          }

          const lo4 = pop(lm), up4 = pop(um);
          const slab = opt.slabs ? SLAB_FOR[blk.full] : null;
          const stair = opt.slabs ? STAIR_FOR[blk.full] : null;
          const dir = (mask) => mask === 0b1010 ? 0 : mask === 0b0101 ? 1
            : mask === 0b0011 ? (opt.mirror ? 3 : 2) : mask === 0b1100 ? (opt.mirror ? 2 : 3) : -1;

          let id = blk.id, dv = blk.data, state = `minecraft:${blk.full}`;
          if (lo4 === 4 && up4 === 2 && stair && dir(um) >= 0) {
            id = stair[0]; dv = dir(um); stairs++;
            state = `minecraft:${stair[1]}_stairs[facing=${FACING[dv]},half=bottom]`;
          } else if (lo4 >= 2 && up4 >= 2) {
            // full cube
          } else if (slab && lo4 >= 2) {
            id = slab[0]; dv = slab[1]; slabs++;
            state = `minecraft:${slab[2]}_slab[type=bottom]`;
          } else if (slab && up4 >= 2) {
            id = slab[0]; dv = slab[1] + 8; slabs++;
            state = `minecraft:${slab[2]}_slab[type=top]`;
          }
          blocks[i] = id & 0xff;
          data[i] = dv & 0x0f;
          if (wantStates) stateNames[i] = state;
          solidCells++;
        }
      }
    }
  }

  const grid = {
    width, height, length, blocks, data,
    stateName: (i) => (stateNames ? stateNames[i] : 'minecraft:stone'),
  };
  const ext = opt.format === 'sponge' ? '.schem' : '.schematic';
  const base = path.basename(opt.input).replace(/\.bsp$/i, '');
  const outFile = opt.out || path.join(path.dirname(opt.input), base + ext);
  fs.writeFileSync(outFile, opt.format === 'sponge' ? writeSponge(grid) : writeMcEdit(grid));

  report();
  console.log(`fill           ${(100 * solidCells / cells).toFixed(2)}% of the grid`);
  console.log(`filled         ${solidCells.toLocaleString()} blocks (${slabs.toLocaleString()} slabs, ${stairs.toLocaleString()} stairs)`);
  console.log(`wrote          ${outFile}`);

  if (m.kind === 'source' && m.dispCount > 0) {
    console.warn(`\n!! ${m.dispCount} displacements were ignored. Sculpted terrain lives in`);
    console.warn('   LUMP_DISPINFO as displaced surfaces, not brush volumes.');
  }
  if (unresolved && unresolved.size) {
    const list = [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.warn(`\n!! ${unresolved.size} texture(s) matched no rule, defaulted to stone:`);
    for (const [t, c] of list) console.warn(`   ${String(c).padStart(7)}  ${t}`);
    console.warn('   Map them with --blocks map.json, e.g. {"C1A0": "stone_bricks"}');
  }
}

// local copy: half-space intersection vertices
function brushVerts(planes) {
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const verts = [];
  for (let a = 0; a < planes.length; a++)
    for (let b = a + 1; b < planes.length; b++)
      for (let c = b + 1; c < planes.length; c++) {
        const [A, Bp, C] = [planes[a], planes[b], planes[c]];
        const det = A.n[0] * (Bp.n[1] * C.n[2] - Bp.n[2] * C.n[1])
          - A.n[1] * (Bp.n[0] * C.n[2] - Bp.n[2] * C.n[0])
          + A.n[2] * (Bp.n[0] * C.n[1] - Bp.n[1] * C.n[0]);
        if (Math.abs(det) < 1e-9) continue;
        const bc = cross(Bp.n, C.n), ca = cross(C.n, A.n), ab = cross(A.n, Bp.n);
        const p = [
          (A.d * bc[0] + Bp.d * ca[0] + C.d * ab[0]) / det,
          (A.d * bc[1] + Bp.d * ca[1] + C.d * ab[1]) / det,
          (A.d * bc[2] + Bp.d * ca[2] + C.d * ab[2]) / det,
        ];
        let ok = true;
        for (const pl of planes) if (dot(pl.n, p) - pl.d < -0.05) { ok = false; break; }
        if (ok) verts.push(p);
      }
  return verts;
}

module.exports = { parseGoldSrc, parseSource, makePointContents };

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}
