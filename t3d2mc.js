#!/usr/bin/env node
/**
 * t3d2mc.js - Convert an Unreal / Unreal Tournament level (.t3d) into a
 * Minecraft schematic.
 *
 *   node t3d2mc.js MyLevel.t3d [options]
 *
 * Unreal builds levels with SUBTRACTIVE CSG: the world starts as solid rock and
 * brushes carve rooms out of it. That is the opposite of Quake 3 and Source,
 * where brushes are solid lumps placed in empty space. Voxels handle it
 * directly - fill the grid, then clear or fill cells per brush, in order.
 *
 * Get a .t3d out of UnrealEd:  File -> Export -> Unreal Text (.t3d)
 * or from the command line:    ucc batchexport MyLevel.unr Level t3d ..\Maps
 *
 * No dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VMF = path.join(__dirname, 'vmf2mc.js');
if (!fs.existsSync(VMF)) {
  console.error('error: vmf2mc.js must be in the same folder as t3d2mc.js.');
  process.exit(1);
}
const { writeMcEdit, writeSponge, nameToLegacy } = require(VMF);

/* ------------------------------------------------------------------ *
 * 1. .t3d parser
 * ------------------------------------------------------------------ */

// Begin Actor Class=Brush Name=Brush12 ... End Actor, with Begin Brush /
// Begin PolyList / Begin Polygon nested inside.
function parseT3d(text) {
  const lines = text.split(/\r?\n/);
  const actors = [];
  let actor = null, poly = null, inPolyList = false;

  const kvOf = (line) => {
    const out = {};
    // Class=Brush Name=Brush12   (values may be quoted or Type'Pkg.Name')
    const re = /(\w+)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
    let m;
    while ((m = re.exec(line))) out[m[1]] = m[3] ?? m[4] ?? m[2];
    return out;
  };
  const vec = (s) => {
    const n = s.trim().split(',').map(parseFloat);
    return [n[0] || 0, n[1] || 0, n[2] || 0];
  };
  // Location=(X=1.0,Y=2.0,Z=3.0)  /  MainScale=(Scale=(X=..,Y=..,Z=..),..)
  const namedVec = (s, dflt) => {
    if (!s) return dflt.slice();
    const g = (ax) => {
      const m = s.match(new RegExp('\\b' + ax + '=([-+0-9.eE]+)'));
      return m ? parseFloat(m[1]) : null;
    };
    return [g('X') ?? dflt[0], g('Y') ?? dflt[1], g('Z') ?? dflt[2]];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const low = line.toLowerCase();

    if (low.startsWith('begin actor')) {
      const kv = kvOf(line);
      actor = {
        cls: kv.Class || '', name: kv.Name || '',
        csg: null, polys: [],
        location: [0, 0, 0], prePivot: [0, 0, 0],
        rotation: [0, 0, 0], mainScale: [1, 1, 1], postScale: [1, 1, 1],
      };
      continue;
    }
    if (low.startsWith('end actor')) {
      if (actor) actors.push(actor);
      actor = null; inPolyList = false; poly = null;
      continue;
    }
    if (!actor) continue;

    if (low.startsWith('begin polylist')) { inPolyList = true; continue; }
    if (low.startsWith('end polylist')) { inPolyList = false; continue; }

    if (low.startsWith('begin polygon')) {
      const kv = kvOf(line);
      poly = { texture: kv.Texture || '', flags: parseInt(kv.Flags || '0', 10) || 0,
        normal: null, origin: null, verts: [] };
      continue;
    }
    if (low.startsWith('end polygon')) {
      if (poly && poly.verts.length >= 3) actor.polys.push(poly);
      poly = null; continue;
    }

    if (poly) {
      const m = line.match(/^(Origin|Normal|Vertex|TextureU|TextureV)\s+(.+)$/i);
      if (m) {
        const key = m[1].toLowerCase(), v = vec(m[2]);
        if (key === 'origin') poly.origin = v;
        else if (key === 'normal') poly.normal = v;
        else if (key === 'vertex') poly.verts.push(v);
      }
      continue;
    }
    if (inPolyList) continue;

    if (low.startsWith('csgoper=')) { actor.csg = line.split('=')[1].trim(); continue; }
    if (low.startsWith('location=')) { actor.location = namedVec(line, [0, 0, 0]); continue; }
    if (low.startsWith('prepivot=')) { actor.prePivot = namedVec(line, [0, 0, 0]); continue; }
    if (low.startsWith('mainscale=')) { actor.mainScale = namedVec(line, [1, 1, 1]); continue; }
    if (low.startsWith('postscale=')) { actor.postScale = namedVec(line, [1, 1, 1]); continue; }
    if (low.startsWith('rotation=')) {
      const g = (ax) => {
        const m2 = line.match(new RegExp('\\b' + ax + '=([-+0-9]+)'));
        return m2 ? parseInt(m2[1], 10) : 0;
      };
      actor.rotation = [g('Pitch'), g('Yaw'), g('Roll')];
      continue;
    }
  }
  return actors;
}

