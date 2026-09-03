#!/usr/bin/env node
/**
 * map2mc.js - Convert a Radiant .map source file into a Minecraft schematic.
 *
 *   node map2mc.js mp_carentan.map [options]
 *
 * .map is the text brush format used by Radiant and every Quake-lineage
 * editor. It covers Call of Duty 1/2/4 (CoD Radiant), Quake 1/2/3, GoldSrc
 * (Half-Life), and anything else built on the same toolchain. Brushes are
 * lists of planes given by three points, so the voxelizer from vmf2mc applies
 * unchanged - including slab and stair reconstruction on ramps.
 *
 * Supported brush dialects: classic Quake, Valve 220 (GoldSrc), brushDef3.
 *
 * No dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VMF = path.join(__dirname, 'vmf2mc.js');
const PK3 = path.join(__dirname, 'pk32mc.js');
for (const [f, n] of [[VMF, 'vmf2mc.js'], [PK3, 'pk32mc.js']]) {
  if (!fs.existsSync(f)) {
    console.error(`error: ${n} must be in the same folder as map2mc.js.`);
    process.exit(1);
  }
}
const { voxelize, writeMcEdit, writeSponge } = require(VMF);
const { buildShaderResolver } = require(PK3);

/* ------------------------------------------------------------------ *
 * 1. .map parser
 * ------------------------------------------------------------------ */

const NUM = '[-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?';
const PT = `\\(\\s*(${NUM})\\s+(${NUM})\\s+(${NUM})\\s*\\)`;
// ( x y z ) ( x y z ) ( x y z ) TEXTURE ...rest
const RE_PLANE = new RegExp(`^\\s*${PT}\\s*${PT}\\s*${PT}\\s+(\\S+)(.*)$`);
// brushDef3: ( nx ny nz d ) ( ( .. ) ( .. ) ) "material" ...
const RE_BDEF3 = new RegExp(
  `^\\s*\\(\\s*(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s*\\)\\s*\\(.*\\)\\s*"?([^"\\s]+)"?`);

function parseMap(text) {
  // strip // comments but keep anything inside quotes
  const lines = text.split(/\r?\n/).map(l => l.replace(/\/\/.*$/, ''));

  const entities = [];
  let ent = null, brush = null, depth = 0;
  let brushDialect = null, patches = 0, meshes = 0;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line === '{') {
      depth++;
      if (depth === 1) ent = { kv: {}, brushes: [] };
      else if (depth === 2) brush = { planes: [], kind: null };
      continue;
    }
    if (line === '}') {
      if (depth === 2 && brush) {
        if (brush.planes.length >= 4) ent.brushes.push(brush);
        else if (brush.kind === 'patch') patches++;
        else if (brush.kind === 'mesh') meshes++;
        brush = null;
      } else if (depth === 1 && ent) {
        entities.push(ent); ent = null;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 1 && ent) {
      const kv = line.match(/^"([^"]*)"\s+"([^"]*)"$/);
      if (kv) ent.kv[kv[1].toLowerCase()] = kv[2];
      continue;
    }
    if (depth < 2 || !brush) continue;

    // patch / curve blocks - not brushes, cannot be voxelized
    if (/^patchDef[23]/i.test(line)) { brush.kind = 'patch'; continue; }
    if (/^mesh\b/i.test(line)) { brush.kind = 'mesh'; continue; }
    if (/^brushDef3/i.test(line)) { brush.kind = 'bdef3'; continue; }
    if (/^(contents|toolFlags|brushDef|\()/i.test(line) === false && !line.startsWith('(')) continue;

    if (brush.kind === 'bdef3') {
      const m = line.match(RE_BDEF3);
      if (m) {
        // stored as a*x + b*y + c*z + d = 0, so n . p = -d
        brush.planes.push({
          n: [+m[1], +m[2], +m[3]], d: -(+m[4]), material: m[5],
        });
        brushDialect = brushDialect || 'brushDef3';
      }
      continue;
    }

    const m = line.match(RE_PLANE);
    if (!m) continue;
    const p0 = [+m[1], +m[2], +m[3]];
    const p1 = [+m[4], +m[5], +m[6]];
    const p2 = [+m[7], +m[8], +m[9]];
    const material = m[10];
    if (!brushDialect) brushDialect = /^\s*\[/.test(m[11]) ? 'valve220' : 'classic';
    brush.planes.push({ pts: [p0, p1, p2], material });
  }
  return { entities, patches, meshes, dialect: brushDialect || 'classic' };
}

/* ------------------------------------------------------------------ *
 * 2. Planes -> half-spaces, with automatic winding detection
 * ------------------------------------------------------------------ */

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function planeFromPoints(pts) {
  // classic qbsp: n = (p0 - p1) x (p2 - p1)
  const n = cross3(sub3(pts[0], pts[1]), sub3(pts[2], pts[1]));
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-9) return null;
  const nn = [n[0] / len, n[1] / len, n[2] / len];
  return { n: nn, d: dot(nn, pts[0]) };
}

