#!/usr/bin/env node
/**
 * wad2mc.js - Convert a Doom / Doom II map from a .wad into a Minecraft
 * schematic.
 *
 *   node wad2mc.js doom2.wad --map MAP01
 *
 * Doom has neither brushes nor primitives. Its geometry is 2.5D: every SECTOR
 * is a polygon footprint with a floor height and a ceiling height. So this is a
 * column problem rather than a volume one - for each grid column, find the
 * sector containing it, then fill solid below the floor, air between floor and
 * ceiling, solid above.
 *
 * "Which sector contains this point" is the query Doom's own BSP tree exists to
 * answer, so the NODES lump is traversed exactly as the engine does it.
 *
 * No dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VMF = path.join(__dirname, 'vmf2mc.js');
if (!fs.existsSync(VMF)) {
  console.error('error: vmf2mc.js must be in the same folder as wad2mc.js.');
  process.exit(1);
}
const { writeMcEdit, writeSponge, nameToLegacy } = require(VMF);

/* ------------------------------------------------------------------ *
 * 1. WAD container
 * ------------------------------------------------------------------ */

function readWad(buf) {
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'IWAD' && magic !== 'PWAD')
    throw new Error(`not a WAD file (magic "${magic}", expected IWAD or PWAD)`);
  const count = buf.readInt32LE(4);
  const dirOfs = buf.readInt32LE(8);
  const lumps = [];
  for (let i = 0; i < count; i++) {
    const o = dirOfs + i * 16;
    lumps.push({
      pos: buf.readInt32LE(o),
      size: buf.readInt32LE(o + 4),
      name: buf.toString('ascii', o + 8, o + 16).replace(/\0.*$/, '').trim(),
      index: i,
    });
  }
  return { type: magic, lumps, data: buf };
}

const MAP_LUMPS = new Set(['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS',
  'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP', 'BEHAVIOR', 'SCRIPTS']);

// A map is a zero-length marker lump followed by its data lumps.
function findMaps(wad) {
  const maps = [];
  for (let i = 0; i < wad.lumps.length; i++) {
    const l = wad.lumps[i];
    if (l.size !== 0) continue;
    // An empty REJECT or BLOCKMAP is followed by map lumps too, but a map
    // marker is never itself one of them.
    if (MAP_LUMPS.has(l.name)) continue;
    const next = wad.lumps[i + 1];
    if (!next || !MAP_LUMPS.has(next.name)) continue;
    const members = {};
    for (let j = i + 1; j < wad.lumps.length && MAP_LUMPS.has(wad.lumps[j].name); j++) {
      members[wad.lumps[j].name] = wad.lumps[j];
    }
    maps.push({ name: l.name, members });
  }
  return maps;
}

const str8 = (buf, o) => buf.toString('ascii', o, o + 8).replace(/\0.*$/, '').trim().toUpperCase();