/* ------------------------------------------------------------------ *
 * 2. Brush transform (local -> world)
 * ------------------------------------------------------------------ */

// Unreal rotators are 65536 units per turn.
const UROT = Math.PI * 2 / 65536;

function transformVerts(actor) {
  const [ms, ps, pp, loc] = [actor.mainScale, actor.postScale, actor.prePivot, actor.location];
  const [pitch, yaw, roll] = actor.rotation.map(v => v * UROT);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);

  return (v) => {
    let x = (v[0] - pp[0]) * ms[0], y = (v[1] - pp[1]) * ms[1], z = (v[2] - pp[2]) * ms[2];
    // roll about X, then pitch about Y, then yaw about Z
    let ty = y * cr - z * sr, tz = y * sr + z * cr; y = ty; z = tz;
    let tx = x * cp + z * sp; tz = -x * sp + z * cp; x = tx; z = tz;
    tx = x * cy - y * sy; ty = x * sy + y * cy; x = tx; y = ty;
    return [x * ps[0] + loc[0], y * ps[1] + loc[1], z * ps[2] + loc[2]];
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Build a world-space brush: planes (outward), triangles, bbox, convexity.
function buildBrush(actor) {
  const xf = transformVerts(actor);
  const polys = [], planes = [], tris = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];

  for (const p of actor.polys) {
    const verts = p.verts.map(xf);
    if (verts.length < 3) continue;
    // recompute the normal from world verts: safer than trusting a rotated one
    let n = null;
    for (let i = 1; i + 1 < verts.length && !n; i++) {
      const c = cross3(sub3(verts[i], verts[0]), sub3(verts[i + 1], verts[0]));
      if (Math.hypot(c[0], c[1], c[2]) > 1e-6) n = c;
    }
    if (!n) continue;
    const len = Math.hypot(n[0], n[1], n[2]);
    n = [n[0] / len, n[1] / len, n[2] / len];
    // Unreal polygon winding gives an inward normal here; flip to outward.
    const d = dot(n, verts[0]);
    planes.push({ n, d, texture: p.texture });
    polys.push({ verts, texture: p.texture });
    for (let i = 1; i + 1 < verts.length; i++) tris.push([verts[0], verts[i], verts[i + 1]]);
    for (const v of verts) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]);
    }
  }
  if (!planes.length) return null;

  // Orient every plane outward relative to the brush centroid.
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  for (const pl of planes) {
    if (dot(pl.n, c) - pl.d > 0) { pl.n = pl.n.map(v => -v); pl.d = -pl.d; }
  }

  // Convex if every vertex satisfies every plane. Unreal brushes need not be.
  let convex = true;
  outer: for (const poly of polys)
    for (const v of poly.verts)
      for (const pl of planes)
        if (dot(pl.n, v) - pl.d > 0.1) { convex = false; break outer; }

  return { planes, tris, lo, hi, convex, actor };
}

