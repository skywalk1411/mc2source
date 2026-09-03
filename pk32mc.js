#!/usr/bin/env node
/**
 * pk32mc.js - Convert a Quake 3 Arena .pk3 (or a bare .bsp) into a Minecraft
 * schematic.
 *
 *   node pk32mc.js map.pk3 [options]
 *
 * A .pk3 is a ZIP; inside it, maps/<name>.bsp is an IBSP v46 file. Lump 8
 * stores brushes as sets of half-space planes - structurally identical to
 * Source brushes - so this reuses the voxelizer from vmf2mc.js.
 *
 * No dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const VMF = path.join(__dirname, 'vmf2mc.js');
if (!fs.existsSync(VMF)) {
  console.error('error: vmf2mc.js must be in the same folder as pk32mc.js.');
  process.exit(1);
}
const { voxelize, writeMcEdit, writeSponge, nameToLegacy } = require(VMF);

/* ------------------------------------------------------------------ *
 * 1. Minimal ZIP reader (pk3 is just a zip)
 * ------------------------------------------------------------------ */

function readZip(buf) {
  // End of central directory: scan back for 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip/pk3 file (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  const read = (e) => {
    if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error('bad local header for ' + e.name);
    const nameLen = buf.readUInt16LE(e.localOff + 26);
    const extraLen = buf.readUInt16LE(e.localOff + 28);
    const start = e.localOff + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`unsupported zip compression method ${e.method} for ${e.name}`);
  };
  return { entries, read };
}

/* ------------------------------------------------------------------ *
 * 2. Quake 3 BSP (IBSP v46)
 * ------------------------------------------------------------------ */

const LUMP = {
  ENTITIES: 0, TEXTURES: 1, PLANES: 2, MODELS: 7,
  BRUSHES: 8, BRUSHSIDES: 9, FACES: 13,
};

// contents flags
const C_SOLID = 1, C_LAVA = 8, C_SLIME = 16, C_WATER = 32, C_FOG = 64;
const C_PLAYERCLIP = 0x10000, C_MONSTERCLIP = 0x20000, C_TRIGGER = 0x40000000;
const C_ORIGIN = 0x1000000, C_NODROP = 0x80000000, C_AREAPORTAL = 0x8000;
// surface flags
const S_SKY = 4, S_NODRAW = 0x80, S_HINT = 0x100, S_SKIP = 0x200, S_NONSOLID = 0x4000;

function parseBsp(buf) {
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'IBSP') throw new Error(`not a Quake 3 BSP (magic "${magic}", expected IBSP)`);
  const version = buf.readInt32LE(4);

  // Call of Duty reuses the IBSP magic with an incompatible lump layout.
  // Parsing it as Q3 would silently produce garbage, so refuse instead.
  const COD = { 59: 'Call of Duty 1 / United Offensive', 4: 'Call of Duty 2', 22: 'Call of Duty 4' };
  if (COD[version]) {
    throw new Error(
      `this is a ${COD[version]} .d3dbsp (IBSP v${version}), not a Quake 3 BSP.\n` +
      '       CoD reuses the IBSP magic but rearranges the lumps, so parsing it\n' +
      '       as Q3 would produce garbage. Convert the Radiant source instead:\n' +
      '         node map2mc.js yourlevel.map');
  }
  if (version !== 46 && version !== 47)
    console.warn(`warning: BSP version ${version}, expected 46 (Q3A). Trying anyway.`);

  const lump = (i) => {
    const o = 8 + i * 8;
    return { off: buf.readInt32LE(o), len: buf.readInt32LE(o + 4) };
  };

  const L = lump(LUMP.TEXTURES);
  const textures = [];
  for (let o = L.off; o < L.off + L.len; o += 72) {
    textures.push({
      name: buf.toString('ascii', o, o + 64).replace(/\0.*$/, ''),
      flags: buf.readInt32LE(o + 64),
      contents: buf.readInt32LE(o + 68),
    });
  }

  const P = lump(LUMP.PLANES);
  const planes = [];
  for (let o = P.off; o < P.off + P.len; o += 16) {
    planes.push({
      n: [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)],
      d: buf.readFloatLE(o + 12),
    });
  }

  const BS = lump(LUMP.BRUSHSIDES);
  const brushSides = [];
  for (let o = BS.off; o < BS.off + BS.len; o += 8) {
    brushSides.push({ plane: buf.readInt32LE(o), texture: buf.readInt32LE(o + 4) });
  }

  const B = lump(LUMP.BRUSHES);
  const brushes = [];
  for (let o = B.off; o < B.off + B.len; o += 12) {
    brushes.push({
      side: buf.readInt32LE(o), nSides: buf.readInt32LE(o + 4), texture: buf.readInt32LE(o + 8),
    });
  }

  const M = lump(LUMP.MODELS);
  const models = [];
  for (let o = M.off; o < M.off + M.len; o += 40) {
    models.push({ brush: buf.readInt32LE(o + 32), nBrushes: buf.readInt32LE(o + 36) });
  }

  // faces, only to count curved patches we can't represent
  const F = lump(LUMP.FACES);
  let patches = 0, meshes = 0;
  for (let o = F.off; o + 104 <= F.off + F.len; o += 104) {
    const type = buf.readInt32LE(o + 8);
    if (type === 2) patches++;
    else if (type === 3) meshes++;
  }

  const E = lump(LUMP.ENTITIES);
  const entities = buf.toString('ascii', E.off, E.off + E.len).replace(/\0.*$/, '');

  return { version, textures, planes, brushSides, brushes, models, patches, meshes, entities };
}