function loadMap(wad, map) {
  const B = wad.data;
  const grab = (n) => {
    const l = map.members[n];
    return l ? B.subarray(l.pos, l.pos + l.size) : Buffer.alloc(0);
  };
  const hexen = !!map.members.BEHAVIOR;

  const vb = grab('VERTEXES');
  const vertexes = [];
  for (let o = 0; o + 4 <= vb.length; o += 4) vertexes.push([vb.readInt16LE(o), vb.readInt16LE(o + 2)]);

  const sb = grab('SECTORS');
  const sectors = [];
  for (let o = 0; o + 26 <= sb.length; o += 26) {
    sectors.push({
      floor: sb.readInt16LE(o), ceil: sb.readInt16LE(o + 2),
      floorTex: str8(sb, o + 4), ceilTex: str8(sb, o + 12),
      light: sb.readInt16LE(o + 20), special: sb.readInt16LE(o + 22), tag: sb.readInt16LE(o + 24),
    });
  }

  const sdb = grab('SIDEDEFS');
  const sidedefs = [];
  for (let o = 0; o + 30 <= sdb.length; o += 30) {
    sidedefs.push({
      upper: str8(sdb, o + 4), lower: str8(sdb, o + 12), middle: str8(sdb, o + 20),
      sector: sdb.readUInt16LE(o + 28),
    });
  }

  const lb = grab('LINEDEFS');
  const linedefs = [];
  const lsz = hexen ? 16 : 14;
  for (let o = 0; o + lsz <= lb.length; o += lsz) {
    const front = lb.readUInt16LE(o + (hexen ? 12 : 10));
    const back = lb.readUInt16LE(o + (hexen ? 14 : 12));
    linedefs.push({
      v1: lb.readUInt16LE(o), v2: lb.readUInt16LE(o + 2),
      flags: lb.readUInt16LE(o + 4),
      front: front === 0xffff ? -1 : front,
      back: back === 0xffff ? -1 : back,
    });
  }

  const gb = grab('SEGS');
  const segs = [];
  for (let o = 0; o + 12 <= gb.length; o += 12) {
    segs.push({ linedef: gb.readUInt16LE(o + 6), dir: gb.readInt16LE(o + 8) });
  }

  const ssb = grab('SSECTORS');
  const ssectors = [];
  for (let o = 0; o + 4 <= ssb.length; o += 4) {
    ssectors.push({ count: ssb.readUInt16LE(o), first: ssb.readUInt16LE(o + 2) });
  }

  const nb = grab('NODES');
  const nodes = [];
  // ZDoom/GL extended nodes replace the classic 28-byte records with a
  // magic-prefixed blob. Detect rather than misread it.
  const nodeMagic = nb.length >= 4 ? nb.toString('ascii', 0, 4) : '';
  const extendedNodes = /^(XNOD|ZNOD|XGLN|ZGLN|XGL2|XGL3)$/.test(nodeMagic);
  if (!extendedNodes) {
    for (let o = 0; o + 28 <= nb.length; o += 28) {
      nodes.push({
        x: nb.readInt16LE(o), y: nb.readInt16LE(o + 2),
        dx: nb.readInt16LE(o + 4), dy: nb.readInt16LE(o + 6),
        right: nb.readUInt16LE(o + 24), left: nb.readUInt16LE(o + 26),
      });
    }
  }

  const tb = grab('THINGS');
  const tsz = hexen ? 20 : 10;
  let things = 0, starts = 0;
  for (let o = 0; o + tsz <= tb.length; o += tsz) {
    things++;
    const type = tb.readInt16LE(o + (hexen ? 10 : 6));
    if (type >= 1 && type <= 4) starts++;
  }

  return { hexen, vertexes, sectors, sidedefs, linedefs, segs, ssectors, nodes,
    extendedNodes, things, starts };
}

/* ------------------------------------------------------------------ *
 * 2. Point -> sector
 * ------------------------------------------------------------------ */

// Sector of the subsector's first seg: the seg's direction picks which
// sidedef of its linedef faces into this subsector.
function subsectorSector(m, ssIndex) {
  const ss = m.ssectors[ssIndex];
  if (!ss) return -1;
  const seg = m.segs[ss.first];
  if (!seg) return -1;
  const ld = m.linedefs[seg.linedef];
  if (!ld) return -1;
  const sd = seg.dir === 0 ? ld.front : ld.back;
  if (sd < 0) return -1;
  return m.sidedefs[sd] ? m.sidedefs[sd].sector : -1;
}

// Doom's R_PointOnSide: front (right child) when the cross product is negative.
function bspSector(m, x, y) {
  if (!m.nodes.length) return -1;
  let n = m.nodes.length - 1;              // root is the last node
  for (let guard = 0; guard < 256; guard++) {
    const nd = m.nodes[n];
    if (!nd) return -1;
    const dx = x - nd.x, dy = y - nd.y;
    const side = (nd.dx * dy - nd.dy * dx) < 0 ? nd.right : nd.left;
    if (side & 0x8000) return subsectorSector(m, side & 0x7fff);
    n = side;
  }
  return -1;
}

// Fallback when nodes are extended or missing: cast +X and take the side of
// the first linedef crossed that faces back toward the point.
function raySector(m, x, y) {
  let bestX = Infinity, bestLd = null;
  for (const ld of m.linedefs) {
    const a = m.vertexes[ld.v1], b = m.vertexes[ld.v2];
    if (!a || !b) continue;
    if ((a[1] > y) === (b[1] > y)) continue;
    const t = (y - a[1]) / (b[1] - a[1]);
    const ix = a[0] + t * (b[0] - a[0]);
    if (ix > x && ix < bestX) { bestX = ix; bestLd = ld; }
  }
  if (!bestLd) return -1;
  const a = m.vertexes[bestLd.v1], b = m.vertexes[bestLd.v2];
  // which side of the crossed line the point sits on
  const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const sd = cross < 0 ? bestLd.front : bestLd.back;
  if (sd < 0) return -1;
  return m.sidedefs[sd] ? m.sidedefs[sd].sector : -1;
}

/* ------------------------------------------------------------------ *
 * 3. Doom texture / flat names -> blocks
 * ------------------------------------------------------------------ */

const SKY = /^F_SKY|^SKY/;