// Vertices of the convex region { p : n.p >= d for all planes }.
function verticesOf(planes) {
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
        if (Math.abs(det) < 1e-9) continue;
        const bc = cross3(B.n, C.n), ca = cross3(C.n, A.n), ab = cross3(A.n, B.n);
        const p = [
          (A.d * bc[0] + B.d * ca[0] + C.d * ab[0]) / det,
          (A.d * bc[1] + B.d * ca[1] + C.d * ab[1]) / det,
          (A.d * bc[2] + B.d * ca[2] + C.d * ab[2]) / det,
        ];
        let ok = true;
        for (const pl of planes) if (dot(pl.n, p) - pl.d < -EPS) { ok = false; break; }
        if (ok) verts.push(p);
      }
  return verts;
}

// .map dialects disagree on plane winding. Rather than assume, try one sign and
// flip if the half-space intersection comes out empty.
function solveBrush(rawPlanes) {
  const base = [];
  for (const rp of rawPlanes) {
    const pl = rp.pts ? planeFromPoints(rp.pts) : { n: rp.n.slice(), d: rp.d };
    if (!pl) continue;
    pl.material = rp.material;
    base.push(pl);
  }
  if (base.length < 4) return null;

  // Orient every plane against the brush centroid rather than trusting a
  // winding convention. The centroid of the defining points lies inside a
  // convex brush, so this works even when faces disagree with each other -
  // and it makes the parser dialect-agnostic.
  const pts = [];
  for (const rp of rawPlanes) if (rp.pts) pts.push(...rp.pts);
  let flipped = 0;
  if (pts.length) {
    const c = [0, 1, 2].map(k => pts.reduce((a, p) => a + p[k], 0) / pts.length);
    for (const pl of base) {
      if (dot(pl.n, c) - pl.d < 0) {
        pl.n = pl.n.map(v => -v); pl.d = -pl.d; flipped++;
      }
    }
  }

  let planes = base;
  let verts = verticesOf(planes);
  if (verts.length < 4) {
    // brushDef3 has no points to take a centroid from; fall back to a global flip
    planes = base.map(p => ({ n: p.n.map(v => -v), d: -p.d, material: p.material }));
    verts = verticesOf(planes);
    if (verts.length < 4) return null;
    return { planes, verts, flipped: true };
  }
  return { planes, verts, flipped: flipped > 0 };
}

/* ------------------------------------------------------------------ *
 * 3. Tool textures
 * ------------------------------------------------------------------ */

// Radiant tool textures across CoD / Quake / GoldSrc. These are editor and
// compiler hints, not visible geometry.
const TOOL_RE = /(^|\/)(caulk|clip|playerclip|weaponclip|nodraw|nodrawnonsolid|portal|portal_nodraw|hint|hintskip|skip|trigger|origin|areaportal|lightgrid|antiportal|donotenter|nolightmap|cluster|aitrigger|sky|skybox|missingtexture|shadowcaster)(_|$|\.)/i;

const NODRAW_MAT = '__NODRAW__';

/* ------------------------------------------------------------------ *
 * 4. Main
 * ------------------------------------------------------------------ */

const HELP = `
map2mc - Radiant .map source -> Minecraft schematic

  node map2mc.js <level.map> [options]

  Works with Call of Duty 1/2/4 (CoD Radiant), Quake 1/2/3 and GoldSrc .map
  files. Brush dialects: classic Quake, Valve 220, brushDef3.

  --out <file>          output path (default: input path with .schematic)
  --scale <n>           map units per block (default 32). CoD and Quake both
                        use ~1 unit per inch and snap to a 8/16/32 grid, so
                        powers of two keep walls clean.
  --format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
  --blocks <f.json>     texture substring -> block name overrides
  --tools               also voxelize caulk/clip/nodraw brushes
  --sky                 keep sky brushes (normally the outer shell)
  --entities            include brush entities (doors, movers) as solid
  --no-slabs            full cubes only, no half-height detection
  --nodraw-block <name> block for brushes with no visible face (default stone)
  --bounds x1,y1,z1,x2,y2,z2   only convert this region, in map units
  --max-cells <n>       refuse maps above this cell count (default 8,000,000)
  --mirror              flip handedness
  --info                report what would be converted, write nothing
`;