/* ------------------------------------------------------------------ *
 * 3. Shader name -> Minecraft block
 * ------------------------------------------------------------------ */

// Q3 shader paths are freeform ("textures/gothic_floor/xstepborder5"), so match
// on keywords. Order matters: specific patterns first. The block names chosen
// here are the ones SLAB_FOR/STAIR_FOR know about, so ramps still come out as
// slabs and stairs.
const SHADER_RULES = [
  [/lava|magma/, 'lava'],
  [/slime|acid/, 'slime_block'],
  [/water|liquid/, 'water'],
  [/glass|window/, 'glass'],
  [/light|lamp|glow|flare|fluoresc/, 'glowstone'],
  [/grate|mesh|fence/, 'iron_bars'],
  [/metal|steel|iron|panel|tech|pipe/, 'iron_block'],
  [/gold|brass/, 'gold_block'],
  [/wood|plank|crate|timber/, 'planks'],
  [/carpet|cloth|banner|flag/, 'wool'],
  [/sand|desert|dune/, 'sandstone'],
  [/dirt|mud|earth/, 'dirt'],
  [/grass|moss|vine/, 'grass_block'],
  [/snow|ice|frost/, 'snow_block'],
  [/brick/, 'bricks'],
  [/gothic|temple|marble|tile/, 'quartz_block'],
  [/rock|stone|cliff|granite/, 'cobblestone'],
  [/concrete|cement|base|wall|floor|ceil|trim|support|beam/, 'stone_bricks'],
  [/blood|flesh|organ/, 'red_terracotta'],
];

const NODRAW_MAT = '__NODRAW__';

