#!/usr/bin/env node
/**
 * vmf2mc.js - Convert a Source engine map (.vmf) back into a Minecraft
 * .schematic. The inverse of mc2source.js.
 *
 *   node vmf2mc.js input.vmf [options]
 *
 * Brushes are convex polyhedra defined by half-spaces, so this voxelizes:
 * each brush's vertices come from intersecting plane triples, and each
 * candidate cell is tested with 8 subsamples. That subsampling is what lets
 * half-height brushes come back as slabs instead of vanishing or inflating
 * into full blocks.
 *
 * No dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
// mc2source.js supplies the shared block tables. Check it before requiring it:
// older copies run their own CLI parser on load, which swallows our arguments
// and exits with a confusing "Unknown option" before this script even starts.
const MC_PATH = path.join(__dirname, 'mc2source.js');
if (!fs.existsSync(MC_PATH)) {
  console.error('error: mc2source.js must be in the same folder as vmf2mc.js.');
  process.exit(1);
}
if (!fs.readFileSync(MC_PATH, 'utf8').includes('module.exports')) {
  console.error('error: mc2source.js is an older version that does not export its');
  console.error('       block tables. Both scripts must come from the same release -');
  console.error('       re-download mc2source.js and put it next to this file.');
  process.exit(1);
}
const { LEGACY_NAMES, COLORS, COLORED, WOOD, M } = require(MC_PATH);

/* ------------------------------------------------------------------ *
 * 1. VMF parser (Valve KeyValues)
 * ------------------------------------------------------------------ */

function parseVmf(text) {
  let i = 0;
  const n = text.length;

  const skip = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; }
      else return;
    }
  };
  const readString = () => {
    i++; // opening quote
    let s = '';
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\' && text[i + 1] === '"') { s += '"'; i += 2; }
      else s += text[i++];
    }
    i++;
    return s;
  };
  const readWord = () => {
    let s = '';
    while (i < n && !/[\s{}"]/.test(text[i])) s += text[i++];
    return s;
  };

  // A block is { name, kv: Map, children: [] }
  const parseBody = (block) => {
    for (;;) {
      skip();
      if (i >= n) return block;
      if (text[i] === '}') { i++; return block; }
      let key;
      if (text[i] === '"') key = readString();
      else if (text[i] === '{') { i++; continue; }
      else key = readWord();
      if (!key) { i++; continue; }
      skip();
      if (text[i] === '"') {
        block.kv.set(key, readString());
      } else if (text[i] === '{') {
        i++;
        block.children.push(parseBody({ name: key, kv: new Map(), children: [] }));
      }
    }
  };

  const root = { name: '__root__', kv: new Map(), children: [] };
  parseBody(root);
  return root;
}

/* ------------------------------------------------------------------ *
 * 2. Brush geometry: half-spaces -> vertices -> voxels
 * ------------------------------------------------------------------ */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function parsePlane(s) {
  const m = s.match(/\(([^)]*)\)\s*\(([^)]*)\)\s*\(([^)]*)\)/);
  if (!m) return null;
  const pt = (t) => t.trim().split(/\s+/).map(Number);
  return [pt(m[1]), pt(m[2]), pt(m[3])];
}

// Source writes plane points clockwise when viewed from outside, so
// (b-a) x (c-a) points INTO the brush. Interior = dot(n, p) >= dot(n, a).
function brushPlanes(solid) {
  const planes = [];
  for (const side of solid.children) {
    if (side.name !== 'side') continue;
    const p = parsePlane(side.kv.get('plane') || '');
    if (!p) continue;
    const nrm = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
    if (len < 1e-6) continue;
    planes.push({
      n: [nrm[0] / len, nrm[1] / len, nrm[2] / len],
      d: dot([nrm[0] / len, nrm[1] / len, nrm[2] / len], p[0]),
      material: (side.kv.get('material') || '').toUpperCase(),
    });
  }
  return planes;
}