const insideConvex = (planes, p) => {
  for (const pl of planes) if (dot(pl.n, p) - pl.d > 0.01) return false;
  return true;
};

// Ray casting for non-convex brushes: odd crossing count means inside.
const RAY = [0.5773502692, 0.5567764363, 0.5971385352];
function insideMesh(tris, p) {
  let hits = 0;
  for (const t of tris) {
    const e1 = sub3(t[1], t[0]), e2 = sub3(t[2], t[0]);
    const h = cross3(RAY, e2);
    const a = dot(e1, h);
    if (Math.abs(a) < 1e-9) continue;
    const f = 1 / a, s = sub3(p, t[0]);
    const u = f * dot(s, h);
    if (u < 0 || u > 1) continue;
    const q = cross3(s, e1);
    const v = f * dot(RAY, q);
    if (v < 0 || u + v > 1) continue;
    if (f * dot(e2, q) > 1e-6) hits++;
  }
  return (hits & 1) === 1;
}

/* ------------------------------------------------------------------ *
 * 3. Texture -> block
 * ------------------------------------------------------------------ */

// UT texture refs look like Texture'DecayedS.Ceiling.cor_ceiling'.
const TEX_RULES = [
  [/lava|magma|fire/, 'lava'],
  [/slime|ooze|sludge|toxic/, 'slime_block'],
  [/water|liquid|aqua/, 'water'],
  [/glass|window/, 'glass'],
  [/light|lamp|glow|energ/, 'glowstone'],
  [/grate|grill|fence|bars/, 'iron_bars'],
  [/gold|brass|bronze/, 'gold_block'],
  [/metal|steel|iron|tech|pipe|machine|panel|ship/, 'iron_block'],
  [/wood|plank|crate|timber|barrel/, 'planks'],
  [/carpet|cloth|drape|tapestr/, 'wool'],
  [/sand|desert|dune/, 'sandstone'],
  [/dirt|mud|earth|ground/, 'dirt'],
  [/grass|moss|ivy|vine|plant/, 'grass_block'],
  [/snow|ice|frost/, 'snow_block'],
  [/brick/, 'bricks'],
  [/marble|tile|gothic|temple|shane|ornate/, 'quartz_block'],
  [/rock|stone|cliff|granite|cave/, 'cobblestone'],
  [/concrete|cement|wall|floor|ceiling|trim|base|corridor|door/, 'stone_bricks'],
];

function buildTexResolver(overrideFile) {
  const overrides = overrideFile ? JSON.parse(fs.readFileSync(overrideFile, 'utf8')) : {};
  const cache = new Map();
  return {
    get(tex) {
      if (cache.has(tex)) return cache.get(tex);
      let name = null;
      for (const [k, v] of Object.entries(overrides))
        if (tex.toLowerCase().includes(k.toLowerCase())) { name = v; break; }
      if (!name) {
        const low = tex.toLowerCase();
        for (const [re, b] of TEX_RULES) if (re.test(low)) { name = b; break; }
      }
      const leg = name ? nameToLegacy(name) : null;
      const out = leg ? { ...leg, full: name } : null;
      cache.set(tex, out);
      return out;
    },
  };
}

// Which texture best describes a brush: the most common one across its polys.
function brushTexture(brush) {
  const counts = new Map();
  for (const pl of brush.planes) if (pl.texture) counts.set(pl.texture, (counts.get(pl.texture) || 0) + 1);
  let best = '', n = -1;
  for (const [t, c] of counts) if (c > n) { best = t; n = c; }
  return best;
}

/* ------------------------------------------------------------------ *
 * 4. Main
 * ------------------------------------------------------------------ */