function parseArgs(argv) {
  const o = {
    scale: 32, format: 'mcedit', out: null, blocks: null, tools: false,
    sky: false, entities: true, slabs: true, nodrawBlock: 'stone',
    bounds: null, maxCells: 8e6, mirror: false, info: false,
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
      case '--nodraw-block': o.nodrawBlock = val(); break;
      case '--max-cells': o.maxCells = parseInt(val(), 10); break;
      case '--bounds': {
        const n = val().split(',').map(Number);
        if (n.length !== 6 || n.some(isNaN)) throw new Error('--bounds needs x1,y1,z1,x2,y2,z2');
        o.bounds = n; break;
      }
      case '--tools': o.tools = true; break;
      case '--sky': o.sky = true; break;
      case '--no-entities': o.entities = false; break;
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
  if (opt.blocks && !fs.existsSync(opt.blocks)) {
    console.error(`error: --blocks file not found: ${opt.blocks}`);
    process.exit(1);
  }

  const src = fs.readFileSync(opt.input, 'utf8');
  const parsed = parseMap(src);
  const resolver = buildShaderResolver(opt.blocks);

  const brushes = [];
  let skipTool = 0, skipSky = 0, skipEnt = 0, skipBad = 0, flipped = 0;
  let worldBrushes = 0, entBrushes = 0;

  for (const ent of parsed.entities) {
    const cls = (ent.kv.classname || '').toLowerCase();
    const isWorld = cls === 'worldspawn' || cls === '';
    if (!isWorld && !opt.entities) { skipEnt += ent.brushes.length; continue; }

    for (const b of ent.brushes) {
      const mats = b.planes.map(p => p.material || '');
      const visible = mats.filter(m => m && !TOOL_RE.test(m));
      const skyFace = mats.some(m => /(^|\/)sky/i.test(m));

      if (skyFace && !opt.sky) { skipSky++; continue; }
      if (!visible.length && !opt.tools) { skipTool++; continue; }

      const solved = solveBrush(b.planes);
      if (!solved) { skipBad++; continue; }
      if (solved.flipped) flipped++;

      const pool = visible.length ? visible : mats.filter(Boolean);
      const counts = new Map();
      for (const m of pool) counts.set(m, (counts.get(m) || 0) + 1);
      let material = NODRAW_MAT, best = -1;
      for (const [m, c] of counts) if (c > best) { material = m; best = c; }

      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const v of solved.verts) for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]);
      }
      brushes.push({ planes: solved.planes, lo, hi, material });
      if (isWorld) worldBrushes++; else entBrushes++;
    }
  }

  if (!brushes.length) throw new Error('no usable brushes found - is this a Radiant .map?');

  const S = opt.scale;
  const LO = [Infinity, Infinity, Infinity], HI = [-Infinity, -Infinity, -Infinity];
  for (const b of brushes) for (let k = 0; k < 3; k++) {
    LO[k] = Math.min(LO[k], b.lo[k]); HI[k] = Math.max(HI[k], b.hi[k]);
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
    console.log(`dialect        ${parsed.dialect}`);
    console.log(`entities       ${parsed.entities.length}`);
    console.log(`brushes        ${brushes.length} used (${worldBrushes} world, ${entBrushes} entity); ` +
      `skipped ${skipTool} tool, ${skipSky} sky, ${skipEnt} entity, ${skipBad} degenerate`);
    console.log(`bounds         ${Math.round(HI[0] - LO[0])} x ${Math.round(HI[1] - LO[1])} x ${Math.round(HI[2] - LO[2])} units`);
    console.log(`grid at ${S}u    ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells`);
    if (flipped) console.log(`winding        ${flipped} brushes needed a flipped plane sign`);
    if (parsed.patches || parsed.meshes)
      console.log(`curves         ${parsed.patches} patchDef, ${parsed.meshes} mesh - NOT converted`);
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
  const outFile = opt.out || opt.input.replace(/\.[^.]+$/, '') + ext;
  fs.writeFileSync(outFile, opt.format === 'sponge' ? writeSponge(grid) : writeMcEdit(grid));

  report();
  console.log(`fill           ${(100 * r.solidCells / cells).toFixed(2)}% of the grid`);
  console.log(`filled         ${r.solidCells.toLocaleString()} blocks (${r.slabs.toLocaleString()} slabs, ${r.stairs.toLocaleString()} stairs)`);
  console.log(`wrote          ${outFile}`);

  if (parsed.patches + parsed.meshes > 10) {
    console.warn(`\n!! ${parsed.patches + parsed.meshes} curve/mesh blocks were ignored. These are not`);
    console.warn('   brushes and cannot be voxelized; expect gaps where curves used to be.');
  }
  if (r.unresolved.size) {
    const list = [...r.unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.warn(`\n!! ${r.unresolved.size} texture(s) matched no rule, defaulted to stone:`);
    for (const [m, c] of list) console.warn(`   ${String(c).padStart(7)}  ${m}`);
    console.warn('   Map them with --blocks map.json, e.g. {"me_stone": "cobblestone"}');
  }
}

module.exports = { parseMap, solveBrush, planeFromPoints };

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}