const TEX_RULES = [
  [/LAVA|FIRE|MAGMA/, 'lava'],
  [/NUKAGE|SLIME|SLM|GRNPOIS|SFALL/, 'slime_block'],
  [/BLOOD|BFALL/, 'red_terracotta'],
  [/WATER|FWATER|WFALL/, 'water'],
  [/LITE|LIGHT|GLOW|LAMP|TLITE/, 'glowstone'],
  [/CRATE|WOOD|PLANK|BROWNPIP|DOOR3|BIGDOOR/, 'planks'],
  [/METAL|SHAWN|SILVER|SUPPORT|TEKGREN|COMPUT|SPACEW|PIPE|DOORTRAK|EXITDOOR/, 'iron_block'],
  [/MARB|MARBLE|GATE/, 'quartz_block'],
  [/SKIN|FLESH|SP_HOT|REDWALL/, 'netherrack'],
  [/BRICK|BRIK|BIGBRIK|BROWN/, 'bricks'],
  [/RROCK|GRASS|MFLR8|SWAMP/, 'grass_block'],
  [/MUD|DIRT|ASHWALL|RSKY/, 'dirt'],
  [/SAND|DESERT/, 'sandstone'],
  [/ROCK|STONE|GSTONE|STARG|STARTAN|STARBR|CEMENT|GRAY|GRAYTALL/, 'cobblestone'],
  [/FLOOR|FLAT|CEIL|STEP|TILE|SLOPPY/, 'stone_bricks'],
];