function buildShaderResolver(overrideFile) {
  const overrides = overrideFile ? JSON.parse(fs.readFileSync(overrideFile, 'utf8')) : {};
  const cache = new Map();
  return {
    get(shader) {
      if (cache.has(shader)) return cache.get(shader);
      let name = null;
      for (const [k, v] of Object.entries(overrides)) {
        if (shader === k || shader.toLowerCase().includes(k.toLowerCase())) { name = v; break; }
      }
      if (!name) {
        const low = shader.toLowerCase();
        for (const [re, block] of SHADER_RULES) if (re.test(low)) { name = block; break; }
      }
      if (!name) { cache.set(shader, null); return null; }
      const leg = nameToLegacy(name);
      const out = leg ? { ...leg, full: name } : null;
      cache.set(shader, out);
      return out;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4. Brushes -> half-spaces
 * ------------------------------------------------------------------ */

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Q3 brush planes point OUTWARD (inside = dot(n,p) <= d). The shared voxelizer
// expects INWARD normals with inside = dot(n,p) >= d, so negate both.
function brushHalfSpaces(bsp, br) {
  const planes = [];
  for (let i = 0; i < br.nSides; i++) {
    const bs = bsp.brushSides[br.side + i];
    if (!bs) continue;
    const pl = bsp.planes[bs.plane];
    if (!pl) continue;
    const tex = bsp.textures[bs.texture];
    planes.push({
      n: [-pl.n[0], -pl.n[1], -pl.n[2]],
      d: -pl.d,
      material: tex ? tex.name : '',
      flags: tex ? tex.flags : 0,
    });
  }
  return planes;
}

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
        const bc = cross(B.n, C.n), ca = cross(C.n, A.n), ab = cross(A.n, B.n);
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

/* ------------------------------------------------------------------ *
 * 5. Main
 * ------------------------------------------------------------------ */

const HELP = `
pk32mc - Quake 3 Arena .pk3 / .bsp -> Minecraft schematic

  node pk32mc.js <map.pk3|map.bsp> [options]

  --out <file>          output path (default: map name + .schematic)
  --map <name>          which bsp to use when the pk3 holds several
  --list                list the bsp files inside the pk3 and exit
  --scale <n>           Quake units per block (default 32; a Q3 player is
                        56 units tall, so 32 gives roughly Minecraft
                        proportions. Lower = more detail, far more blocks)
  --format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
  --blocks <f.json>     shader substring -> block name overrides, as JSON
  --liquids solid|skip  keep water/lava/slime brushes (default solid)
  --clip                also voxelize clip brushes (invisible collision)
  --world-only          only model 0; skips doors, platforms and other movers
  --no-slabs            full cubes only, no half-height detection
  --nodraw-block <name> block for brushes with no drawable surface (stone)
  --bounds x1,y1,z1,x2,y2,z2   only convert this region, in Quake units
  --max-cells <n>       refuse maps above this cell count (default 8,000,000)
  --mirror              flip handedness
  --info                report what would be converted, write nothing
`;

function parseArgs(argv) {
  const o = {
    scale: 32, format: 'mcedit', out: null, map: null, blocks: null,
    liquids: 'solid', clip: false, worldOnly: false, slabs: true,
    nodrawBlock: 'stone', bounds: null, maxCells: 8e6, mirror: false,
    info: false, list: false,
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
      case '--bounds': {
        const n = val().split(',').map(Number);
        if (n.length !== 6 || n.some(isNaN)) throw new Error('--bounds needs x1,y1,z1,x2,y2,z2');
        o.bounds = n; break;
      }
      case '--clip': o.clip = true; break;
      case '--world-only': o.worldOnly = true; break;
      case '--no-slabs': o.slabs = false; break;
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

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.input) { console.log(HELP); process.exit(opt.input ? 0 : 1); }
  if (opt.blocks && !fs.existsSync(opt.blocks)) {
    console.error(`error: --blocks file not found: ${opt.blocks}`);
    console.error('       --blocks takes JSON like {"gothic_floor": "quartz_block"}');
    process.exit(1);
  }

  const raw = fs.readFileSync(opt.input);
  let bspBuf, mapName;

  if (raw.toString('ascii', 0, 4) === 'IBSP') {
    bspBuf = raw;
    mapName = path.basename(opt.input).replace(/\.(bsp|d3dbsp)$/i, '');
  } else {
    const zip = readZip(raw);
    const bsps = zip.entries.filter(e => /\.(bsp|d3dbsp)$/i.test(e.name));
    if (!bsps.length) throw new Error('no .bsp found inside the pk3');
    if (opt.list) {
      console.log(`${bsps.length} map(s) in ${path.basename(opt.input)}:`);
      for (const b of bsps) console.log('  ' + b.name);
      return;
    }
    let pick = bsps[0];
    if (opt.map) {
      const want = opt.map.toLowerCase().replace(/\.bsp$/, '');
      pick = bsps.find(b => path.basename(b.name, '.bsp').toLowerCase() === want);
      if (!pick) throw new Error(`--map "${opt.map}" not in pk3. Try --list.`);
    } else if (bsps.length > 1) {
      console.warn(`note: pk3 has ${bsps.length} maps, using ${pick.name}. Use --list / --map to pick.`);
    }
    bspBuf = zip.read(pick);
    mapName = path.basename(pick.name).replace(/\.(bsp|d3dbsp)$/i, '');
  }

  const bsp = parseBsp(bspBuf);
  const resolver = buildShaderResolver(opt.blocks);

  // --- which brushes to keep ---
  let range = { from: 0, to: bsp.brushes.length };
  if (opt.worldOnly && bsp.models.length)
    range = { from: bsp.models[0].brush, to: bsp.models[0].brush + bsp.models[0].nBrushes };

  const brushes = [];
  let skipSky = 0, skipClip = 0, skipNonSolid = 0, skipBad = 0, liquidBrushes = 0;
  const shaderCount = new Map();

  for (let bi = range.from; bi < range.to; bi++) {
    const br = bsp.brushes[bi];
    if (!br) continue;
    const tex = bsp.textures[br.texture];
    const contents = tex ? tex.contents : 0;

    const isLiquid = !!(contents & (C_LAVA | C_SLIME | C_WATER));
    const isClip = !!(contents & (C_PLAYERCLIP | C_MONSTERCLIP)) && !(contents & C_SOLID);
    const junk = !!(contents & (C_TRIGGER | C_ORIGIN | C_NODROP | C_FOG | C_AREAPORTAL));

    if (junk) { skipNonSolid++; continue; }
    if (isClip && !opt.clip) { skipClip++; continue; }
    if (isLiquid && opt.liquids === 'skip') { skipNonSolid++; continue; }
    if (!isLiquid && !isClip && !(contents & C_SOLID)) { skipNonSolid++; continue; }

    const planes = brushHalfSpaces(bsp, br);
    if (planes.length < 4) { skipBad++; continue; }

    // sky brushes are the outer shell, same role as toolsskybox
    if (planes.some(p => p.flags & S_SKY)) { skipSky++; continue; }
    if (planes.every(p => p.flags & (S_HINT | S_SKIP))) { skipNonSolid++; continue; }

    const verts = verticesOf(planes);
    if (verts.length < 4) { skipBad++; continue; }

    // dominant drawable shader names the brush
    const drawable = planes.filter(p => !(p.flags & (S_NODRAW | S_HINT | S_SKIP)) && p.material);
    const pool = drawable.length ? drawable : planes.filter(p => p.material);
    const counts = new Map();
    for (const p of pool) counts.set(p.material, (counts.get(p.material) || 0) + 1);
    let material = NODRAW_MAT, bestN = -1;
    for (const [m, c] of counts) if (c > bestN) { material = m; bestN = c; }
    if (!drawable.length && !pool.length) material = NODRAW_MAT;
    if (isLiquid) material = (contents & C_LAVA) ? 'textures/liquids/lava'
      : (contents & C_SLIME) ? 'textures/liquids/slime' : 'textures/liquids/water';
    if (isLiquid) liquidBrushes++;
    shaderCount.set(material, (shaderCount.get(material) || 0) + 1);

    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]);
    }
    brushes.push({ planes, lo, hi, material });
  }

  if (!brushes.length) throw new Error('no usable solid brushes found in this bsp');

  // --- grid ---
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

  const spawns = (bsp.entities.match(/info_player_(deathmatch|start)/g) || []).length;

  const report = () => {
    console.log(`map            ${mapName} (IBSP v${bsp.version})`);
    console.log(`brushes        ${brushes.length} used; skipped ${skipSky} sky, ${skipClip} clip, ${skipNonSolid} non-solid, ${skipBad} degenerate`);
    console.log(`bounds         ${Math.round(HI[0] - LO[0])} x ${Math.round(HI[1] - LO[1])} x ${Math.round(HI[2] - LO[2])} units`);
    console.log(`grid at ${S}u    ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells`);
    if (spawns) console.log(`spawns         ${spawns} player spawn entities`);
    if (bsp.patches) console.log(`patches        ${bsp.patches} bezier patches - curved surfaces, NOT converted`);
    if (liquidBrushes) console.log(`liquids        ${liquidBrushes} brushes`);
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

  if (bsp.patches > 20) {
    console.warn(`\n!! ${bsp.patches} bezier patches were ignored. Q3 uses these for curved`);
    console.warn('   arches, pipes and rounded terrain; they are not brushes, so they');
    console.warn('   cannot be voxelized. Expect gaps where curves used to be.');
  }
  if (r.unresolved.size) {
    const list = [...r.unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.warn(`\n!! ${r.unresolved.size} shader(s) matched no rule, defaulted to stone:`);
    for (const [m, c] of list) console.warn(`   ${String(c).padStart(7)}  ${m}`);
    console.warn('   Map them with --blocks map.json, e.g. {"gothic_floor": "quartz_block"}');
  }
}

module.exports = { readZip, parseBsp, buildShaderResolver };

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}
