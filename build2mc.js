#!/usr/bin/env node
/**
 * build2mc.js - Build engine maps (Duke Nukem 3D, Shadow Warrior, Redneck
 * Rampage, Ion Fury, NAM, WW2 GI) into a Minecraft schematic.
 *
 *   node build2mc.js DUKE3D.GRP --map E1L1.MAP
 *   node build2mc.js MYLEVEL.MAP --scale 64
 *
 * This is wad2mc evolved. Build geometry is 2.5D like Doom's - every SECTOR is
 * a polygon footprint with a floor height and a ceiling height - but two things
 * differ, and both of them are improvements:
 *
 *   1. Sectors carry their own wall loops, so "which sector contains this
 *      point" is a direct even-odd test against that sector's own walls. No
 *      BSP traversal, and no separate inside test: a point in no sector IS
 *      outside the map, by construction. Doom needed both because its NODES
 *      lump partitions all of space.
 *
 *   2. Floors and ceilings SLOPE. `floorheinum` tilts the plane about the
 *      sector's first wall, so floor height is a linear function of (x,y)
 *      rather than a constant.
 *
 * (2) is why the surfaces go through vmf2mc's voxelizer rather than a scalar
 * column fill. That voxelizer takes 8 subsamples per cell and reads the
 * quadrant occupancy masks to pick full cube / slab / stair - so a Build ramp
 * comes out as a real Minecraft staircase instead of Doom's flat plateaus. It
 * accepts an arbitrary containment `test`, which is exactly what a sloped
 * sector surface can supply.
 *
 * Requires vmf2mc.js. Optionally rbxl2mc.js, for tile colour matching.
 * No dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VMF = path.join(__dirname, 'vmf2mc.js');
if (!fs.existsSync(VMF)) {
  console.error('error: vmf2mc.js must be in the same folder as build2mc.js.');
  process.exit(1);
}
const { voxelize, writeMcEdit, writeSponge, nameToLegacy } = require(VMF);

// Only needed when sampling tile colours out of an ART file.
let RBX = null;
try { RBX = require(path.join(__dirname, 'rbxl2mc.js')); } catch { /* optional */ }

/* ------------------------------------------------------------------ *
 * 1. GRP container
 *
 * Ken Silverman's group file: a 16-byte header, a flat directory, then the
 * payloads back to back. No compression, no per-entry offsets - each file
 * starts where the previous one ended.
 * ------------------------------------------------------------------ */

function readGrp(buf) {
  if (buf.length < 16 || buf.toString('ascii', 0, 12) !== 'KenSilverman')
    return null;
  const count = buf.readInt32LE(12);
  if (count < 0 || count > 65535) throw new Error(`GRP claims ${count} files, which is not credible`);
  const entries = [];
  let pos = 16 + count * 16;
  for (let i = 0; i < count; i++) {
    const o = 16 + i * 16;
    const name = buf.toString('ascii', o, o + 12).replace(/\0.*$/, '').trim().toUpperCase();
    const size = buf.readInt32LE(o + 12);
    entries.push({ name, size, pos });
    pos += size;
  }
  // Same check cod2mc runs on the lump table: the last entry must land exactly
  // on EOF, or the directory has been misread and every offset after the first
  // is silently wrong.
  if (pos !== buf.length)
    throw new Error(`GRP directory ends at ${pos} but the file is ${buf.length} bytes - not a GRP, or truncated`);
  return { entries, data: buf };
}

const grpFind = (grp, re) => grp.entries.filter(e => re.test(e.name));
const grpRead = (grp, e) => grp.data.subarray(e.pos, e.pos + e.size);

/* ------------------------------------------------------------------ *
 * 2. MAP file
 *
 * v7 is the format Duke3D, Shadow Warrior, Redneck Rampage and NAM all ship;
 * eduke32's v8 and v9 keep the same three structs and append extra data, so
 * the same reader covers them. v5/v6 predate the layout and are refused.
 * ------------------------------------------------------------------ */

const SECTOR_SIZE = 40, WALL_SIZE = 32, SPRITE_SIZE = 44;