const HELP = `
t3d2mc - Unreal / UT level (.t3d) -> Minecraft schematic

  node t3d2mc.js <MyLevel.t3d> [options]

  Export a .t3d from UnrealEd:  File -> Export -> Unreal Text
  or:  ucc batchexport MyLevel.unr Level t3d ..\\Maps

  --out <file>          output path (default: input path with .schematic)
  --scale <n>           Unreal units per block (default 32). UT geometry sits
                        on a 16/32/64 grid, so powers of two give clean walls.
                        True Minecraft proportions would be ~44 (a UT player is
                        78 units tall) but misaligns every surface.
  --world solid|empty   start solid and subtract (Unreal's default, and the
                        default here), or start empty for additive-built maps
  --shell <n>           keep only n blocks of rock around carved space
                        (default 4; use 0 to keep the level as a solid mass)
  --pad <n>             blocks of rock added around the level bounds. Defaults
                        to shell+1 for subtractive worlds, which is what gives
                        the outermost rooms their walls, floor and ceiling
  --format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
  --blocks <f.json>     texture substring -> block name overrides
  --movers              include Class=Mover brushes (doors, lifts) as solid
  --max-cells <n>       refuse maps above this cell count (default 8,000,000)
  --mirror              flip Y handedness
  --info                report what would be converted, write nothing
`;

