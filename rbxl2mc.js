#!/usr/bin/env node
/**
 * rbxl2mc.js - Convert a Roblox place or model (.rbxlx / .rbxmx) into a
 * Minecraft schematic.
 *
 *   node rbxl2mc.js MyPlace.rbxlx [options]
 *
 * Roblox has no brushes. A place is a tree of Instances whose geometry is
 * oriented primitives: a Part has a Size, a CFrame (position + 3x3 rotation)
 * and a Shape. So instead of half-space planes, each part supplies its own
 * containment test - sample points are transformed into the part's local
 * space, where the test is trivial.
 *
 * Parts also carry real RGB colour rather than texture names, so blocks are
 * chosen by nearest-colour match in Oklab against a Minecraft palette.
 *
 * No dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VMF = path.join(__dirname, 'vmf2mc.js');
if (!fs.existsSync(VMF)) {
  console.error('error: vmf2mc.js must be in the same folder as rbxl2mc.js.');
  process.exit(1);
}
const { voxelize, writeMcEdit, writeSponge, nameToLegacy } = require(VMF);

/* ------------------------------------------------------------------ *
 * 1. Minimal XML reader for .rbxlx
 * ------------------------------------------------------------------ */

// Pulls <Item class="X"> ... <Properties> ... </Properties> blocks. Roblox XML
// is regular enough that a full DOM is unnecessary and much slower on big places.
function parseItems(xml) {
  const items = [];
  const re = /<Item\s+class="([^"]+)"[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const cls = m[1];
    const propStart = xml.indexOf('<Properties>', m.index);
    if (propStart < 0) continue;
    const propEnd = xml.indexOf('</Properties>', propStart);
    if (propEnd < 0) continue;
    items.push({ cls, props: xml.slice(propStart + 12, propEnd) });
  }
  return items;
}