function buildTexResolver(overrideFile) {
  const overrides = overrideFile ? JSON.parse(fs.readFileSync(overrideFile, 'utf8')) : {};
  const cache = new Map();
  const unresolved = new Map();
  return {
    unresolved,
    get(tex) {
      if (!tex || tex === '-') return null;
      if (cache.has(tex)) return cache.get(tex);
      let name = null;
      for (const [k, v] of Object.entries(overrides))
        if (tex.toUpperCase().includes(k.toUpperCase())) { name = v; break; }
      if (!name) for (const [re, b] of TEX_RULES) if (re.test(tex)) { name = b; break; }
      if (!name) unresolved.set(tex, (unresolved.get(tex) || 0) + 1);
      const leg = nameToLegacy(name || 'stone');
      const out = leg ? { ...leg, full: name || 'stone' } : null;
      cache.set(tex, out);
      return out;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4. Main
 * ------------------------------------------------------------------ */

const HELP = `
wad2mc - Doom / Doom II map -> Minecraft schematic

  node wad2mc.js <file.wad> [options]

  --list                list the maps in the wad and exit
  --map <name>          which map to convert (e.g. E1M1, MAP07)
  --out <file>          output path (default: map name + .schematic)
  --scale <n>           Doom units per block (default 32; a Doom player is 56
                        units tall so 32 is close to Minecraft proportions.
                        Use 16 to keep detail, at 8x the cell count)
  --format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
  --blocks <f.json>     texture substring -> block name overrides
  --pad <n>             blocks of rock around the map bounds (default 2)
  --shell <n>           keep only n blocks of rock around open space
                        (default 3; 0 keeps the map as a solid mass)
  --sky-open            leave sky ceilings open (default; --no-sky-open caps them)
  --no-sky-open         cap F_SKY1 ceilings with solid blocks
  --max-cells <n>       refuse maps above this cell count (default 8,000,000)
  --mirror              flip the map along the Y axis
  --info                report what would be converted, write nothing
`;

function parseArgs(argv) {
  const o = {
    scale: 32, format: 'mcedit', out: null, map: null, blocks: null,
    pad: 2, shell: 3, skyOpen: true, maxCells: 8e6, mirror: false,
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
      case '--pad': o.pad = parseInt(val(), 10); break;
      case '--shell': o.shell = parseInt(val(), 10); break;
      case '--max-cells': o.maxCells = parseInt(val(), 10); break;
      case '--sky-open': o.skyOpen = true; break;
      case '--no-sky-open': o.skyOpen = false; break;
      case '--mirror': o.mirror = true; break;
      case '--list': o.list = true; break;
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

  const wad = readWad(fs.readFileSync(opt.input));
  const maps = findMaps(wad);
  if (!maps.length) throw new Error('no maps found in this wad');

  if (opt.list) {
    console.log(`${wad.type}, ${wad.lumps.length} lumps, ${maps.length} map(s):`);
    console.log('  ' + maps.map(m => m.name).join('  '));
    return;
  }

  let pick = maps[0];
  if (opt.map) {
    const want = opt.map.toUpperCase();
    pick = maps.find(m => m.name.toUpperCase() === want);
    if (!pick) throw new Error(`map "${opt.map}" not in wad. Try --list.`);
  } else if (maps.length > 1) {
    console.warn(`note: wad has ${maps.length} maps, using ${pick.name}. Use --list / --map to pick.`);
  }

  const m = loadMap(wad, pick);
  if (!m.vertexes.length || !m.sectors.length) throw new Error('map has no geometry');
  const tex = buildTexResolver(opt.blocks);

  const useBsp = m.nodes.length > 0 && m.ssectors.length > 0 && m.segs.length > 0;
  const sectorAt = useBsp ? (x, y) => bspSector(m, x, y) : (x, y) => raySector(m, x, y);

  // --- bounds ---
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of m.vertexes) {
    minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
    minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]);
  }
  let minF = Infinity, maxC = -Infinity;
  for (const s of m.sectors) {
    minF = Math.min(minF, s.floor); maxC = Math.max(maxC, s.ceil);
  }
  const S = opt.scale, PAD = opt.pad * S;
  const LOX = minX - PAD, HIX = maxX + PAD;
  const LOY = minY - PAD, HIY = maxY + PAD;
  const LOZ = minF - PAD, HIZ = maxC + PAD;

  const width = Math.max(1, Math.round((HIX - LOX) / S));
  const length = Math.max(1, Math.round((HIY - LOY) / S));
  const height = Math.max(1, Math.round((HIZ - LOZ) / S));
  const cells = width * height * length;

  const report = () => {
    console.log(`wad            ${wad.type}, ${maps.length} map(s)`);
    console.log(`map            ${pick.name}${m.hexen ? ' (Hexen format)' : ''}`);
    console.log(`geometry       ${m.vertexes.length} vertexes, ${m.linedefs.length} linedefs, ${m.sectors.length} sectors`);
    console.log(`lookup         ${useBsp ? 'BSP nodes' : 'ray cast (' + (m.extendedNodes ? 'extended nodes' : 'no nodes') + ')'}`);
    console.log(`extent         ${maxX - minX} x ${maxY - minY} units, heights ${minF} to ${maxC}`);
    console.log(`grid at ${S}u    ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells`);
    console.log(`things         ${m.things} (${m.starts} player starts)`);
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

  // --- wall textures, rasterized from linedefs into columns ---
  const wallTex = new Map();
  const colOf = (wx, wy) => {
    const bx = Math.floor((wx - LOX) / S);
    const bz = opt.mirror ? Math.floor((wy - LOY) / S) : Math.floor((HIY - wy) / S);
    if (bx < 0 || bz < 0 || bx >= width || bz >= length) return -1;
    return bz * width + bx;
  };
  for (const ld of m.linedefs) {
    const a = m.vertexes[ld.v1], b = m.vertexes[ld.v2];
    if (!a || !b) continue;
    const sd = m.sidedefs[ld.front >= 0 ? ld.front : ld.back];
    if (!sd) continue;
    const t = sd.middle !== '-' ? sd.middle : (sd.upper !== '-' ? sd.upper : sd.lower);
    if (!t || t === '-') continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / (S / 2)));
    for (let i = 0; i <= steps; i++) {
      const c = colOf(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps);
      if (c >= 0 && !wallTex.has(c)) wallTex.set(c, t);
    }
  }

  // --- column fill ---
  const blocks = Buffer.alloc(cells);
  const data = Buffer.alloc(cells);
  const wantStates = opt.format === 'sponge';
  const stateNames = wantStates ? new Array(cells).fill('minecraft:air') : null;
  const idx = (x, y, z) => (y * length + z) * width + x;
  const rock = { ...nameToLegacy('stone'), full: 'stone' };

  const put = (i, blk) => {
    blocks[i] = blk.id & 0xff;
    data[i] = blk.data & 0x0f;
    if (wantStates) stateNames[i] = `minecraft:${blk.full || blk.name}`;
  };

  let inside = 0, void_ = 0, skyCols = 0;
  for (let bz = 0; bz < length; bz++) {
    const wy = opt.mirror ? LOY + (bz + 0.5) * S : HIY - (bz + 0.5) * S;

    // A BSP partitions all of space, so it happily reports a sector for points
    // outside the level. Doom never asks, because the player cannot leave.
    // Even-odd crossings against every linedef give the real inside test, and
    // computing them once per row makes it a scanline instead of a per-cell scan.
    const xs = [];
    for (const ld of m.linedefs) {
      // Only ONE-SIDED linedefs bound the map. A two-sided line separates two
      // sectors, so counting it would flip parity and read the far room as void.
      if (ld.back >= 0) continue;
      const a = m.vertexes[ld.v1], b = m.vertexes[ld.v2];
      if (!a || !b) continue;
      if ((a[1] > wy) === (b[1] > wy)) continue;
      xs.push(a[0] + (wy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);

    for (let bx = 0; bx < width; bx++) {
      const wx = LOX + (bx + 0.5) * S;
      let before = 0;
      for (const ix of xs) { if (ix <= wx) before++; else break; }
      const si = (before & 1) ? sectorAt(wx, wy) : -1;
      const col = bz * width + bx;
      const wt = wallTex.get(col);
      const wallBlk = wt ? (tex.get(wt) || rock) : rock;

      if (si < 0 || si >= m.sectors.length) {
        void_++;
        for (let by = 0; by < height; by++) put(idx(bx, by, bz), wallBlk);
        continue;
      }
      inside++;
      const sec = m.sectors[si];
      const isSky = SKY.test(sec.ceilTex);
      if (isSky) skyCols++;
      const floorBlk = tex.get(sec.floorTex) || rock;
      const ceilBlk = isSky ? rock : (tex.get(sec.ceilTex) || rock);

      for (let by = 0; by < height; by++) {
        const cz = LOZ + (by + 0.5) * S;
        const i = idx(bx, by, bz);
        if (cz < sec.floor) {
          // the topmost solid cell is the visible floor surface
          const top = LOZ + (by + 1.5) * S >= sec.floor;
          put(i, top ? floorBlk : rock);
        } else if (cz >= sec.ceil) {
          if (isSky && opt.skyOpen) continue;
          const bottom = LOZ + (by - 0.5) * S < sec.ceil;
          put(i, bottom ? ceilBlk : rock);
        }
        // between floor and ceiling: air
      }
    }
  }

  // --- shell: trim rock far from any open space ---
  let trimmed = 0;
  if (opt.shell > 0) {
    const dist = new Int16Array(cells).fill(-1);
    let q = [];
    for (let i = 0; i < cells; i++) if (!blocks[i]) { dist[i] = 0; q.push(i); }
    for (let step = 0; step < opt.shell && q.length; step++) {
      const next = [];
      for (const i of q) {
        const bx = i % width, by = Math.floor(i / (length * width));
        const bz = Math.floor(i / width) % length;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const x = bx + dx, y = by + dy, z = bz + dz;
          if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= length) continue;
          const j = idx(x, y, z);
          if (dist[j] === -1) { dist[j] = step + 1; next.push(j); }
        }
      }
      q = next;
    }
    for (let i = 0; i < cells; i++) {
      if (blocks[i] && dist[i] === -1) {
        blocks[i] = 0; data[i] = 0;
        if (wantStates) stateNames[i] = 'minecraft:air';
        trimmed++;
      }
    }
  }

  let solid = 0;
  for (let i = 0; i < cells; i++) if (blocks[i]) solid++;

  const grid = {
    width, height, length, blocks, data,
    stateName: (i) => (stateNames ? stateNames[i] : 'minecraft:stone'),
  };
  const ext = opt.format === 'sponge' ? '.schem' : '.schematic';
  const outFile = opt.out || path.join(path.dirname(opt.input), pick.name + ext);
  fs.writeFileSync(outFile, opt.format === 'sponge' ? writeSponge(grid) : writeMcEdit(grid));

  report();
  console.log(`columns        ${inside.toLocaleString()} in sectors, ${void_.toLocaleString()} void, ${skyCols.toLocaleString()} under sky`);
  if (opt.shell > 0) console.log(`shell          ${trimmed.toLocaleString()} rock cells trimmed beyond ${opt.shell} blocks`);
  console.log(`fill           ${(100 * solid / cells).toFixed(2)}% of the grid`);
  console.log(`filled         ${solid.toLocaleString()} blocks`);
  console.log(`wrote          ${outFile}`);

  if (m.extendedNodes) {
    console.warn('\n!! This map uses ZDoom extended nodes, so sector lookup fell back to ray');
    console.warn('   casting. That is exact for well-formed maps but slower and less robust');
    console.warn('   on self-referencing sectors. Rebuild classic nodes to use the BSP path.');
  }
  if (tex.unresolved.size) {
    const list = [...tex.unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.warn(`\n!! ${tex.unresolved.size} texture(s) matched no rule, defaulted to stone:`);
    for (const [t, c] of list) console.warn(`   ${String(c).padStart(6)}  ${t}`);
    console.warn('   Map them with --blocks map.json, e.g. {"STARTAN": "stone_bricks"}');
  }
}

module.exports = { readWad, findMaps, loadMap, bspSector, raySector };

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}