function readMap(buf) {
  if (buf.length >= 4 && buf.toString('ascii', 0, 3) === 'BLM')
    throw new Error(
      'this is a Blood .MAP - the header is encrypted and the sector/wall data\n' +
      '       carries Blood\'s XSECTOR/XWALL extensions. Decrypt it first (Mapedit,\n' +
      '       XLEdit or bloodmapconv will write a plain v7 map) and re-run.');

  if (buf.length < 20) throw new Error('file is too short to be a Build map');
  const version = buf.readInt32LE(0);
  if (version === 5 || version === 6)
    throw new Error(`Build map version ${version} uses the pre-v7 struct layout, which this reader\n` +
      '       does not implement. Open it in Mapster32 or BUILD and re-save to get v7.');
  if (version < 5 || version > 9)
    throw new Error(`version ${version} is not a Build map version (expected 7, or 8/9 from eduke32)`);

  const start = {
    x: buf.readInt32LE(4), y: buf.readInt32LE(8), z: buf.readInt32LE(12),
    ang: buf.readInt16LE(16), sect: buf.readInt16LE(18),
  };

  let o = 20;
  const numsectors = buf.readUInt16LE(o); o += 2;
  need(buf, o, numsectors * SECTOR_SIZE, 'sectors');
  const sectors = [];
  for (let i = 0; i < numsectors; i++, o += SECTOR_SIZE) {
    sectors.push({
      wallptr: buf.readInt16LE(o), wallnum: buf.readInt16LE(o + 2),
      ceilingz: buf.readInt32LE(o + 4), floorz: buf.readInt32LE(o + 8),
      ceilingstat: buf.readUInt16LE(o + 12), floorstat: buf.readUInt16LE(o + 14),
      ceilingpicnum: buf.readInt16LE(o + 16), ceilingheinum: buf.readInt16LE(o + 18),
      floorpicnum: buf.readInt16LE(o + 24), floorheinum: buf.readInt16LE(o + 26),
      lotag: buf.readInt16LE(o + 34), hitag: buf.readInt16LE(o + 36),
    });
  }

  const numwalls = buf.readUInt16LE(o); o += 2;
  need(buf, o, numwalls * WALL_SIZE, 'walls');
  const walls = [];
  for (let i = 0; i < numwalls; i++, o += WALL_SIZE) {
    walls.push({
      x: buf.readInt32LE(o), y: buf.readInt32LE(o + 4),
      point2: buf.readInt16LE(o + 8), nextwall: buf.readInt16LE(o + 10),
      nextsector: buf.readInt16LE(o + 12), cstat: buf.readUInt16LE(o + 14),
      picnum: buf.readInt16LE(o + 16), overpicnum: buf.readInt16LE(o + 18),
    });
  }

  const numsprites = buf.readUInt16LE(o); o += 2;
  need(buf, o, numsprites * SPRITE_SIZE, 'sprites');
  const sprites = [];
  for (let i = 0; i < numsprites; i++, o += SPRITE_SIZE) {
    sprites.push({
      x: buf.readInt32LE(o), y: buf.readInt32LE(o + 4), z: buf.readInt32LE(o + 8),
      cstat: buf.readUInt16LE(o + 12), picnum: buf.readInt16LE(o + 14),
      xrepeat: buf.readUInt8(o + 20), yrepeat: buf.readUInt8(o + 21),
      sectnum: buf.readInt16LE(o + 24), statnum: buf.readInt16LE(o + 26),
      ang: buf.readInt16LE(o + 28), lotag: buf.readInt16LE(o + 38),
    });
  }

  const map = { version, start, sectors, walls, sprites, trailing: buf.length - o };
  validate(map);
  return map;
}

function need(buf, o, n, what) {
  if (o + n > buf.length)
    throw new Error(`map truncated: ${what} need ${n} bytes at ${o}, file has ${buf.length}`);
}

/**
 * Structural self-check. A misread struct size produces plausible-looking
 * rubbish rather than an error, so the parse is verified against invariants the
 * format guarantees before any of it is trusted:
 *
 *   - every sector's wall range lies inside the wall array;
 *   - the sector wall ranges tile the wall array exactly, in order, with no
 *     gap and no overlap - Build stores each sector's walls consecutively;
 *   - every `point2` stays inside its own sector's range and the loops it
 *     forms are closed and cover the range exactly once.
 *
 * The loop check is the strong one. Following point2 from a wrong offset walks
 * off almost immediately.
 */
function validate(m) {
  const nw = m.walls.length;
  let expect = 0, gaps = 0;
  m.sectors.forEach((s, i) => {
    if (s.wallptr !== expect) gaps++;
    if (s.wallnum < 3 || s.wallptr + s.wallnum > nw)
      throw new Error(`sector ${i} claims walls ${s.wallptr}..${s.wallptr + s.wallnum - 1} of ${nw}`);
    expect += s.wallnum;
  });
  // Build keeps each sector's walls consecutive, so the ranges normally tile
  // the array. A map that breaks that is unusual but not unreadable, so this
  // is a note rather than an error - the loop check below is the real test.
  if (gaps) m.wallGaps = gaps;

  for (const s of m.sectors) {
    const lo = s.wallptr, hi = s.wallptr + s.wallnum;
    const seen = new Uint8Array(s.wallnum);
    for (let i = lo; i < hi; i++) {
      const p2 = m.walls[i].point2;
      if (p2 < lo || p2 >= hi)
        throw new Error(`wall ${i} points to ${p2}, outside its sector's range ${lo}..${hi - 1}`);
      if (seen[p2 - lo]++)
        throw new Error(`wall ${p2} is the target of two point2 links - loops are malformed`);
    }
    if (m.walls[lo] && m.walls[lo].nextsector >= m.sectors.length)
      throw new Error(`wall ${lo} references sector ${m.walls[lo].nextsector} of ${m.sectors.length}`);
  }
}

/* ------------------------------------------------------------------ *
 * 3. Coordinates and slopes
 *
 * Build's z axis points DOWN and is stored 16x finer than x and y, so
 * ceilingz is numerically smaller than floorz. World z (up, same units as x/y)
 * is -z/16 throughout this file.
 *
 * Slope, from Build's getzsofslope(): the plane tilts about the sector's FIRST
 * wall, and the offset at a point is
 *
 *     j = (dx*(py-wy) - dy*(px-wx)) >> 3        // dmulscale3
 *     i = length(dx,dy) << 5
 *     zoff = heinum * j / i
 *
 * dx*(py-wy) - dy*(px-wx) is the cross product, i.e. perpendicular distance
 * times length, so the length cancels and this reduces to
 *
 *     zoff = heinum * perpdist / 256            (in z units)
 *
 * Divide by 16 for world units and the gradient is heinum/4096 - which is the
 * documented result that heinum 4096 is a 45 degree slope. That agreement is
 * the check that the formula was transcribed correctly.
 * ------------------------------------------------------------------ */

const Z = (bz) => -bz / 16;         // Build z -> world z (up)