function brushVertices(planes) {
  const verts = [];
  const EPS = 0.05;
  for (let a = 0; a < planes.length; a++)
    for (let b = a + 1; b < planes.length; b++)
      for (let c = b + 1; c < planes.length; c++) {
        const [A, B, C] = [planes[a], planes[b], planes[c]];
        const det =
          A.n[0] * (B.n[1] * C.n[2] - B.n[2] * C.n[1]) -
          A.n[1] * (B.n[0] * C.n[2] - B.n[2] * C.n[0]) +
          A.n[2] * (B.n[0] * C.n[1] - B.n[1] * C.n[0]);
        if (Math.abs(det) < 1e-6) continue;
        const bc = cross(B.n, C.n), ca = cross(C.n, A.n), ab = cross(A.n, B.n);
        const p = [
          (A.d * bc[0] + B.d * ca[0] + C.d * ab[0]) / det,
          (A.d * bc[1] + B.d * ca[1] + C.d * ab[1]) / det,
          (A.d * bc[2] + B.d * ca[2] + C.d * ab[2]) / det,
        ];
        let inside = true;
        for (const pl of planes) if (dot(pl.n, p) - pl.d < -EPS) { inside = false; break; }
        if (inside) verts.push(p);
      }
  return verts;
}

const inside = (planes, p, eps) => {
  for (const pl of planes) if (dot(pl.n, p) - pl.d < -eps) return false;
  return true;
};

/* ------------------------------------------------------------------ *
 * 3. Material -> block mapping (inverse of the forward table)
 * ------------------------------------------------------------------ */

const NAME_TO_ID = (() => {
  const m = new Map();
  for (const [id, name] of Object.entries(LEGACY_NAMES)) {
    if (!m.has(name)) m.set(name, Number(id));
  }
  return m;
})();

// "cyan_wool" -> {id:35, data:9}; "oak_planks" -> {id:5, data:0}
function nameToLegacy(name) {
  let data = 0, base = name;
  const ci = COLORS.findIndex(c => name.startsWith(c + '_'));
  if (ci >= 0) {
    const rest = name.slice(COLORS[ci].length + 1);
    if (COLORED.has(rest)) { base = rest; data = ci; }
  }
  const wi = WOOD.findIndex(w => base.startsWith(w + '_'));
  if (wi >= 0) {
    const rest = base.slice(WOOD[wi].length + 1);
    if (rest === 'planks' || rest === 'log' || rest === 'leaves') { base = rest; data = wi; }
  }
  const id = NAME_TO_ID.get(base);
  if (id === undefined) return null;
  return { id, data, name: base };
}

// Slab equivalents, so a half-height brush comes back as a slab not a cube.
// [legacy id, legacy data, modern block name]
const SLAB_FOR = {
  stone: [44, 0, 'smooth_stone'], cobblestone: [44, 3, 'cobblestone'],
  bricks: [44, 4, 'brick'], stone_bricks: [44, 5, 'stone_brick'],
  sandstone: [44, 1, 'sandstone'], quartz_block: [44, 7, 'quartz'],
  nether_bricks: [44, 6, 'nether_brick'], red_sandstone: [182, 0, 'red_sandstone'],
  purpur_block: [205, 0, 'purpur'], planks: [126, 0, 'oak'], oak_planks: [126, 0, 'oak'],
  spruce_planks: [126, 1, 'spruce'], birch_planks: [126, 2, 'birch'],
  jungle_planks: [126, 3, 'jungle'], acacia_planks: [126, 4, 'acacia'],
  dark_oak_planks: [126, 5, 'dark_oak'],
};

// [legacy id, modern block name]
const STAIR_FOR = {
  stone: [109, 'stone_brick'], cobblestone: [67, 'cobblestone'], bricks: [108, 'brick'],
  stone_bricks: [109, 'stone_brick'], sandstone: [128, 'sandstone'],
  nether_bricks: [114, 'nether_brick'], quartz_block: [156, 'quartz'],
  purpur_block: [203, 'purpur'], red_sandstone: [180, 'red_sandstone'],
  planks: [53, 'oak'], oak_planks: [53, 'oak'], spruce_planks: [134, 'spruce'],
  birch_planks: [135, 'birch'], jungle_planks: [136, 'jungle'],
  acacia_planks: [163, 'acacia'], dark_oak_planks: [164, 'dark_oak'],
};