// <float name="Transparency">0.5</float>  ->  "0.5"
function prop(block, names) {
  for (const n of Array.isArray(names) ? names : [names]) {
    const re = new RegExp(`<(\\w+)\\s+name="${n}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
    const m = block.match(re);
    if (m) return m[2];
  }
  return null;
}
const num = (s, d = 0) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : d;
};
// <X>1</X><Y>2</Y><Z>3</Z> and CFrame's R00..R22
const sub = (block, tag, d = 0) => {
  const m = block && block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return m ? num(m[1], d) : d;
};

/* ------------------------------------------------------------------ *
 * 2. Minecraft colour palette + Oklab matching
 * ------------------------------------------------------------------ */

// Approximate average surface colours. These are eyeballed, not sampled from
// game assets - override with --palette if a build comes out off-hue.
const PALETTE = [
  ['white_wool', 233, 236, 236], ['orange_wool', 240, 118, 19],
  ['magenta_wool', 189, 68, 179], ['light_blue_wool', 58, 175, 217],
  ['yellow_wool', 248, 197, 39], ['lime_wool', 112, 185, 25],
  ['pink_wool', 237, 141, 172], ['gray_wool', 62, 68, 71],
  ['light_gray_wool', 142, 142, 134], ['cyan_wool', 21, 137, 145],
  ['purple_wool', 121, 42, 172], ['blue_wool', 53, 57, 157],
  ['brown_wool', 114, 71, 40], ['green_wool', 84, 109, 27],
  ['red_wool', 160, 39, 34], ['black_wool', 20, 21, 25],
  ['white_concrete', 207, 213, 214], ['orange_concrete', 224, 97, 0],
  ['magenta_concrete', 169, 48, 159], ['light_blue_concrete', 35, 137, 198],
  ['yellow_concrete', 240, 175, 21], ['lime_concrete', 94, 168, 24],
  ['pink_concrete', 213, 101, 142], ['gray_concrete', 54, 57, 61],
  ['light_gray_concrete', 125, 125, 115], ['cyan_concrete', 21, 119, 136],
  ['purple_concrete', 100, 31, 156], ['blue_concrete', 44, 46, 143],
  ['brown_concrete', 96, 59, 31], ['green_concrete', 73, 91, 36],
  ['red_concrete', 142, 32, 32], ['black_concrete', 8, 10, 15],
  ['white_terracotta', 209, 178, 161], ['orange_terracotta', 161, 83, 37],
  ['gray_terracotta', 57, 42, 35], ['light_gray_terracotta', 135, 106, 97],
  ['brown_terracotta', 77, 51, 35], ['red_terracotta', 143, 61, 46],
  ['stone', 125, 125, 125], ['cobblestone', 127, 127, 127],
  ['stone_bricks', 122, 122, 122], ['bricks', 150, 97, 83],
  ['sandstone', 216, 203, 155], ['sand', 219, 207, 163],
  ['dirt', 134, 96, 67], ['grass_block', 106, 148, 60],
  ['oak_planks', 162, 130, 78], ['spruce_planks', 114, 84, 48],
  ['birch_planks', 196, 179, 123], ['quartz_block', 236, 233, 226],
  ['iron_block', 220, 220, 220], ['gold_block', 246, 208, 61],
  ['emerald_block', 42, 203, 87], ['diamond_block', 98, 219, 214],
  ['obsidian', 15, 10, 25], ['netherrack', 97, 38, 38],
  ['snow_block', 249, 254, 254], ['packed_ice', 141, 180, 250],
  ['glowstone', 249, 212, 160], ['coal_block', 16, 15, 15],
];

// sRGB -> Oklab. Perceptual distance beats naive RGB Euclidean, which
// mismatches dark and saturated colours badly.
function oklab(r, g, b) {
  const f = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = f(r), G = f(g), B = f(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

// Material families constrain the palette, so a wooden part cannot match to
// bright wool just because the hue is closer.
const FAMILY = {
  wood: /planks|oak|spruce|birch/,
  glass: /glass/,
  neon: /glowstone|sea_lantern/,
  stone: /stone|cobble|brick|terracotta|sand|obsidian|quartz/,
  metal: /iron_block|gold_block|diamond_block|emerald_block|coal_block/,
};

function buildPalette(overrideFile, restrict) {
  let entries = PALETTE;
  if (overrideFile) {
    const j = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
    entries = Object.entries(j).map(([name, rgb]) => [name, rgb[0], rgb[1], rgb[2]]);
  }
  if (restrict) {
    const re = FAMILY[restrict] || new RegExp(restrict);
    const filtered = entries.filter(e => re.test(e[0]));
    if (filtered.length) entries = filtered;
  }
  const lab = entries.map(e => ({ name: e[0], lab: oklab(e[1], e[2], e[3]) }));
  const cache = new Map();
  return {
    match(r, g, b) {
      const key = (r << 16) | (g << 8) | b;
      if (cache.has(key)) return cache.get(key);
      const c = oklab(r, g, b);
      let best = lab[0], bd = Infinity;
      for (const e of lab) {
        const dl = c[0] - e.lab[0], da = c[1] - e.lab[1], db = c[2] - e.lab[2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; best = e; }
      }
      cache.set(key, best.name);
      return best.name;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 3. Roblox part -> oriented primitive
 * ------------------------------------------------------------------ */

// Enum.PartType / Shape tokens. Only the values worth special-casing.
const SHAPE = { 0: 'ball', 1: 'block', 2: 'cylinder', 3: 'block', 4: 'wedge' };

// Enum.Material tokens that are safe to key behaviour off. Anything else is
// reported so it can be mapped explicitly.
const MATERIAL_FAMILY = {
  256: null, 272: null,     // Plastic, SmoothPlastic - colour only
  288: 'neon',              // Neon
  512: 'wood', 528: 'wood', // Wood, WoodPlanks
};

const BRICKCOLOR = {
  1: [242, 243, 243], 21: [196, 40, 28], 23: [13, 105, 172], 24: [245, 205, 48],
  26: [27, 42, 53], 28: [40, 127, 71], 37: [75, 151, 75], 102: [110, 153, 202],
  105: [226, 155, 64], 106: [218, 133, 65], 107: [0, 143, 156], 119: [164, 189, 71],
  135: [116, 134, 157], 141: [39, 70, 45], 151: [123, 158, 121], 192: [105, 64, 40],
  194: [163, 162, 165], 199: [99, 95, 98], 208: [229, 228, 223], 1001: [248, 248, 248],
  1004: [255, 0, 0], 1005: [255, 176, 0], 1006: [180, 128, 255], 1011: [0, 16, 176],
  1013: [0, 32, 96], 1018: [18, 238, 212], 1019: [0, 255, 255], 1020: [0, 255, 0],
  1021: [58, 125, 21], 1022: [127, 142, 100], 1023: [140, 91, 159],
};

function partPrimitive(item, opt) {
  const p = item.props;
  const sizeB = prop(p, ['size', 'Size']);
  const cfB = prop(p, ['CFrame', 'cframe', 'Position']);
  if (!sizeB || !cfB) return null;

  const size = [sub(sizeB, 'X', 1), sub(sizeB, 'Y', 1), sub(sizeB, 'Z', 1)];
  const pos = [sub(cfB, 'X'), sub(cfB, 'Y'), sub(cfB, 'Z')];
  // Rotation matrix, row-major R00..R22. Absent means identity.
  const R = [
    [sub(cfB, 'R00', 1), sub(cfB, 'R01', 0), sub(cfB, 'R02', 0)],
    [sub(cfB, 'R10', 0), sub(cfB, 'R11', 1), sub(cfB, 'R12', 0)],
    [sub(cfB, 'R20', 0), sub(cfB, 'R21', 0), sub(cfB, 'R22', 1)],
  ];

  const transparency = num(prop(p, ['Transparency', 'transparency']), 0);
  const canCollide = (prop(p, ['CanCollide', 'canCollide']) || 'true').trim() !== 'false';

  // colour: Color3uint8 is 0xAARRGGBB packed into an unsigned int
  let rgb = null;
  const c3 = prop(p, ['Color3uint8', 'Color3']);
  if (c3 !== null && /^\s*\d+\s*$/.test(c3)) {
    const v = parseInt(c3.trim(), 10) >>> 0;
    rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  } else if (c3) {
    const r = sub(c3, 'R', -1);
    if (r >= 0) rgb = [Math.round(r * 255), Math.round(sub(c3, 'G') * 255), Math.round(sub(c3, 'B') * 255)];
  }
  if (!rgb) {
    const bc = parseInt((prop(p, ['BrickColor', 'brickColor']) || '').trim(), 10);
    rgb = BRICKCOLOR[bc] || [163, 162, 165];
  }

  const matTok = parseInt((prop(p, ['Material', 'material']) || '').trim(), 10);
  const shapeTok = parseInt((prop(p, ['shape', 'Shape', 'PartType']) || '').trim(), 10);
  let shape = SHAPE[shapeTok] || 'block';
  if (/Wedge/i.test(item.cls)) shape = 'wedge';
  if (/Corner/i.test(item.cls)) shape = 'cornerwedge';

  // Roblox is Y-up; the shared voxelizer expects Z-up. Swap axes here so the
  // Y-up/Z-up difference lives in one place.
  const toWorld = (v) => [v[0], v[2], v[1]];
  const centre = toWorld(pos);

  const half = [size[0] / 2, size[1] / 2, size[2] / 2];
  // Local-space test, applied after transposing the rotation (R is orthonormal).
  const test = (wp) => {
    // centre is [x, robloxZ, robloxY]; wp is world Z-up [x, robloxZ, robloxY]
    const d = [wp[0] - centre[0], wp[2] - centre[2], wp[1] - centre[1]]; // back to Y-up
    const lx = R[0][0] * d[0] + R[1][0] * d[1] + R[2][0] * d[2];
    const ly = R[0][1] * d[0] + R[1][1] * d[1] + R[2][1] * d[2];
    const lz = R[0][2] * d[0] + R[1][2] * d[1] + R[2][2] * d[2];
    switch (shape) {
      case 'ball': {
        const r = Math.min(half[0], half[1], half[2]);
        return lx * lx + ly * ly + lz * lz <= r * r;
      }
      case 'cylinder': {
        const r = Math.min(half[1], half[2]);
        return Math.abs(lx) <= half[0] && ly * ly + lz * lz <= r * r;
      }
      case 'wedge':
        // full height at the -Z face, sloping down to nothing at +Z
        return Math.abs(lx) <= half[0] && Math.abs(ly) <= half[1] && Math.abs(lz) <= half[2]
          && (ly + half[1]) / (2 * half[1]) <= (half[2] - lz) / (2 * half[2]);
      case 'cornerwedge':
        return Math.abs(lx) <= half[0] && Math.abs(ly) <= half[1] && Math.abs(lz) <= half[2]
          && (ly + half[1]) / (2 * half[1]) <= (half[2] - lz) / (2 * half[2])
          && (ly + half[1]) / (2 * half[1]) <= (half[0] - lx) / (2 * half[0]);
      default:
        return Math.abs(lx) <= half[0] && Math.abs(ly) <= half[1] && Math.abs(lz) <= half[2];
    }
  };

  // World AABB: rotate the 8 local corners.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c = [(i & 1 ? 1 : -1) * half[0], (i & 2 ? 1 : -1) * half[1], (i & 4 ? 1 : -1) * half[2]];
    const wx = R[0][0] * c[0] + R[0][1] * c[1] + R[0][2] * c[2] + pos[0];
    const wy = R[1][0] * c[0] + R[1][1] * c[1] + R[1][2] * c[2] + pos[1];
    const wz = R[2][0] * c[0] + R[2][1] * c[1] + R[2][2] * c[2] + pos[2];
    const w = toWorld([wx, wy, wz]);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
  }

  const rotated = Math.abs(R[0][0] - 1) > 1e-6 || Math.abs(R[1][1] - 1) > 1e-6
    || Math.abs(R[2][2] - 1) > 1e-6;

  return {
    lo, hi, test, rgb, transparency, canCollide, shape, rotated,
    family: MATERIAL_FAMILY[matTok] || null, matTok,
  };
}

/* ------------------------------------------------------------------ *
 * 4. Main
 * ------------------------------------------------------------------ */

const HELP = `
rbxl2mc - Roblox place/model (.rbxlx / .rbxmx) -> Minecraft schematic

  node rbxl2mc.js <MyPlace.rbxlx> [options]

  Save XML from Studio: File -> Save to File As, choose .rbxlx (not .rbxl),
  or File -> Export Selection as .rbxmx for a single model.

  --out <file>          output path (default: input path with .schematic)
  --scale <n>           studs per block (default 1: preserves stud detail and
                        makes the build ~2.8x Minecraft scale. Use 3 for
                        roughly player-proportional, at the cost of detail)
  --format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
  --palette <f.json>    replace the colour palette: {"block_name":[r,g,b]}
  --alpha <n>           skip parts with Transparency above this (default 0.5)
  --no-collide          skip CanCollide=false parts (decoration, effects)
  --no-slabs            full cubes only, no half-height detection
  --flip                mirror the build along Z
  --bounds x1,y1,z1,x2,y2,z2   only convert this region, in studs (Y-up)
  --max-cells <n>       refuse places above this cell count (default 8,000,000)
  --info                report what would be converted, write nothing
`;

function parseArgs(argv) {
  const o = {
    scale: 1, format: 'mcedit', out: null, palette: null, alpha: 0.5,
    collide: false, slabs: true, flip: false, bounds: null,
    maxCells: 8e6, info: false,
  };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const val = () => argv[++i];
    if (!a.startsWith('--')) { files.push(a); continue; }
    switch (a) {
      case '--out': o.out = val(); break;
      case '--scale': o.scale = parseFloat(val()); break;
      case '--format': o.format = val(); break;
      case '--palette': o.palette = val(); break;
      case '--alpha': o.alpha = parseFloat(val()); break;
      case '--max-cells': o.maxCells = parseInt(val(), 10); break;
      case '--bounds': {
        const n = val().split(',').map(Number);
        if (n.length !== 6 || n.some(isNaN)) throw new Error('--bounds needs x1,y1,z1,x2,y2,z2');
        o.bounds = n; break;
      }
      case '--no-collide': o.collide = true; break;
      case '--no-slabs': o.slabs = false; break;
      case '--flip': o.flip = true; break;
      case '--info': o.info = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error('Unknown option ' + a);
    }
  }
  o.input = files[0];
  return o;
}

const PART_CLASSES = /^(Part|WedgePart|CornerWedgePart|TrussPart|SpawnLocation|Seat|VehicleSeat|Platform)$/i;

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.input) { console.log(HELP); process.exit(opt.input ? 0 : 1); }

  const head = fs.readFileSync(opt.input, { encoding: null }).subarray(0, 16);
  if (head.toString('ascii', 0, 8) === '<roblox!') {
    console.error('error: this is a BINARY Roblox file (.rbxl / .rbxm).');
    console.error('       The binary format stores properties column-wise in LZ4 chunks with');
    console.error('       interleaved encoding, and varies by version. Save the XML form');
    console.error('       instead: Studio -> File -> Save to File As -> .rbxlx');
    process.exit(1);
  }

  const xml = fs.readFileSync(opt.input, 'utf8');
  const items = parseItems(xml);
  const palette = buildPalette(opt.palette, null);
  const woodPalette = buildPalette(opt.palette, 'wood');

  const parts = [];
  let skipAlpha = 0, skipCollide = 0, unions = 0, meshes = 0, terrain = 0, rotated = 0;
  const matTokens = new Map();

  for (const it of items) {
    if (/^(UnionOperation|NegateOperation|IntersectOperation)$/i.test(it.cls)) { unions++; continue; }
    if (/^MeshPart$/i.test(it.cls)) { meshes++; continue; }
    if (/^Terrain$/i.test(it.cls)) { terrain++; continue; }
    if (!PART_CLASSES.test(it.cls)) continue;

    const pr = partPrimitive(it, opt);
    if (!pr) continue;
    if (pr.transparency > opt.alpha) { skipAlpha++; continue; }
    if (opt.collide && !pr.canCollide) { skipCollide++; continue; }
    if (pr.rotated) rotated++;
    if (Number.isFinite(pr.matTok)) matTokens.set(pr.matTok, (matTokens.get(pr.matTok) || 0) + 1);
    parts.push(pr);
  }

  if (!parts.length) throw new Error('no parts found - is this a Roblox XML place or model?');

  // colour -> block, per part
  for (const pr of parts) {
    const pal = pr.family === 'wood' ? woodPalette : palette;
    pr.blockName = pr.family === 'neon' ? 'glowstone' : pal.match(pr.rgb[0], pr.rgb[1], pr.rgb[2]);
    pr.material = pr.blockName;
  }

  const S = opt.scale;
  const LO = [Infinity, Infinity, Infinity], HI = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let k = 0; k < 3; k++) {
    LO[k] = Math.min(LO[k], p.lo[k]); HI[k] = Math.max(HI[k], p.hi[k]);
  }
  if (opt.bounds) {
    const b = [opt.bounds[0], opt.bounds[2], opt.bounds[1],
      opt.bounds[3], opt.bounds[5], opt.bounds[4]]; // Y-up input -> Z-up
    for (let k = 0; k < 3; k++) {
      LO[k] = Math.max(LO[k], b[k]); HI[k] = Math.min(HI[k], b[k + 3]);
    }
    if (HI.some((v, k) => v <= LO[k])) throw new Error('--bounds does not overlap any parts');
  }
  const width = Math.max(1, Math.round((HI[0] - LO[0]) / S));
  const height = Math.max(1, Math.round((HI[2] - LO[2]) / S));
  const length = Math.max(1, Math.round((HI[1] - LO[1]) / S));
  const cells = width * height * length;

  const shapes = {};
  for (const p of parts) shapes[p.shape] = (shapes[p.shape] || 0) + 1;

  const report = () => {
    console.log(`instances      ${items.length} in file`);
    console.log(`parts          ${parts.length} used (${Object.entries(shapes).map(([k, v]) => `${v} ${k}`).join(', ')})`);
    console.log(`skipped        ${skipAlpha} transparent, ${skipCollide} non-colliding, ${unions} union, ${meshes} meshpart, ${terrain} terrain`);
    console.log(`bounds         ${Math.round(HI[0] - LO[0])} x ${Math.round(HI[1] - LO[1])} x ${Math.round(HI[2] - LO[2])} studs`);
    console.log(`grid at ${S}/stud ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells`);
    if (rotated) console.log(`rotated        ${rotated} parts have a non-identity CFrame`);
  };

  if (opt.info || cells > opt.maxCells) {
    report();
    if (cells > opt.maxCells) {
      console.error(`\nerror: ${cells.toLocaleString()} cells exceeds --max-cells ${opt.maxCells.toLocaleString()}.`);
      console.error('       Raise --scale (fewer, bigger blocks), crop with --bounds, or raise --max-cells.');
      process.exit(1);
    }
    if (opt.info) return;
  }

  // resolver over block names the parts already carry
  const resolver = {
    get(name) {
      const leg = nameToLegacy(name);
      return leg ? { ...leg, full: name } : null;
    },
  };

  const vopt = {
    scale: S, mirror: !opt.flip, slabs: opt.slabs,
    nodrawBlock: 'stone', format: opt.format,
  };
  const r = voxelize(parts, LO, HI, { width, height, length, cells }, vopt, resolver, '__NONE__');

  const grid = {
    width, height, length, blocks: r.blocks, data: r.data,
    stateName: (i) => (r.stateNames ? r.stateNames[i] : 'minecraft:stone'),
  };
  const ext = opt.format === 'sponge' ? '.schem' : '.schematic';
  const outFile = opt.out || opt.input.replace(/\.[^.]+$/, '') + ext;
  fs.writeFileSync(outFile, opt.format === 'sponge' ? writeSponge(grid) : writeMcEdit(grid));

  report();
  console.log(`fill           ${(100 * r.solidCells / cells).toFixed(2)}% of the grid`);
  console.log(`filled         ${r.solidCells.toLocaleString()} blocks (${r.slabs.toLocaleString()} slabs, ${r.stairs.toLocaleString()} stairs)`);
  console.log(`wrote          ${outFile}`);

  if (unions + meshes + terrain > 0) {
    console.warn(`\n!! ${unions} unions, ${meshes} MeshParts and ${terrain} Terrain object(s) were skipped.`);
    console.warn('   Union geometry is baked into an opaque blob, MeshParts live in external');
    console.warn('   assets, and Terrain is a compressed voxel grid. None are readable here.');
    console.warn('   In Studio you can right-click a union -> Separate, then re-save.');
  }
}

module.exports = { parseItems, oklab, buildPalette, partPrimitive };

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}