function slopeFn(m, sec, which) {
  const stat = which === 'floor' ? sec.floorstat : sec.ceilingstat;
  const base = Z(which === 'floor' ? sec.floorz : sec.ceilingz);
  const heinum = which === 'floor' ? sec.floorheinum : sec.ceilingheinum;
  if (!(stat & 2) || heinum === 0) { const f = () => base; f.flat = true; return f; }

  const w1 = m.walls[sec.wallptr], w2 = m.walls[w1.point2];
  const dx = w2.x - w1.x, dy = w2.y - w1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) { const f = () => base; f.flat = true; return f; }

  const k = heinum / (256 * len * 16);   // /16 converts the z offset to world units
  const f = (px, py) => base - k * (dx * (py - w1.y) - dy * (px - w1.x));
  f.flat = false;
  return f;
}

// A linear function over a polygon takes its extremes at the vertices.
function surfaceRange(m, sec, fn) {
  let lo = Infinity, hi = -Infinity;
  for (let i = sec.wallptr; i < sec.wallptr + sec.wallnum; i++) {
    const v = fn(m.walls[i].x, m.walls[i].y);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/* ------------------------------------------------------------------ *
 * 4. Point in sector
 *
 * Even-odd crossings over the sector's own walls. Inner loops (holes) are
 * stored in the same wall range as the outer loop, so counting every wall
 * handles them for free - a point inside a hole crosses one extra boundary and
 * comes out even.
 *
 * The test is 2D and so is independent of height, but the voxelizer calls it
 * once per subsample per cell, which means once per height layer for the same
 * (x,y). Memoising on the quadrant lattice - the sample points are always at
 * LO + S*(n + 1/4) and LO + S*(n + 3/4) - collapses that to one polygon test
 * per quadrant column and is the difference between seconds and minutes.
 * ------------------------------------------------------------------ */

function sectorTester(m, sec, LO, S, width, length) {
  const lo = sec.wallptr, hi = sec.wallptr + sec.wallnum;
  const QW = width * 2, QL = length * 2;
  const seen = new Uint8Array(QW * QL);          // 0 unknown, 1 in, 2 out
  const qi = (x, y) => {
    const u = Math.round((x - LO[0]) / S * 2 - 0.5);
    const v = Math.round((y - LO[1]) / S * 2 - 0.5);
    return (u < 0 || v < 0 || u >= QW || v >= QL) ? -1 : v * QW + u;
  };
  const raw = (px, py) => {
    let inside = false;
    for (let i = lo; i < hi; i++) {
      const a = m.walls[i], b = m.walls[a.point2];
      if ((a.y > py) !== (b.y > py) &&
          px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  return (px, py) => {
    const k = qi(px, py);
    if (k < 0) return raw(px, py);
    const c = seen[k];
    if (c) return c === 1;
    const r = raw(px, py);
    seen[k] = r ? 1 : 2;
    return r;
  };
}

/* ------------------------------------------------------------------ *
 * 5. Tiles -> blocks
 *
 * Every other converter here reads texture NAMES and matches keywords. Build
 * has no names: a surface carries a `picnum`, a bare integer index into the
 * ART files. So there is nothing to keyword-match against, and guessing from
 * tile ranges would be per-game folklore.
 *
 * Instead, when the ART and PALETTE.DAT are available (they are, if the input
 * is a GRP), each tile's average colour is computed and matched against the
 * Minecraft palette in Oklab - the same approach rbxl2mc uses for Roblox part
 * colours, and for the same reason: real colour beats guessed names.
 * ------------------------------------------------------------------ */

function readPaletteDat(buf) {
  if (buf.length < 768) throw new Error('PALETTE.DAT is shorter than its 768-byte colour table');
  const pal = new Uint8Array(768);
  // VGA 6-bit values; scale to 8-bit rather than shifting, so 63 maps to 255.
  for (let i = 0; i < 768; i++) pal[i] = Math.min(255, Math.round(buf[i] * 255 / 63));
  return pal;
}

function readArt(buf, pal, out) {
  if (buf.length < 16) return 0;
  const version = buf.readInt32LE(0);
  if (version !== 1) throw new Error(`ART version ${version}, expected 1`);
  const first = buf.readInt32LE(8), last = buf.readInt32LE(12);
  const n = last - first + 1;
  if (n <= 0 || n > 65536) throw new Error(`ART tile range ${first}..${last} is not credible`);

  const sx = 16, sy = sx + n * 2, anm = sy + n * 2, pix = anm + n * 4;
  if (pix > buf.length) throw new Error('ART header runs past the end of the file');

  // Same accounting check as the GRP directory: the pixel block must be
  // exactly the sum of the declared tile areas.
  let total = 0;
  for (let i = 0; i < n; i++) total += buf.readInt16LE(sx + i * 2) * buf.readInt16LE(sy + i * 2);
  if (pix + total !== buf.length)
    throw new Error(`ART tiles total ${total} pixels but ${buf.length - pix} bytes follow the header`);

  let o = pix, loaded = 0;
  for (let i = 0; i < n; i++) {
    const w = buf.readInt16LE(sx + i * 2), h = buf.readInt16LE(sy + i * 2);
    const area = w * h;
    if (area > 0) {
      let r = 0, g = 0, b = 0, k = 0;
      // Stride large tiles; the average does not need every pixel.
      const step = area > 4096 ? Math.ceil(area / 4096) : 1;
      for (let p = 0; p < area; p += step) {
        const c = buf[o + p];
        if (c === 255) continue;                 // Build's transparent index
        r += pal[c * 3]; g += pal[c * 3 + 1]; b += pal[c * 3 + 2]; k++;
      }
      if (k) out.set(first + i, { w, h, rgb: [Math.round(r / k), Math.round(g / k), Math.round(b / k)] });
      else out.set(first + i, { w, h, rgb: null });
      loaded++;
    }
    o += area;
  }
  return loaded;
}

// Blocks that have both a slab and a stair form in vmf2mc's tables. A sloped
// surface is matched only against these: colour fidelity is worth less than
// the slope actually coming out as steps, and a wool ramp would flatten back
// into full cubes.
const SLOPE_SAFE = '^(stone|cobblestone|stone_bricks|bricks|sandstone|quartz_block|' +
  'oak_planks|spruce_planks|birch_planks)$';

function buildTileResolver(tiles, opt) {
  const overrides = opt.blocks ? JSON.parse(fs.readFileSync(opt.blocks, 'utf8')) : {};
  const byNum = new Map();
  for (const [k, v] of Object.entries(overrides)) {
    // "1234" picks one tile, "1200-1260" a range.
    const mm = /^(\d+)\s*-\s*(\d+)$/.exec(k);
    if (mm) for (let i = +mm[1]; i <= +mm[2]; i++) byNum.set(i, v);
    else if (/^\d+$/.test(k)) byNum.set(+k, v);
  }

  const canColour = tiles.size > 0 && RBX;
  const pal = canColour ? RBX.buildPalette(opt.palette, null) : null;
  const palSlope = canColour ? RBX.buildPalette(opt.palette, SLOPE_SAFE) : null;

  const cache = new Map();
  const unresolved = new Map();
  const def = opt.defaultBlock;

  const wrap = (name) => {
    const leg = nameToLegacy(name);
    return leg ? { ...leg, full: name } : { id: 1, data: 0, name: 'stone', full: 'stone' };
  };

  return {
    unresolved, canColour,
    // mat is "pic:<n>", "pic:<n>!" (sloped) or "rock"
    get(mat) {
      if (cache.has(mat)) return cache.get(mat);
      let out;
      if (mat === 'rock') out = wrap(opt.rockBlock);
      else {
        const sloped = mat.endsWith('!');
        const num = parseInt(mat.slice(4), 10);
        let name = byNum.get(num);
        if (!name && canColour) {
          const t = tiles.get(num);
          if (t && t.rgb) name = (sloped ? palSlope : pal).match(t.rgb[0], t.rgb[1], t.rgb[2]);
        }
        if (!name) { unresolved.set(num, (unresolved.get(num) || 0) + 1); name = def; }
        out = wrap(name);
      }
      cache.set(mat, out);
      return out;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 6. Sprites
 *
 * Build sprites are billboards, but wall-aligned (cstat bits 4-5 == 01) and
 * floor-aligned (== 10) ones are real level geometry: signs, catwalks, crates,
 * the fences and grates half of Duke3D's detail is made of. They are oriented
 * quads, not sectors, so they go through the voxelizer as oriented boxes -
 * literally the same containment-test shape rbxl2mc uses for Roblox parts.
 *
 * Their world size is (tilesize * repeat) / 4, which needs the tile dimensions
 * from ART. With no ART loaded the size is unknowable and sprites are skipped
 * rather than guessed at.
 * ------------------------------------------------------------------ */

function spriteBox(sp, tile, thickness) {
  const align = (sp.cstat >> 4) & 3;
  if (align !== 1 && align !== 2) return null;         // face sprite: a billboard, not geometry
  if (!tile || !tile.w || !tile.h) return null;

  const w = tile.w * sp.xrepeat / 4;
  const h = tile.h * sp.yrepeat / 4;
  if (w < 1 || h < 1) return null;

  const a = sp.ang * Math.PI / 1024;                    // Build angles: 2048 = full turn
  const ca = Math.cos(a), sa = Math.sin(a);
  const cx = sp.x, cy = sp.y, cz = Z(sp.z);

  if (align === 1) {
    // Wall sprite: a vertical quad. It spans `w` along its facing normal's
    // perpendicular, `thickness` through it, and `h` in z. cstat bit 7 puts
    // the origin at the centre instead of the bottom.
    const centred = (sp.cstat & 128) !== 0;
    const z0 = centred ? cz - h / 2 : cz - h;
    const z1 = centred ? cz + h / 2 : cz;
    // Local axes: u along the face (perpendicular to ang), v through it.
    const ux = -sa, uy = ca, vx = ca, vy = sa;
    const hw = w / 2, ht = thickness / 2;
    const test = (p) => {
      const dx = p[0] - cx, dy = p[1] - cy;
      return p[2] >= z0 && p[2] <= z1 &&
        Math.abs(dx * ux + dy * uy) <= hw && Math.abs(dx * vx + dy * vy) <= ht;
    };
    const r = Math.hypot(hw, ht);
    return { lo: [cx - r, cy - r, z0], hi: [cx + r, cy + r, z1], test };
  }

  // Floor sprite: a horizontal quad, w x h in plan, one slab thick.
  const ux = ca, uy = sa, vx = -sa, vy = ca;
  const hw = w / 2, hh = h / 2;
  const z0 = cz - thickness, z1 = cz;
  const test = (p) => {
    const dx = p[0] - cx, dy = p[1] - cy;
    return p[2] >= z0 && p[2] <= z1 &&
      Math.abs(dx * ux + dy * uy) <= hw && Math.abs(dx * vx + dy * vy) <= hh;
  };
  const r = Math.hypot(hw, hh);
  return { lo: [cx - r, cy - r, z0], hi: [cx + r, cy + r, z1], test };
}

/* ------------------------------------------------------------------ *
 * 7. Main
 * ------------------------------------------------------------------ */

const HELP = `
build2mc - Build engine map -> Minecraft schematic
            (Duke Nukem 3D, Shadow Warrior, Redneck Rampage, Ion Fury, NAM)

  node build2mc.js <file.map | file.grp> [options]

  --list                list the maps inside a .grp and exit
  --map <name>          which map to convert (e.g. E1L1.MAP)
  --out <file>          output path (default: map name + .schematic)
  --scale <n>           Build units per block (default 128). Build's unit is
                        small and the games disagree about how small, so --info
                        measures THIS map's player start and tells you what
                        proportional would be. 128 is deliberately below that:
                        the map comes out large, and keeps its detail
  --format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
  --art <file.art>      load tile sizes and colours from a loose ART file
                        (repeatable; found automatically inside a .grp)
  --palette <f.json>    replace the block colour palette: {"block":[r,g,b]}
  --blocks <f.json>     picnum -> block overrides, {"1234":"stone","10-40":"sand"}
  --default-block <n>   block for tiles with no colour and no override (stone)
  --rock-block <n>      block for bulk fill below floors and above ceilings (stone)
  --sprites             also voxelize wall- and floor-aligned sprites
  --sprites-blocking    ...but only the ones flagged blocking (cstat bit 0)
  --sprite-thickness <n>  how thick a sprite quad becomes, in units. Defaults to
                        half a block, so a sprite always survives the sampling
  --pad <n>             blocks of rock around the map bounds (default 2)
  --shell <n>           keep only n blocks of rock around open space (default 3)
  --no-sky-open         cap parallaxing ceilings instead of leaving them open
  --no-slabs            full cubes only; no slope reconstruction
  --max-cells <n>       refuse maps above this cell count (default 8,000,000)
  --mirror              flip handedness
  --info                report what would be converted, write nothing
`;

function parseArgs(argv) {
  const o = {
    scale: 128, format: 'mcedit', out: null, map: null, blocks: null, palette: null,
    art: [], defaultBlock: 'stone', rockBlock: 'stone', sprites: false,
    spritesBlocking: false, spriteThickness: null, pad: 2, shell: 3, skyOpen: true,
    slabs: true, maxCells: 8e6, mirror: false, info: false, list: false,
    nodrawBlock: 'stone',
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
      case '--art': o.art.push(val()); break;
      case '--palette': o.palette = val(); break;
      case '--blocks': o.blocks = val(); break;
      case '--default-block': o.defaultBlock = val(); break;
      case '--rock-block': o.rockBlock = val(); break;
      case '--sprites': o.sprites = true; break;
      case '--sprites-blocking': o.sprites = true; o.spritesBlocking = true; break;
      case '--sprite-thickness': o.spriteThickness = parseFloat(val()); break;
      case '--pad': o.pad = parseInt(val(), 10); break;
      case '--shell': o.shell = parseInt(val(), 10); break;
      case '--no-sky-open': o.skyOpen = false; break;
      case '--no-slabs': o.slabs = false; break;
      case '--max-cells': o.maxCells = parseInt(val(), 10); break;
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

  const raw = fs.readFileSync(opt.input);
  const grp = readGrp(raw);
  let mapBuf, mapName;

  if (grp) {
    const maps = grpFind(grp, /\.MAP$/);
    if (opt.list) {
      console.log(`GRP, ${grp.entries.length} files, ${maps.length} map(s):`);
      for (const e of maps) console.log(`  ${e.name.padEnd(14)} ${e.size.toLocaleString().padStart(10)} bytes`);
      return;
    }
    if (!maps.length) throw new Error('no .MAP files in this GRP');
    let pick = maps[0];
    if (opt.map) {
      const want = opt.map.toUpperCase().replace(/\.MAP$/, '');
      pick = maps.find(e => e.name.replace(/\.MAP$/, '') === want);
      if (!pick) throw new Error(`map "${opt.map}" not in the GRP. Try --list.`);
    } else if (maps.length > 1) {
      console.warn(`note: GRP holds ${maps.length} maps, using ${pick.name}. Use --list / --map to pick.`);
    }
    mapBuf = grpRead(grp, pick);
    mapName = pick.name.replace(/\.MAP$/i, '');
  } else {
    if (opt.list) throw new Error('--list only applies to a .grp');
    mapBuf = raw;
    mapName = path.basename(opt.input).replace(/\.map$/i, '');
  }

  const m = readMap(mapBuf);
  if (!m.sectors.length) throw new Error('map has no sectors');

  /* --- tiles ------------------------------------------------------- */
  const tiles = new Map();
  let artFiles = 0, artTiles = 0;
  const palSrc = grp ? grpFind(grp, /^PALETTE\.DAT$/)[0] : null;
  let pal = null;
  if (palSrc) pal = readPaletteDat(grpRead(grp, palSrc));
  if (!pal && opt.art.length) {
    const near = path.join(path.dirname(opt.input), 'PALETTE.DAT');
    if (fs.existsSync(near)) pal = readPaletteDat(fs.readFileSync(near));
  }
  if (pal) {
    const sources = grp ? grpFind(grp, /^TILES\d+\.ART$/).map(e => grpRead(grp, e)) : [];
    for (const f of opt.art) sources.push(fs.readFileSync(f));
    for (const b of sources) { artTiles += readArt(b, pal, tiles); artFiles++; }
  }

  const tex = buildTileResolver(tiles, opt);

  /* --- bounds ------------------------------------------------------ */
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const w of m.walls) {
    if (w.x < minX) minX = w.x; if (w.x > maxX) maxX = w.x;
    if (w.y < minY) minY = w.y; if (w.y > maxY) maxY = w.y;
  }
  const surf = m.sectors.map(s => {
    const f = slopeFn(m, s, 'floor'), c = slopeFn(m, s, 'ceiling');
    return { f, c, fr: surfaceRange(m, s, f), cr: surfaceRange(m, s, c) };
  });
  let minZ = Infinity, maxZ = -Infinity, heights = [];
  surf.forEach((u, i) => {
    minZ = Math.min(minZ, u.fr[0], u.cr[0]);
    maxZ = Math.max(maxZ, u.fr[1], u.cr[1]);
    const h = (u.cr[0] + u.cr[1]) / 2 - (u.fr[0] + u.fr[1]) / 2;
    if (h > 0 && m.sectors[i].wallnum >= 3) heights.push(h);
  });
  heights.sort((a, b) => a - b);
  const medianH = heights.length ? heights[heights.length >> 1] : 0;

  const S = opt.scale, PAD = opt.pad * S;
  const LO = [minX - PAD, minY - PAD, minZ - PAD];
  const HI = [maxX + PAD, maxY + PAD, maxZ + PAD];
  const width = Math.max(1, Math.round((HI[0] - LO[0]) / S));
  const length = Math.max(1, Math.round((HI[1] - LO[1]) / S));
  const height = Math.max(1, Math.round((HI[2] - LO[2]) / S));
  const cells = width * height * length;
  const dims = { width, height, length, cells };

  const sloped = m.sectors.filter((s, i) => !surf[i].f.flat || !surf[i].c.flat).length;
  const parallax = m.sectors.filter(s => s.ceilingstat & 1).length;
  const wallAligned = m.sprites.filter(s => { const a = (s.cstat >> 4) & 3; return a === 1 || a === 2; }).length;

  /* --- how big is a person here? ------------------------------------ *
   * Every other converter in this set states a player height from memory and
   * divides. Build maps do not need that: the map header stores the player
   * start, and the engine puts posz at EYE height above the sector floor. So
   * the scale can be measured out of the file rather than asserted, which is
   * worth doing because Build's unit is small and unintuitive and the games
   * that use the format do not all agree on it.
   *
   * Minecraft's eye is 1.62 blocks up, so scale = eyeHeight / 1.62.
   */
  let eye = 0;
  if (m.start.sect >= 0 && m.start.sect < m.sectors.length) {
    const u = surf[m.start.sect];
    const h = Z(m.start.z) - u.f(m.start.x, m.start.y);
    if (h > 0 && h < 4096) eye = h;
  }
  const pow2 = (v) => Math.min(512, Math.max(8, Math.pow(2, Math.round(Math.log2(v)))));
  const suggest = eye ? pow2(eye / 1.62) : (medianH ? pow2(medianH / 4) : S);

  const report = () => {
    console.log(`map            ${mapName} (Build v${m.version}, ${m.sectors.length} sectors, ${m.walls.length} walls)`);
    console.log(`slopes         ${sloped} sector(s) with a sloped floor or ceiling`);
    console.log(`sprites        ${m.sprites.length} total, ${wallAligned} wall/floor-aligned` +
      (opt.sprites ? '' : ' (not converted; --sprites)'));
    console.log(`tiles          ` + (artTiles
      ? `${artTiles} from ${artFiles} ART file(s), colour-matched in Oklab`
      : (RBX ? 'no ART loaded - tiles fall back to --blocks and --default-block'
             : 'rbxl2mc.js not found - colour matching disabled')));
    console.log(`extent         ${maxX - minX} x ${maxY - minY} units, world z ${minZ.toFixed(0)} to ${maxZ.toFixed(0)}`);
    console.log(`scale          ` + (eye
      ? `player eye sits ${eye.toFixed(0)} units up -> suggested --scale ${suggest}`
      : `no usable player start; median room is ${medianH.toFixed(0)} units -> suggested --scale ${suggest}`));
    console.log(`grid at ${S}u    ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells`);
    if (parallax) console.log(`sky            ${parallax} sector(s) with a parallaxing ceiling` +
      (opt.skyOpen ? ' (left open)' : ' (capped)'));
    if (m.wallGaps) console.log(`note           ${m.wallGaps} sector(s) do not start where the previous one ended`);
    if (m.trailing > 0) console.log(`trailing       ${m.trailing} bytes after the sprite array` +
      (m.version >= 8 ? ' (eduke32 v' + m.version + ' extensions, not read)' : ''));
  };

  if (opt.info || cells > opt.maxCells) {
    report();
    if (cells > opt.maxCells) {
      console.error(`\nerror: ${cells.toLocaleString()} cells exceeds --max-cells ${opt.maxCells.toLocaleString()}.`);
      console.error(`       Raise --scale (try ${Math.max(suggest, S * 2)}) or --max-cells.`);
      process.exit(1);
    }
    if (opt.info) return;
  }

  /* --- surface brushes --------------------------------------------- *
   * Only the visible skin goes through the voxelizer - a shell one cell thick
   * hugging each floor and ceiling. That is where the slope detail lives, and
   * keeping the brushes thin keeps their bounding boxes small. Everything
   * below a floor and above a ceiling is bulk rock with no shape to it, so it
   * is filled in a flat pass afterwards instead.
   */
  const brushes = [];
  const testers = [];
  for (let i = 0; i < m.sectors.length; i++) {
    const s = m.sectors[i], u = surf[i];
    const inSec = sectorTester(m, s, LO, S, width, length);
    testers.push(inSec);
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    for (let w = s.wallptr; w < s.wallptr + s.wallnum; w++) {
      const wl = m.walls[w];
      if (wl.x < sx0) sx0 = wl.x; if (wl.x > sx1) sx1 = wl.x;
      if (wl.y < sy0) sy0 = wl.y; if (wl.y > sy1) sy1 = wl.y;
    }

    const fSuffix = u.f.flat ? '' : '!';
    brushes.push({
      material: `pic:${s.floorpicnum}${fSuffix}`,
      lo: [sx0, sy0, u.fr[0] - S], hi: [sx1, sy1, u.fr[1]],
      test: (p) => p[2] <= u.f(p[0], p[1]) && p[2] > u.f(p[0], p[1]) - S && inSec(p[0], p[1]),
    });

    if (!(opt.skyOpen && (s.ceilingstat & 1))) {
      const cSuffix = u.c.flat ? '' : '!';
      brushes.push({
        material: `pic:${s.ceilingpicnum}${cSuffix}`,
        lo: [sx0, sy0, u.cr[0]], hi: [sx1, sy1, u.cr[1] + S],
        test: (p) => p[2] >= u.c(p[0], p[1]) && p[2] < u.c(p[0], p[1]) + S && inSec(p[0], p[1]),
      });
    }
  }

  /* --- walls, as one-cell-thick vertical slabs ---------------------- *
   * A wall with no sector on the far side is the boundary of the map. It is
   * given real thickness here so that rooms have walls even where the void
   * fill does not reach, and so the wall's own tile is what shows.
   */
  let solidWalls = 0;
  for (let i = 0; i < m.sectors.length; i++) {
    const s = m.sectors[i], u = surf[i];
    // Centroid of the sector's walls. It need not be inside a concave sector,
    // but it is always on the interior side of the outer loop, which is all
    // this is used for: deciding which way is "out". Winding conventions vary
    // between editors, so deriving the direction beats assuming it - the same
    // reasoning map2mc applies to brush plane signs.
    let gx = 0, gy = 0;
    for (let w = s.wallptr; w < s.wallptr + s.wallnum; w++) { gx += m.walls[w].x; gy += m.walls[w].y; }
    gx /= s.wallnum; gy /= s.wallnum;

    for (let w = s.wallptr; w < s.wallptr + s.wallnum; w++) {
      const a = m.walls[w];
      if (a.nextsector >= 0) continue;                 // two-sided: no wall face here
      const b = m.walls[a.point2];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      solidWalls++;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      let nx = dy / len, ny = -dx / len;
      if ((mx - gx) * nx + (my - gy) * ny < 0) { nx = -nx; ny = -ny; }
      const t = S / 2;
      const cx = mx + nx * t / 2, cy = my + ny * t / 2;
      const ux = dx / len, uy = dy / len;
      // Span the whole opening, floor low point to ceiling high point. Any
      // overshoot lands in cells that would be rock anyway, and picks up the
      // wall's own tile instead of generic fill.
      const z0 = u.fr[0], z1 = u.cr[1];
      brushes.push({
        material: `pic:${a.picnum}`,
        lo: [Math.min(a.x, b.x) - t, Math.min(a.y, b.y) - t, Math.min(z0, z1)],
        hi: [Math.max(a.x, b.x) + t, Math.max(a.y, b.y) + t, Math.max(z0, z1)],
        test: (p) => {
          const px = p[0] - cx, py = p[1] - cy;
          return Math.abs(px * ux + py * uy) <= len / 2 &&
            Math.abs(px * nx + py * ny) <= t / 2 &&
            p[2] >= Math.min(z0, z1) && p[2] <= Math.max(z0, z1);
        },
      });
    }
  }

  /* --- sprites ------------------------------------------------------ */
  let spritesUsed = 0, spritesNoTile = 0;
  if (opt.sprites) {
    for (const sp of m.sprites) {
      const align = (sp.cstat >> 4) & 3;
      if (align !== 1 && align !== 2) continue;
      if (opt.spritesBlocking && !(sp.cstat & 1)) continue;
      const tile = tiles.get(sp.picnum);
      if (!tile) { spritesNoTile++; continue; }
      // A sprite quad has no thickness in Build. Give it half a cell, or the
      // voxelizer's subsamples pass straight through it and it vanishes.
      const box = spriteBox(sp, tile, opt.spriteThickness || S / 2);
      if (!box) continue;
      spritesUsed++;
      brushes.unshift({ material: `pic:${sp.picnum}`, lo: box.lo, hi: box.hi, test: box.test });
    }
  }

  /* --- voxelize ----------------------------------------------------- */
  const vopt = {
    scale: S, mirror: opt.mirror, format: opt.format,
    slabs: opt.slabs, nodrawBlock: opt.nodrawBlock,
  };
  const r = voxelize(brushes, LO, HI, dims, vopt, tex, '\u0000none');
  const { blocks, data, stateNames } = r;
  const wantStates = opt.format === 'sponge';
  const idx = (x, y, z) => (y * length + z) * width + x;

  /* --- bulk fill ----------------------------------------------------- *
   * One pass per column: below the floor and above the ceiling is rock, and a
   * column in no sector at all is rock all the way up. Only empty cells are
   * touched, so every slab and stair the voxelizer produced survives.
   */
  const rock = tex.get('rock');
  const put = (i, blk) => {
    blocks[i] = blk.id & 0xff; data[i] = blk.data & 0x0f;
    if (wantStates) stateNames[i] = `minecraft:${blk.full || blk.name}`;
  };

  // Row buckets, so a column only tests sectors whose footprint reaches it.
  const rows = Array.from({ length }, () => []);
  for (let i = 0; i < m.sectors.length; i++) {
    const s = m.sectors[i];
    let y0 = Infinity, y1 = -Infinity;
    for (let w = s.wallptr; w < s.wallptr + s.wallnum; w++) {
      const wy = m.walls[w].y;
      if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
    }
    for (let bz = 0; bz < length; bz++) {
      const wy = opt.mirror ? LO[1] + (bz + 0.5) * S : HI[1] - (bz + 0.5) * S;
      if (wy >= y0 - S && wy <= y1 + S) rows[bz].push(i);
    }
  }

  let inside = 0, outside = 0, skyCols = 0, filled = 0;
  for (let bz = 0; bz < length; bz++) {
    const wy = opt.mirror ? LO[1] + (bz + 0.5) * S : HI[1] - (bz + 0.5) * S;
    for (let bx = 0; bx < width; bx++) {
      const wx = LO[0] + (bx + 0.5) * S;
      let si = -1;
      for (const c of rows[bz]) if (testers[c](wx, wy)) { si = c; break; }

      if (si < 0) {
        outside++;
        for (let by = 0; by < height; by++) {
          const i = idx(bx, by, bz);
          if (!blocks[i]) { put(i, rock); filled++; }
        }
        continue;
      }
      inside++;
      const u = surf[si];
      const fz = u.f(wx, wy), cz = u.c(wx, wy);
      const sky = opt.skyOpen && (m.sectors[si].ceilingstat & 1);
      if (sky) skyCols++;

      // The skin brush is one cell thick measured DOWN from the surface, so it
      // generally straddles two cells: the surface cell gets its lower part and
      // the cell beneath gets the rest. Left alone that second cell resolves to
      // a top slab with a void under it - a floor two cells thick with a seam
      // through it. So identify the cell the surface actually passes through
      // and force everything past it to a full cube, overwriting rather than
      // filling gaps. Only the surface cell keeps its slab or stair shape.
      const byFloor = Math.floor((fz - LO[2]) / S);
      const byCeil = Math.floor((cz - LO[2]) / S);
      for (let by = 0; by < height; by++) {
        const i = idx(bx, by, bz);
        if (by < byFloor || (!sky && by > byCeil)) {
          if (!blocks[i]) filled++;
          put(i, rock);                                 // buried: always full rock
        } else if (by === byFloor || (!sky && by === byCeil)) {
          if (!blocks[i]) { put(i, rock); filled++; }    // the surface cell keeps its shape
        }
        // between the two: open space, or whatever a wall or sprite put there
      }
    }
  }

  /* --- shell trim ----------------------------------------------------- */
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
  const outFile = opt.out || path.join(path.dirname(opt.input), mapName + ext);
  fs.writeFileSync(outFile, opt.format === 'sponge' ? writeSponge(grid) : writeMcEdit(grid));

  report();
  console.log(`surfaces       ${brushes.length} surface volumes (${solidWalls} one-sided walls` +
    (spritesUsed ? `, ${spritesUsed} sprites` : '') + ')');
  console.log(`columns        ${inside.toLocaleString()} in sectors, ${outside.toLocaleString()} void, ${skyCols.toLocaleString()} under sky`);
  console.log(`shapes         ${r.slabs.toLocaleString()} slabs, ${r.stairs.toLocaleString()} stairs from sloped surfaces`);
  if (opt.shell > 0) console.log(`shell          ${trimmed.toLocaleString()} rock cells trimmed beyond ${opt.shell} blocks`);
  console.log(`fill           ${(100 * solid / cells).toFixed(2)}% of the grid`);
  console.log(`filled         ${solid.toLocaleString()} blocks`);
  console.log(`wrote          ${outFile}`);

  // Below proportional is a deliberate trade (detail over scale). Above it is
  // not: corridors start coming out narrower than a player.
  if (S > suggest)
    console.warn(`\n!! --scale ${S} is coarser than this map's own proportions (${suggest}). Doorways and\n` +
      '   corridors will come out too narrow to walk down. Lower --scale.');
  else if (S < suggest / 8)
    console.warn(`\n!! --scale ${S} is ${(suggest / S).toFixed(0)}x finer than proportional for this map, which is a lot\n` +
      `   of cells for the detail gained. ${suggest / 4} would still be generous.`);
  if (opt.sprites && spritesNoTile)
    console.warn(`\n!! ${spritesNoTile} sprite(s) skipped: their tile is not in any loaded ART, so their\n` +
      '   world size is unknown. Point --art at the right TILESnnn.ART.');
  // Colour matching already restricts sloped surfaces to blocks that have slab
  // and stair forms. A --blocks override is taken at its word, so it can hand a
  // ramp a block that cannot be a step - in which case the ramp silently comes
  // back as full cubes. Say so rather than let it pass.
  const SLABBABLE = new Set(['stone', 'cobblestone', 'bricks', 'stone_bricks', 'sandstone',
    'quartz_block', 'nether_bricks', 'red_sandstone', 'purpur_block', 'planks']);
  const flattened = new Set();
  for (let i = 0; i < m.sectors.length; i++) {
    if (surf[i].f.flat && surf[i].c.flat) continue;
    for (const [pic, kind] of [[m.sectors[i].floorpicnum, 'f'], [m.sectors[i].ceilingpicnum, 'c']]) {
      if (surf[i][kind].flat) continue;
      const blk = tex.get(`pic:${pic}!`);
      if (!SLABBABLE.has(blk.name)) flattened.add(`${pic} -> ${blk.full}`);
    }
  }
  if (opt.slabs && flattened.size)
    console.warn(`\n!! ${flattened.size} sloped surface(s) use a block with no slab or stair form, so those\n` +
      `   slopes came out as full cubes: ${[...flattened].slice(0, 5).join(', ')}\n` +
      '   Point them at stone, cobblestone, bricks, stone_bricks, sandstone, quartz_block\n' +
      '   or a planks variant if the steps matter.');

  if (tex.unresolved.size) {
    const list = [...tex.unresolved.keys()].sort((a, b) => a - b);
    console.warn(`\n!! ${list.length} tile(s) had no colour and no override, so they became ${opt.defaultBlock}:`);
    console.warn('   picnum ' + list.slice(0, 20).join(' ') + (list.length > 20 ? ` ... +${list.length - 20} more` : ''));
    console.warn('   Map them with --blocks map.json, e.g. {"1234": "stone_bricks", "300-360": "sand"}');
    if (!tex.canColour) console.warn(RBX
      ? '   Or point the converter at the game\'s ART: run it on the .grp, or use --art.'
      : '   Or put rbxl2mc.js alongside this script to enable Oklab tile colour matching.');
  }
}

module.exports = { readGrp, readMap, readArt, readPaletteDat, slopeFn, sectorTester, spriteBox };

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}