// Flattening (1.13) renamed or split these; the reverse table yields the old
// generic name, so map it to something that actually exists today.
const MODERN = {
  wool: 'white_wool', terracotta: 'white_terracotta', concrete: 'white_concrete',
  concrete_powder: 'white_concrete_powder', stained_glass: 'white_stained_glass',
  planks: 'oak_planks', log: 'oak_log', leaves: 'oak_leaves',
  redstone_lamp_on: 'redstone_lamp', grass_block: 'grass_block',
  double_stone_slab: 'smooth_stone', double_wooden_slab: 'oak_planks',
  wooden_slab: 'oak_slab', stone_slab: 'smooth_stone_slab',
};
const modern = (n) => MODERN[n] || n;
const FACING = ['east', 'west', 'south', 'north'];

// toolsnodraw is INVISIBLE but SOLID - it is real world geometry and must be
// voxelized. Every other tools/ texture is non-geometry and gets dropped.
const NODRAW = 'TOOLS/TOOLSNODRAW';
const TOOL = /^TOOLS\/(?!TOOLSNODRAW\b)/;

function buildBlockResolver(profile, overrideFile) {
  const table = M[profile] || M.css;
  const rev = new Map();
  const put = (mat, blockName) => {
    if (!mat || typeof mat !== 'string') return;
    const key = mat.toUpperCase();
    if (!rev.has(key)) rev.set(key, blockName);
  };
  for (const [blockName, entry] of Object.entries(table)) {
    if (blockName.startsWith('_')) continue;
    if (typeof entry === 'string') put(entry, blockName);
    else for (const face of ['top', 'side', 'bottom']) put(entry[face], blockName);
  }
  if (overrideFile) {
    for (const [mat, blockName] of Object.entries(JSON.parse(fs.readFileSync(overrideFile, 'utf8'))))
      rev.set(mat.toUpperCase(), blockName);
  }
  return {
    rev,
    get(material) {
      const name = rev.get(material);
      if (!name) return null;
      const leg = nameToLegacy(name);
      return leg ? { ...leg, full: name } : null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4. NBT writer
 * ------------------------------------------------------------------ */

const bytes = [];
class NBTWriter {
  constructor() { this.parts = []; }
  raw(b) { this.parts.push(b); return this; }
  u1(v) { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff); return this.raw(b); }
  i2(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); return this.raw(b); }
  i4(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); return this.raw(b); }
  str(s) {
    const b = Buffer.from(s, 'utf8');
    const h = Buffer.alloc(2); h.writeUInt16BE(b.length);
    return this.raw(h).raw(b);
  }
  named(type, name) { return this.u1(type).str(name); }
  byteArray(name, buf) {
    this.named(7, name).i4(buf.length);
    return this.raw(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }
  short(name, v) { return this.named(2, name).i2(v); }
  int(name, v) { return this.named(3, name).i4(v); }
  string(name, v) { return this.named(8, name).str(v); }
  emptyList(name) { return this.named(9, name).u1(0).i4(0); }
  compoundStart(name) { return this.named(10, name); }
  end() { return this.u1(0); }
  build() { return Buffer.concat(this.parts); }
}

function writeMcEdit(grid) {
  const w = new NBTWriter();
  w.compoundStart('Schematic');
  w.short('Width', grid.width).short('Height', grid.height).short('Length', grid.length);
  w.string('Materials', 'Alpha');
  w.byteArray('Blocks', grid.blocks);
  w.byteArray('Data', grid.data);
  w.emptyList('Entities');
  w.emptyList('TileEntities');
  w.end();
  return zlib.gzipSync(w.build());
}

function varint(v, out) {
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
}

function writeSponge(grid) {
  // Build a palette of "minecraft:name[props]" -> index
  const palette = new Map();
  const data = [];
  for (let i = 0; i < grid.blocks.length; i++) {
    const key = grid.stateName(i);
    let idx = palette.get(key);
    if (idx === undefined) { idx = palette.size; palette.set(key, idx); }
    varint(idx, data);
  }
  const w = new NBTWriter();
  w.compoundStart('Schematic');
  w.int('Version', 2).int('DataVersion', 2586);
  w.short('Width', grid.width).short('Height', grid.height).short('Length', grid.length);
  w.compoundStart('Palette');
  for (const [k, v] of palette) w.int(k, v);
  w.end();
  w.int('PaletteMax', palette.size);
  w.byteArray('BlockData', Buffer.from(data));
  w.emptyList('BlockEntities');
  w.end();
  return zlib.gzipSync(w.build());
}

/* ------------------------------------------------------------------ *
 * Shared voxelizer: brushes (half-spaces) -> a block grid.
 * Used by vmf2mc and by pk32mc (Quake 3 BSP brushes are the same shape).
 * ------------------------------------------------------------------ */

function voxelize(brushes, LO, HI, dims, opt, resolver, NODRAW_MAT) {
  const { width, height, length, cells } = dims;
  const S = opt.scale;
  const unresolved = new Map();

  // Occupancy accumulates across brushes BEFORE any block is decided. A stair
  // is two brushes; deciding per-brush would let the second overwrite the first.
  const blocks = Buffer.alloc(cells);
  const data = Buffer.alloc(cells);
  const wantStates = opt.format === 'sponge';
  const stateNames = wantStates ? new Array(cells).fill('minecraft:air') : null;
  const lowerMask = new Uint8Array(cells);
  const upperMask = new Uint8Array(cells);
  const matIdx = new Int32Array(cells).fill(-1);
  const matScore = new Uint8Array(cells);
  const materials = [];
  const matIds = new Map();
  const idx = (x, y, z) => (y * length + z) * width + x;
  const q = S / 4;
  const popcount = (v) => ((v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1));

  for (const b of brushes) {
    let mi = matIds.get(b.material);
    if (mi === undefined) { mi = materials.length; materials.push(b.material); matIds.set(b.material, mi); }

    // Brushes carry half-space planes; other sources (oriented primitives,
    // meshes) can supply their own containment test instead.
    const test = b.test || ((p) => inside(b.planes, p, 0.01));

    const bx0 = Math.max(0, Math.floor((b.lo[0] - LO[0]) / S));
    const bx1 = Math.min(width - 1, Math.ceil((b.hi[0] - LO[0]) / S));
    const by0 = Math.max(0, Math.floor((b.lo[2] - LO[2]) / S));
    const by1 = Math.min(height - 1, Math.ceil((b.hi[2] - LO[2]) / S));
    const bz0 = Math.max(0, Math.floor((HI[1] - b.hi[1]) / S));
    const bz1 = Math.min(length - 1, Math.ceil((HI[1] - b.lo[1]) / S));

    for (let by = by0; by <= by1; by++) {
      for (let bz = bz0; bz <= bz1; bz++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          const cxw = LO[0] + (bx + 0.5) * S;
          const cyw = opt.mirror ? LO[1] + (bz + 0.5) * S : HI[1] - (bz + 0.5) * S;
          const czw = LO[2] + (by + 0.5) * S;

          let lo = 0, up = 0;
          for (let k = 0; k < 4; k++) {
            const dx = (k & 1) ? q : -q, dy = (k & 2) ? q : -q;
            if (test([cxw + dx, cyw + dy, czw - q])) lo |= 1 << k;
            if (test([cxw + dx, cyw + dy, czw + q])) up |= 1 << k;
          }
          if (!lo && !up) continue;

          const i = idx(bx, by, bz);
          lowerMask[i] |= lo;
          upperMask[i] |= up;
          const score = popcount(lo) + popcount(up);
          if (score > matScore[i]) { matScore[i] = score; matIdx[i] = mi; }
        }
      }
    }
  }

  // quadrant masks -> legacy stair facing (0=+X 1=-X 2=+Zmc 3=-Zmc)
  const stairDir = (mask) => {
    const flip = opt.mirror ? 0 : 1;
    if (mask === 0b1010) return 0;
    if (mask === 0b0101) return 1;
    if (mask === 0b0011) return flip ? 2 : 3;
    if (mask === 0b1100) return flip ? 3 : 2;
    return -1;
  };

  const nodrawBlk = nameToLegacy(opt.nodrawBlock)
    ? { ...nameToLegacy(opt.nodrawBlock), full: opt.nodrawBlock } : null;
  let solidCells = 0, slabs = 0, stairs = 0, buried = 0;
  for (let i = 0; i < cells; i++) {
    const lm = lowerMask[i], um = upperMask[i];
    if (!lm && !um) continue;
    const lo4 = popcount(lm), up4 = popcount(um);

    const mat = matIdx[i] >= 0 ? materials[matIdx[i]] : null;
    let block = mat ? resolver.get(mat) : null;
    if (mat === NODRAW_MAT) { block = nodrawBlk; buried++; }
    else if (mat && !block) unresolved.set(mat, (unresolved.get(mat) || 0) + 1);
    const blk = block || { id: 1, data: 0, name: 'stone', full: 'stone' };
    const slab = opt.slabs ? SLAB_FOR[blk.name] : null;
    const stair = opt.slabs ? STAIR_FOR[blk.name] : null;

    let id = blk.id, dv = blk.data, state = `minecraft:${modern(blk.full || blk.name)}`;

    if (lo4 === 4 && up4 === 2 && stair && stairDir(um) >= 0) {
      const d = stairDir(um); id = stair[0]; dv = d; stairs++;
      state = `minecraft:${stair[1]}_stairs[facing=${FACING[d]},half=bottom]`;
    } else if (up4 === 4 && lo4 === 2 && stair && stairDir(lm) >= 0) {
      const d = stairDir(lm); id = stair[0]; dv = d + 4; stairs++;
      state = `minecraft:${stair[1]}_stairs[facing=${FACING[d]},half=top]`;
    } else if (lo4 >= 2 && up4 >= 2) {
      // full cube - keep blk as-is
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

  return { blocks, data, stateNames, solidCells, slabs, stairs, buried, unresolved };
}

/* ------------------------------------------------------------------ *
 * 5. Main
 * ------------------------------------------------------------------ */

const HELP = `
vmf2mc - Source .vmf -> Minecraft .schematic

  node vmf2mc.js <input.vmf> [options]

  --out <file>          output path (default: input path with .schematic)
  --scale <n>           Source units per block (default 32). For a vmf made by
                        mc2source this MUST match the scale it was built at.
                        For any other map it just sets the resolution: lower
                        = more detail and far more blocks.
  --format mcedit|sponge  output format (default mcedit)
  --profile css|dev     material table to invert (default css)
  --blocks <f.json>     extra material -> block name mappings, as JSON
                        (this is NOT the output path - use --out for that)
  --mirror              match mc2source's --mirror handedness
  --include-tools       keep tools/ brushes (skybox, nodraw, triggers)
  --no-slabs            emit full cubes instead of detecting half-height brushes
  --nodraw-block <name> block for fully-buried nodraw brushes (default stone).
                        Run mc2source with --no-nodraw for a lossless round trip
  --max-cells <n>       refuse maps bigger than this many cells (default 8000000)
  --info                report what would be converted, write nothing
`;

function parseArgs(argv) {
  const o = {
    scale: 32, format: 'mcedit', profile: 'css', blocks: null, out: null,
    mirror: false, includeTools: false, slabs: true, maxCells: 8e6, info: false,
    nodrawBlock: 'stone', bounds: null,
  };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const val = () => argv[++i];
    if (!a.startsWith('--')) { files.push(a); continue; }
    switch (a) {
      case '--out': o.out = val(); break;
      case '--scale': o.scale = parseFloat(val()); break;
      case '--format': o.format = val(); break;
      case '--profile': o.profile = val(); break;
      case '--blocks': o.blocks = val(); break;
      case '--max-cells': o.maxCells = parseInt(val()); break;
      case '--mirror': o.mirror = true; break;
      case '--include-tools': o.includeTools = true; break;
      case '--no-slabs': o.slabs = false; break;
      case '--nodraw-block': o.nodrawBlock = val(); break;
      case '--bounds': {
        const n = val().split(',').map(Number);
        if (n.length !== 6 || n.some(isNaN)) throw new Error('--bounds needs x1,y1,z1,x2,y2,z2');
        o.bounds = n; break;
      }
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

  if (opt.blocks) {
    const hint = () => {
      if (/\.(schematic|schem|vmf|nbt|bsp)$/i.test(opt.blocks))
        console.error('       --blocks takes a JSON material -> block map. For the output\n'
                    + `       path you want:  --out ${opt.blocks}`);
      else
        console.error('       --blocks takes JSON like {"BRICK/BRICKWALL003A": "bricks"}');
    };
    if (!fs.existsSync(opt.blocks)) {
      console.error(`error: --blocks file not found: ${opt.blocks}`); hint(); process.exit(1);
    }
    try { JSON.parse(fs.readFileSync(opt.blocks, 'utf8')); }
    catch { console.error(`error: --blocks file is not valid JSON: ${opt.blocks}`); hint(); process.exit(1); }
  }
  const resolver = buildBlockResolver(opt.profile, opt.blocks);
  const root = parseVmf(fs.readFileSync(opt.input, 'utf8'));

  // --- collect solids from world + every brush entity ---
  const solids = [];
  let props = 0, disps = 0;
  for (const top of root.children) {
    if (top.name === 'world' || top.name === 'entity') {
      const cls = top.kv.get('classname') || '';
      if (/^prop_(static|dynamic|physics|detail)/.test(cls)) props++;
      for (const ch of top.children) {
        if (ch.name !== 'solid') continue;
        for (const side of ch.children)
          if (side.children.some(c => c.name === 'dispinfo')) { disps++; break; }
        solids.push({ solid: ch, cls });
      }
    }
  }
  if (!solids.length) throw new Error('No solids found - is this a .vmf?');

  // --- geometry pass ---
  const brushes = [];
  let skippedTools = 0, skippedBad = 0;
  for (const { solid } of solids) {
    const planes = brushPlanes(solid);
    if (planes.length < 4) { skippedBad++; continue; }

    const mats = planes.map(p => p.material);
    const solidMats = mats.filter(m => !TOOL.test(m));
    if (!solidMats.length && !opt.includeTools) { skippedTools++; continue; }
    // A brush is only "buried" if EVERY face is nodraw; one visible face names it.
    const visible = solidMats.filter(m => m !== NODRAW);
    const named = visible.length ? visible : solidMats;

    const verts = brushVertices(planes);
    if (verts.length < 4) { skippedBad++; continue; }

    // dominant non-tool material, tie-broken by the upward-facing side
    const counts = new Map();
    for (const m of named) counts.set(m, (counts.get(m) || 0) + 1);
    let best = null, bestN = -1;
    for (const [m, c] of counts) if (c > bestN) { best = m; bestN = c; }
    const topSide = planes.find(p => p.n[2] < -0.9 && named.includes(p.material));
    const material = (topSide && counts.get(topSide.material) === bestN)
      ? topSide.material : (best || mats[0]);

    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]);
    }
    brushes.push({ planes, lo, hi, material });
  }
  if (!brushes.length) throw new Error('Every brush was skipped (all tool textures?)');

  // --- grid setup ---
  const S = opt.scale;
  const LO = [Infinity, Infinity, Infinity], HI = [-Infinity, -Infinity, -Infinity];
  for (const b of brushes) for (let k = 0; k < 3; k++) {
    LO[k] = Math.min(LO[k], b.lo[k]); HI[k] = Math.max(HI[k], b.hi[k]);
  }
  if (opt.bounds) {
    const b = opt.bounds;
    LO[0] = Math.max(LO[0], b[0]); LO[1] = Math.max(LO[1], b[1]); LO[2] = Math.max(LO[2], b[2]);
    HI[0] = Math.min(HI[0], b[3]); HI[1] = Math.min(HI[1], b[4]); HI[2] = Math.min(HI[2], b[5]);
    if (HI[0] <= LO[0] || HI[1] <= LO[1] || HI[2] <= LO[2])
      throw new Error('--bounds does not overlap any geometry');
  }
  const width = Math.max(1, Math.round((HI[0] - LO[0]) / S));
  const height = Math.max(1, Math.round((HI[2] - LO[2]) / S));
  const length = Math.max(1, Math.round((HI[1] - LO[1]) / S));
  const cells = width * height * length;

  if (opt.info || cells > opt.maxCells) {
    console.log(`brushes        ${brushes.length} used, ${skippedTools} tool, ${skippedBad} degenerate`);
    console.log(`world bounds   ${(HI[0] - LO[0])} x ${(HI[1] - LO[1])} x ${(HI[2] - LO[2])} units`);
    console.log(`grid at ${S}u    ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells`);
    if (props) console.log(`props          ${props} prop_* entities - MODEL geometry, not converted`);
    if (disps) console.log(`displacements  ${disps} brushes carry dispinfo - surfaces not converted`);
    if (height < 8) console.log(`note           only ${height} blocks tall; this map is very flat for its width`);
    if (cells > opt.maxCells) {
      console.error(`\nerror: ${cells.toLocaleString()} cells exceeds --max-cells ${opt.maxCells.toLocaleString()}.`);
      console.error('       Raise --scale (fewer, bigger blocks) or --max-cells.');
      process.exit(1);
    }
    if (opt.info) return;
  }

  const { blocks, data, stateNames, solidCells, slabs, stairs, buried, unresolved } =
    voxelize(brushes, LO, HI, { width, height, length, cells }, opt, resolver, NODRAW);

  const grid = {
    width, height, length, blocks, data,
    stateName: (i) => stateNames[i],
  };
  const ext = opt.format === 'sponge' ? '.schem' : '.schematic';
  const outFile = opt.out || opt.input.replace(/\.[^.]+$/, '') + ext;
  fs.writeFileSync(outFile, opt.format === 'sponge' ? writeSponge(grid) : writeMcEdit(grid));

  console.log(`input          ${path.basename(opt.input)}`);
  console.log(`brushes        ${brushes.length} used, ${skippedTools} tool, ${skippedBad} degenerate`);
  console.log(`grid           ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells`);
  console.log(`fill           ${(100 * solidCells / cells).toFixed(2)}% of the grid`);
  console.log(`filled         ${solidCells.toLocaleString()} blocks (${slabs.toLocaleString()} slabs, ${stairs.toLocaleString()} stairs)`);
  if (buried) console.log(`buried         ${buried.toLocaleString()} nodraw cells -> ${opt.nodrawBlock}`);
  console.log(`format         ${opt.format}`);
  console.log(`wrote          ${outFile}`);
  if (props) {
    console.warn(`\n!! ${props} prop_* entities were ignored. Their geometry lives in .mdl`);
    console.warn('   model files, not in the vmf, so it cannot be voxelized. If the map');
    console.warn('   gets its detail from props, expect a mostly empty result.');
  }
  if (disps) {
    console.warn(`\n!! ${disps} brushes carry displacements; only their base brush volume is`);
    console.warn('   voxelized, so sculpted terrain will come out flat or missing.');
  }
  if (unresolved.size) {
    const list = [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.warn(`\n!! ${unresolved.size} material(s) had no block mapping, defaulted to stone:`);
    for (const [m, c] of list) console.warn(`   ${String(c).padStart(6)}  ${m}`);
    console.warn('   Add them with --blocks map.json, e.g. {"BRICK/BRICKWALL003A": "bricks"}');
  }
}

module.exports = {
  parseVmf, brushPlanes, brushVertices, nameToLegacy, inside,
  voxelize, writeMcEdit, writeSponge, buildBlockResolver, NBTWriter,
};

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}