function parseArgs(argv) {
  const o = {
    scale: 32, world: 'solid', shell: 4, format: 'mcedit', out: null,
    blocks: null, movers: false, maxCells: 8e6, mirror: false, info: false, pad: null,
  };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const val = () => argv[++i];
    if (!a.startsWith('--')) { files.push(a); continue; }
    switch (a) {
      case '--out': o.out = val(); break;
      case '--scale': o.scale = parseFloat(val()); break;
      case '--world': o.world = val(); break;
      case '--shell': o.shell = parseInt(val(), 10); break;
      case '--pad': o.pad = parseInt(val(), 10); break;
      case '--format': o.format = val(); break;
      case '--blocks': o.blocks = val(); break;
      case '--max-cells': o.maxCells = parseInt(val(), 10); break;
      case '--movers': o.movers = true; break;
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

  const actors = parseT3d(fs.readFileSync(opt.input, 'utf8'));
  const resolver = buildTexResolver(opt.blocks);

  // --- select brush actors, in file order: CSG order matters ---
  const ops = [];
  let builders = 0, movers = 0, nonBrush = 0, rotated = 0, scaled = 0, nonConvex = 0;
  for (const a of actors) {
    const isBrush = /^Brush$/i.test(a.cls);
    const isMover = /Mover/i.test(a.cls);
    if (!isBrush && !isMover) { nonBrush++; continue; }
    if (!a.polys.length) { nonBrush++; continue; }
    if (isMover && !opt.movers) { movers++; continue; }

    const csg = (a.csg || '').toUpperCase();
    if (csg === 'CSG_ACTIVE' || (!a.csg && isBrush && !isMover)) { builders++; continue; }

    const b = buildBrush(a);
    if (!b) continue;
    if (a.rotation.some(v => v !== 0)) rotated++;
    if (a.mainScale.some(v => v !== 1) || a.postScale.some(v => v !== 1)) scaled++;
    if (!b.convex) nonConvex++;

    b.op = csg === 'CSG_SUBTRACT' ? 'sub' : 'add';
    if (isMover) b.op = 'add';
    b.texture = brushTexture(b);
    ops.push(b);
  }
  if (!ops.length) throw new Error('no CSG brushes found - is this a level .t3d?');

  // --- grid ---
  const S = opt.scale;
  const LO = [Infinity, Infinity, Infinity], HI = [-Infinity, -Infinity, -Infinity];
  for (const b of ops) for (let k = 0; k < 3; k++) {
    LO[k] = Math.min(LO[k], b.lo[k]); HI[k] = Math.max(HI[k], b.hi[k]);
  }
  // In a subtractive world the rock extends past the outermost subtract brush.
  // Without margin the grid stops exactly at the carve and the level has no
  // walls, floor or ceiling at all.
  const pad = opt.pad !== null ? opt.pad
    : (opt.world === 'solid' ? Math.max(1, opt.shell > 0 ? opt.shell + 1 : 1) : 0);
  if (pad > 0) for (let k = 0; k < 3; k++) { LO[k] -= pad * S; HI[k] += pad * S; }

  const width = Math.max(1, Math.round((HI[0] - LO[0]) / S));
  const height = Math.max(1, Math.round((HI[2] - LO[2]) / S));
  const length = Math.max(1, Math.round((HI[1] - LO[1]) / S));
  const cells = width * height * length;

  const report = () => {
    console.log(`actors         ${actors.length} total; ${ops.length} csg brushes ` +
      `(${ops.filter(o => o.op === 'sub').length} subtract, ${ops.filter(o => o.op === 'add').length} add)`);
    console.log(`skipped        ${builders} builder, ${movers} mover, ${nonBrush} non-brush`);
    console.log(`bounds         ${Math.round(HI[0] - LO[0])} x ${Math.round(HI[1] - LO[1])} x ${Math.round(HI[2] - LO[2])} units`);
    console.log(`grid at ${S}u    ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells (pad ${pad})`);
    if (rotated || scaled) console.log(`transforms     ${rotated} rotated, ${scaled} scaled brushes`);
    if (nonConvex) console.log(`non-convex     ${nonConvex} brushes need ray casting (slower, still exact)`);
  };

  if (opt.info || cells > opt.maxCells) {
    report();
    if (cells > opt.maxCells) {
      console.error(`\nerror: ${cells.toLocaleString()} cells exceeds --max-cells ${opt.maxCells.toLocaleString()}.`);
      console.error('       Raise --scale or --max-cells.');
      process.exit(1);
    }
    if (opt.info) return;
  }

  // --- voxel CSG, in brush order ---
  const blocks = Buffer.alloc(cells);
  const data = Buffer.alloc(cells);
  const wantStates = opt.format === 'sponge';
  const stateNames = wantStates ? new Array(cells).fill('minecraft:air') : null;
  const idx = (x, y, z) => (y * length + z) * width + x;

  const rock = nameToLegacy('stone');
  if (opt.world === 'solid') {
    blocks.fill(rock.id & 0xff);
    if (wantStates) stateNames.fill('minecraft:stone');
  }

  const setCell = (i, blk) => {
    blocks[i] = blk.id & 0xff;
    data[i] = blk.data & 0x0f;
    if (wantStates) stateNames[i] = `minecraft:${blk.full || blk.name}`;
  };

  const unresolved = new Map();
  let subCells = 0, addCells = 0;

  for (const b of ops) {
    const blk = resolver.get(b.texture);
    if (!blk && b.texture) unresolved.set(b.texture, (unresolved.get(b.texture) || 0) + 1);
    const use = blk || { ...rock, full: 'stone' };

    const bx0 = Math.max(0, Math.floor((b.lo[0] - LO[0]) / S));
    const bx1 = Math.min(width - 1, Math.ceil((b.hi[0] - LO[0]) / S));
    const by0 = Math.max(0, Math.floor((b.lo[2] - LO[2]) / S));
    const by1 = Math.min(height - 1, Math.ceil((b.hi[2] - LO[2]) / S));
    const bz0 = Math.max(0, Math.floor((HI[1] - b.hi[1]) / S));
    const bz1 = Math.min(length - 1, Math.ceil((HI[1] - b.lo[1]) / S));

    const test = b.convex
      ? (p) => insideConvex(b.planes, p)
      : (p) => insideMesh(b.tris, p);

    const cleared = [];
    for (let by = by0; by <= by1; by++)
      for (let bz = bz0; bz <= bz1; bz++)
        for (let bx = bx0; bx <= bx1; bx++) {
          const p = [
            LO[0] + (bx + 0.5) * S,
            opt.mirror ? LO[1] + (bz + 0.5) * S : HI[1] - (bz + 0.5) * S,
            LO[2] + (by + 0.5) * S,
          ];
          if (!test(p)) continue;
          const i = idx(bx, by, bz);
          if (b.op === 'sub') {
            if (blocks[i]) { blocks[i] = 0; data[i] = 0; if (wantStates) stateNames[i] = 'minecraft:air'; subCells++; }
            cleared.push([bx, by, bz]);
          } else {
            if (!blocks[i]) addCells++;
            setCell(i, use);
          }
        }

    // A subtract brush's texture is the surface of the room it carved, so paint
    // the rock it exposed rather than leaving it generic stone.
    if (b.op === 'sub' && blk) {
      for (const [bx, by, bz] of cleared) {
        const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        for (const [dx, dy, dz] of nb) {
          const x = bx + dx, y = by + dy, z = bz + dz;
          if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= length) continue;
          const j = idx(x, y, z);
          if (blocks[j]) setCell(j, use);
        }
      }
    }
  }

  // --- shell: keep only n blocks of rock around carved space ---
  let carved = 0;
  if (opt.shell > 0) {
    const dist = new Int16Array(cells).fill(-1);
    let queue = [];
    for (let i = 0; i < cells; i++) if (!blocks[i]) { dist[i] = 0; queue.push(i); }
    for (let step = 0; step < opt.shell && queue.length; step++) {
      const next = [];
      for (const i of queue) {
        const bx = i % width, by = Math.floor(i / (length * width));
        const bz = Math.floor(i / width) % length;
        const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        for (const [dx, dy, dz] of nb) {
          const x = bx + dx, y = by + dy, z = bz + dz;
          if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= length) continue;
          const j = idx(x, y, z);
          if (dist[j] === -1) { dist[j] = step + 1; next.push(j); }
        }
      }
      queue = next;
    }
    for (let i = 0; i < cells; i++) {
      if (blocks[i] && dist[i] === -1) {
        blocks[i] = 0; data[i] = 0;
        if (wantStates) stateNames[i] = 'minecraft:air';
        carved++;
      }
    }
  }

  let solidCells = 0;
  for (let i = 0; i < cells; i++) if (blocks[i]) solidCells++;

  const grid = {
    width, height, length, blocks, data,
    stateName: (i) => (stateNames ? stateNames[i] : 'minecraft:stone'),
  };
  const ext = opt.format === 'sponge' ? '.schem' : '.schematic';
  const outFile = opt.out || opt.input.replace(/\.[^.]+$/, '') + ext;
  fs.writeFileSync(outFile, opt.format === 'sponge' ? writeSponge(grid) : writeMcEdit(grid));

  report();
  console.log(`csg            ${subCells.toLocaleString()} cells subtracted, ${addCells.toLocaleString()} added`);
  if (opt.shell > 0) console.log(`shell          ${carved.toLocaleString()} rock cells removed beyond ${opt.shell} blocks`);
  console.log(`fill           ${(100 * solidCells / cells).toFixed(2)}% of the grid`);
  console.log(`filled         ${solidCells.toLocaleString()} blocks`);
  console.log(`wrote          ${outFile}`);

  if (rotated || scaled) {
    console.warn(`\n!! ${rotated} rotated and ${scaled} scaled brushes. The Unreal transform`);
    console.warn('   order is the least-verified part of this tool; check those areas.');
  }
  if (unresolved.size) {
    const list = [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.warn(`\n!! ${unresolved.size} texture(s) matched no rule, defaulted to stone:`);
    for (const [t, c] of list) console.warn(`   ${String(c).padStart(6)}  ${t}`);
    console.warn('   Map them with --blocks map.json, e.g. {"cor_ceiling": "stone_bricks"}');
  }
}

module.exports = { parseT3d, buildBrush, transformVerts };

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}
