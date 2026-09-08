#!/usr/bin/env node
/**
 * halo2mc.js - Halo: Combat Evolved .map cache files into a Minecraft
 * schematic. Xbox, Gearbox PC and Custom Edition.
 *
 *   node halo2mc.js bloodgulch.map --info
 *   node halo2mc.js bloodgulch.map --scale 0.4
 *
 * Halo has no brushes at all. Level geometry is authored as a triangle mesh
 * and compiled, so on the face of it this is the mesh problem the rest of this
 * project doesn't solve. Except the compiler also emits a COLLISION BSP: a
 * tree of dividing planes with convex leaves, which is exactly the structure
 * bsp2mc already classifies GoldSrc through. Voxelization doesn't need
 * geometry, it needs "is this point solid", and a BSP tree answers that
 * exactly. So this reuses bsp2mc's GoldSrc strategy on a completely different
 * engine's tree.
 *
 * WHAT IS DIFFERENT HERE: nothing in this file trusts a hardcoded tag offset.
 *
 * The cache format is documented by the community (c20, Invader), but I had no
 * retail map to check any specific offset against, and a wrong offset in a tag
 * struct does not error - it yields plausible garbage. So every structure is
 * LOCATED BY SEARCH and then confirmed against invariants that arbitrary data
 * cannot satisfy: pointers that must rebase into their own region, index
 * fields that must all fall in range across thousands of records, signatures
 * that must appear where the search predicts. Where a convention could go
 * either way - fourCC byte order, which side of the tree is solid - it is
 * derived from the file rather than assumed.
 *
 * Requires vmf2mc.js. No other dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VMF = path.join(__dirname, 'vmf2mc.js');
if (!fs.existsSync(VMF)) {
  console.error('error: vmf2mc.js must be in the same folder as halo2mc.js.');
  process.exit(1);
}
const { writeMcEdit, writeSponge, nameToLegacy } = require(VMF);

/* ------------------------------------------------------------------ *
 * 1. Cache header
 * ------------------------------------------------------------------ */

const HEAD = 0x68656164, FOOT = 0x666f6f74;   // "head", "foot"

/**
 * The signature and the file's byte order are two separate questions, and
 * answering the first does not answer the second: "head" written as a
 * little-endian int lands in the file as "daeh", and I have no retail map to
 * settle which convention Halo 1 actually uses. So accept the signature either
 * way, and settle endianness on evidence instead - read the offsets both ways
 * and keep the reading in which the tag data actually fits inside the file.
 * Only one of the two can be right, and the wrong one misses by megabytes.
 */
function readHeader(B) {
  if (B.length < 2048) throw new Error('file is shorter than a 2048-byte cache header');

  const sigOk = (o, want) => B.readUInt32LE(o) === want || B.readUInt32BE(o) === want;
  if (!sigOk(0, HEAD))
    throw new Error('no "head" signature - this is not a Halo cache file ' +
      '(a .map from Halo 3 onward is a module, not a cache)');
  if (!sigOk(2044, FOOT))
    throw new Error('no "foot" signature at 2044 - header is the wrong size, so this is ' +
      'probably not Halo 1');

  const tryOrder = (be) => {
    const rd = (o) => (be ? B.readUInt32BE(o) : B.readUInt32LE(o));
    const tagIndexOffset = rd(16), tagDataSize = rd(20), fileSize = rd(8);
    const fits = tagIndexOffset >= 2048 && tagDataSize > 40 &&
      tagIndexOffset + tagDataSize <= B.length &&
      fileSize > 2048 && fileSize <= B.length * 2;
    return { be, rd, tagIndexOffset, tagDataSize, fileSize, fits };
  };
  const le = tryOrder(false), bex = tryOrder(true);
  const pick = le.fits ? le : bex.fits ? bex : null;
  if (!pick)
    throw new Error('neither byte order gives a tag index that fits inside the file - ' +
      'the header is not laid out the way this reader expects');
  if (pick.be)
    throw new Error('this cache is big-endian, so it is an Xbox 360 map (Halo 3 / ODST / ' +
      'Reach). Only Halo 1 is supported.');

  const str = (o, n) => B.toString('ascii', o, o + n).replace(/\0.*$/, '');
  const h = {
    version: pick.rd(4),
    fileSize: pick.fileSize,
    tagIndexOffset: pick.tagIndexOffset,
    tagDataSize: pick.tagDataSize,
    name: str(32, 32),
    build: str(64, 32),
    mapType: pick.rd(96),
    sigAscii: B.toString('latin1', 0, 4) === 'head',
  };

  // Version tells us the engine, but it is only a label - nothing below depends
  // on it, because everything below is derived rather than looked up per engine.
  h.engine = { 5: 'Xbox', 6: 'Demo', 7: 'PC (retail)', 609: 'Custom Edition' }[h.version] || `unknown (${h.version})`;
  return h;
}

/* ------------------------------------------------------------------ *
 * 2. Tag index
 *
 * The tag data block is mapped into memory at a fixed base, so every pointer
 * inside it needs rebasing to a file offset. The base differs between Xbox and
 * PC and I have no way to check either constant, so it is not used: the first
 * field of the tag index header is a pointer to the tag array, and the tag
 * array begins immediately after that 40-byte header. That equation has one
 * unknown.
 *
 *     rebase(tagArrayPointer) == tagIndexOffset + 40
 *     => base = tagArrayPointer - 40
 *
 * Exact, engine-independent, and then confirmed by the "tags" signature landing
 * where it should and by every tag path rebasing to printable text.
 * ------------------------------------------------------------------ */

// The fourCC is stored reversed in the file ("sgat"), the same way tag classes
// are ("rncs" for scnr). Which end it is written from is exactly the kind of
// convention this file does not assume, so accept either.
const TAGS_SIG = 0x73676174, TAGS_SIG_REV = 0x74616773;   // "tags" / "sgat"
const TAG_ENTRY = 32, INDEX_HEADER = 40;

function readTagIndex(B, h) {
  const o = h.tagIndexOffset;
  const tagArrayPointer = B.readUInt32LE(o);
  const scenarioTagId = B.readUInt32LE(o + 4);
  const tagCount = B.readUInt32LE(o + 12);
  const sig = B.readUInt32LE(o + 36);

  if (sig !== TAGS_SIG && sig !== TAGS_SIG_REV)
    throw new Error('no "tags" signature at the end of the tag index header - either this is ' +
      'not a Halo 1 cache or the header layout differs from the one this reader expects');
  if (tagCount === 0 || tagCount > 65535)
    throw new Error(`tag count ${tagCount} is not credible`);

  const base = tagArrayPointer - INDEX_HEADER;
  const rebase = (p) => p - base + o;
  const inTagData = (f) => f >= o && f < o + h.tagDataSize;

  if (!inTagData(rebase(tagArrayPointer)))
    throw new Error('the tag array does not rebase into the tag data block');
  if (o + INDEX_HEADER + tagCount * TAG_ENTRY > o + h.tagDataSize)
    throw new Error(`${tagCount} tag entries do not fit in ${h.tagDataSize} bytes of tag data`);

  // fourCC byte order: classes are stored reversed, but rather than assume it,
  // read both ways and keep whichever produces a scenario tag at the id the
  // index header points at. One of the two orders will; the other will not.
  const readCC = (p, rev) => {
    const s = B.toString('latin1', p, p + 4);
    return rev ? s.split('').reverse().join('') : s;
  };

  const parse = (rev) => {
    const tags = [];
    for (let i = 0; i < tagCount; i++) {
      const e = o + INDEX_HEADER + i * TAG_ENTRY;
      const pathPtr = B.readUInt32LE(e + 16);
      const metaPtr = B.readUInt32LE(e + 20);
      const pf = rebase(pathPtr);
      let name = '';
      if (inTagData(pf)) {
        const end = B.indexOf(0, pf);
        if (end > pf && end - pf < 256) name = B.toString('latin1', pf, end);
      }
      tags.push({
        i,
        cls: readCC(e, rev),
        id: B.readUInt32LE(e + 12),
        name,
        meta: metaPtr,
        metaFile: rebase(metaPtr),
        indexed: B.readUInt32LE(e + 24) !== 0,
      });
    }
    return tags;
  };

  let tags = parse(true), reversed = true;
  const wantIdx = scenarioTagId & 0xffff;
  const isScnr = (t) => t && t.cls === 'scnr';
  if (!isScnr(tags[wantIdx])) {
    const alt = parse(false);
    if (isScnr(alt[wantIdx])) { tags = alt; reversed = false; }
  }

  // Printable, plausible tag paths across the whole array is the check that the
  // 32-byte entry stride is right. A wrong stride produces junk immediately.
  const named = tags.filter(t => t.name && /^[\x20-\x7e]+$/.test(t.name)).length;
  if (named < tagCount * 0.5)
    throw new Error(`only ${named} of ${tagCount} tags have a readable path - the tag entry ` +
      'layout does not match this file');

  return { tags, base, rebase, inTagData, reversed, scenarioTagId,
    scenario: tags[wantIdx], named };
}

/* ------------------------------------------------------------------ *
 * 3. Finding the structure BSPs
 *
 * A scenario's structure_bsps block holds, per BSP, the raw file offset of its
 * data, its size, and the address that data is mapped to - which is the rebase
 * key for everything inside it. Rather than index the scenario tag at a fixed
 * offset, scan the tag data for that 32-byte record. Its shape is unusually
 * constrained: two plausible file offsets, a mapping address, four zero bytes,
 * then a tag reference whose class is sbsp and whose id resolves to a tag that
 * really is an sbsp.
 *
 * Then confirm: the record says the BSP data starts at some file offset, and
 * the first thing there should be a 16-byte header whose own pointer rebases to
 * just past itself and which carries an sbsp signature. Two independent sources
 * agreeing on the same address is what makes this safe.
 * ------------------------------------------------------------------ */

function findStructureBsps(B, h, idx) {
  const cc = (s) => (idx.reversed ? s.split('').reverse().join('') : s);
  const SBSP = Buffer.from(cc('sbsp'), 'latin1');
  const lo = h.tagIndexOffset, hi = h.tagIndexOffset + h.tagDataSize;
  const byId = new Map(idx.tags.map(t => [t.id, t]));

  const found = [];
  for (let p = lo; p + 32 <= hi; p += 4) {
    if (B.compare(SBSP, 0, 4, p + 16, p + 20) !== 0) continue;
    const start = B.readUInt32LE(p), size = B.readUInt32LE(p + 4);
    const magic = B.readUInt32LE(p + 8), zero = B.readUInt32LE(p + 12);
    const tagId = B.readUInt32LE(p + 28);
    if (zero !== 0) continue;
    if (start < 2048 || size < 64 || start + size > B.length) continue;
    if (magic < 0x1000) continue;
    const tag = byId.get(tagId);
    if (!tag || tag.cls !== 'sbsp') continue;

    // Header cross-check: the BSP data opens with a small header that ends in
    // an sbsp fourCC and whose first field points at its own end. Its length is
    // not the same across engines, so don't assume one - accept whichever
    // length makes BOTH facts true at once. Two independent agreements on the
    // same boundary is the check; the length itself is just what falls out.
    const rebase = (q) => q - magic + start;
    const hdrPtr = B.readUInt32LE(start);
    let hdrSize = 0;
    for (let n = 8; n <= 64; n += 4) {
      if (start + n > B.length) break;
      if (rebase(hdrPtr) !== start + n) continue;
      if (B.compare(SBSP, 0, 4, start + n - 4, start + n) !== 0) continue;
      hdrSize = n; break;
    }
    if (!hdrSize) continue;

    found.push({ start, size, magic, rebase, tag, refAt: p, hdrSize,
      dataStart: start + hdrSize, dataEnd: start + size });
  }
  // The same BSP can be referenced more than once; keep one of each.
  const seen = new Set();
  return found.filter(b => !seen.has(b.start) && seen.add(b.start));
}

/* ------------------------------------------------------------------ *
 * 4. The collision BSP
 *
 * A collision_bsp element is eight consecutive tag blocks - node tree, planes,
 * leaves, the 2D reference structures, then the surface / edge / vertex mesh.
 * Each block is (count, pointer, zero), so the element is 96 bytes of a very
 * particular shape, and it is found by scanning the BSP's own tag data for it.
 *
 * Shape alone would produce false positives on a big enough file. What makes
 * this safe is that the element is then loaded and every cross-reference is
 * range-checked: each node's plane index against the plane count, each child
 * against the node and leaf counts, each surface's first edge against the edge
 * count, each edge's vertices against the vertex count. Thousands of indices
 * all landing in range cannot happen by chance, and it simultaneously confirms
 * every element size below - a wrong stride desynchronises and the indices go
 * wild within a few records.
 * ------------------------------------------------------------------ */

const SZ = { node: 12, plane: 16, leaf: 8, ref2d: 8, node2d: 20, surface: 12, edge: 24, vertex: 16 };
const BLOCK_ORDER = ['nodes', 'planes', 'leaves', 'refs2d', 'nodes2d', 'surfaces', 'edges', 'vertices'];
const BLOCK_SIZE = [SZ.node, SZ.plane, SZ.leaf, SZ.ref2d, SZ.node2d, SZ.surface, SZ.edge, SZ.vertex];

function scanCollisionBsp(B, bsp) {
  const { dataStart, dataEnd, rebase } = bsp;
  const results = [];

  for (let p = dataStart; p + 96 <= dataEnd; p += 4) {
    const blocks = [];
    let ok = true;
    for (let k = 0; k < 8 && ok; k++) {
      const count = B.readUInt32LE(p + k * 12);
      const ptr = B.readUInt32LE(p + k * 12 + 4);
      const pad = B.readUInt32LE(p + k * 12 + 8);
      if (pad !== 0) { ok = false; break; }
      if (count > 4000000) { ok = false; break; }
      if (count === 0) { blocks.push({ count, at: 0 }); continue; }
      const at = rebase(ptr);
      if (at < dataStart || at + count * BLOCK_SIZE[k] > dataEnd) { ok = false; break; }
      blocks.push({ count, at });
    }
    if (!ok) continue;

    const b = {};
    BLOCK_ORDER.forEach((n, k) => { b[n] = blocks[k]; });
    if (!b.nodes.count || !b.planes.count || !b.surfaces.count || !b.edges.count || !b.vertices.count)
      continue;

    const cbsp = loadCollisionBsp(B, b);
    if (!cbsp) continue;
    cbsp.at = p;
    // Blocks are normally serialised back to back in declaration order. It is
    // not required for correctness here, but when it holds it is one more
    // independent confirmation that every stride is right.
    cbsp.contiguous = checkContiguity(blocks);
    results.push(cbsp);
  }

  // Prefer the candidate with the most geometry: a false positive that somehow
  // passed every range check would be a tiny one.
  results.sort((a, b2) => b2.surfaces.length - a.surfaces.length);
  return results[0] || null;
}

function checkContiguity(blocks) {
  const live = blocks.map((b, k) => ({ ...b, size: BLOCK_SIZE[k] })).filter(b => b.count > 0);
  live.sort((a, b) => a.at - b.at);
  for (let i = 0; i + 1 < live.length; i++)
    if (live[i].at + live[i].count * live[i].size !== live[i + 1].at) return false;
  return true;
}

function loadCollisionBsp(B, b) {
  const nodes = new Int32Array(b.nodes.count * 3);
  for (let i = 0; i < nodes.length; i++) nodes[i] = B.readInt32LE(b.nodes.at + i * 4);

  const planes = new Float64Array(b.planes.count * 4);
  for (let i = 0; i < planes.length; i++) planes[i] = B.readFloatLE(b.planes.at + i * 4);

  const nPlanes = b.planes.count, nNodes = b.nodes.count, nLeaves = b.leaves.count;

  // Node tree. A child is -1 for "no leaf", a leaf index with the top bit set,
  // or another node index. All three cases are bounded, so all three are checked.
  for (let i = 0; i < nNodes; i++) {
    const pl = nodes[i * 3];
    if (pl < 0 || pl >= nPlanes) return null;
    for (let c = 1; c <= 2; c++) {
      const v = nodes[i * 3 + c];
      if (v === -1) continue;
      if (v < 0) { if ((v & 0x7fffffff) >= nLeaves) return null; }
      else if (v >= nNodes) return null;
    }
  }
  // A plane whose normal is not unit length means these are not planes.
  for (let i = 0; i < nPlanes; i++) {
    const n = Math.hypot(planes[i * 4], planes[i * 4 + 1], planes[i * 4 + 2]);
    if (!(n > 0.9 && n < 1.1)) return null;
  }

  const surfaces = new Int32Array(b.surfaces.count * 3);   // plane, firstEdge, material
  for (let i = 0; i < b.surfaces.count; i++) {
    const o = b.surfaces.at + i * SZ.surface;
    const pl = B.readInt32LE(o) & 0x7fffffff;
    const fe = B.readInt32LE(o + 4);
    if (pl >= nPlanes) return null;
    if (fe < 0 || fe >= b.edges.count) return null;
    surfaces[i * 3] = B.readInt32LE(o);
    surfaces[i * 3 + 1] = fe;
    surfaces[i * 3 + 2] = B.readInt16LE(o + 10);
  }

  const edges = new Int32Array(b.edges.count * 6);
  for (let i = 0; i < b.edges.count; i++) {
    const o = b.edges.at + i * SZ.edge;
    for (let k = 0; k < 6; k++) edges[i * 6 + k] = B.readInt32LE(o + k * 4);
    const sv = edges[i * 6], ev = edges[i * 6 + 1];
    const fe = edges[i * 6 + 2], re = edges[i * 6 + 3];
    const ls = edges[i * 6 + 4], rs = edges[i * 6 + 5];
    if (sv < 0 || sv >= b.vertices.count || ev < 0 || ev >= b.vertices.count) return null;
    if (fe < 0 || fe >= b.edges.count || re < 0 || re >= b.edges.count) return null;
    if (ls < -1 || ls >= b.surfaces.count || rs < -1 || rs >= b.surfaces.count) return null;
  }

  const verts = new Float64Array(b.vertices.count * 3);
  for (let i = 0; i < b.vertices.count; i++) {
    const o = b.vertices.at + i * SZ.vertex;
    verts[i * 3] = B.readFloatLE(o);
    verts[i * 3 + 1] = B.readFloatLE(o + 4);
    verts[i * 3 + 2] = B.readFloatLE(o + 8);
    if (!Number.isFinite(verts[i * 3]) || Math.abs(verts[i * 3]) > 1e6) return null;
  }

  return { nodes, planes, surfaces, edges, verts,
    counts: BLOCK_ORDER.reduce((a, n) => (a[n] = b[n].count, a), {}) };
}

/* ------------------------------------------------------------------ *
 * 5. Point classification, with the polarity worked out from the map
 *
 * Descend the tree: positive side of the plane goes to the front child.
 * Landing on a leaf means one thing and landing on -1 means the other, and
 * documentation could plausibly be read either way round. Getting it backwards
 * turns a level inside out, so it is not assumed - it is measured.
 *
 * Probe points well outside the level's bounding box. A Halo BSP is a sealed
 * world, so every one of those is outside it, and whichever class they land in
 * is by definition the class that is not the playable interior.
 * ------------------------------------------------------------------ */

function makeClassifier(cb) {
  const { nodes, planes } = cb;
  // -1 => no leaf, >=0 => leaf index
  return function leafAt(x, y, z) {
    let n = 0;
    for (let guard = 0; guard < 256; guard++) {
      const pl = nodes[n * 3] * 4;
      const d = planes[pl] * x + planes[pl + 1] * y + planes[pl + 2] * z - planes[pl + 3];
      const c = nodes[n * 3 + (d >= 0 ? 2 : 1)];
      if (c === -1) return -1;
      if (c < 0) return c & 0x7fffffff;
      n = c;
    }
    return -1;
  };
}

function decidePolarity(cb, leafAt, LO, HI) {
  const pad = 1 + Math.max(HI[0] - LO[0], HI[1] - LO[1], HI[2] - LO[2]);
  const probes = [];
  for (let i = 0; i < 8; i++)
    probes.push([(i & 1) ? HI[0] + pad : LO[0] - pad,
                 (i & 2) ? HI[1] + pad : LO[1] - pad,
                 (i & 4) ? HI[2] + pad : LO[2] - pad]);
  for (const a of [0, 1, 2]) {
    const p = [(LO[0] + HI[0]) / 2, (LO[1] + HI[1]) / 2, (LO[2] + HI[2]) / 2];
    p[a] = HI[a] + pad; probes.push(p.slice());
    p[a] = LO[a] - pad; probes.push(p.slice());
  }
  let leaf = 0, noleaf = 0;
  for (const p of probes) (leafAt(p[0], p[1], p[2]) === -1 ? noleaf++ : leaf++);
  return {
    // "outside the sealed world" landed here, so this class is not interior.
    solidIsNoLeaf: noleaf >= leaf,
    unanimous: leaf === 0 || noleaf === 0,
    leaf, noleaf, probes: probes.length,
  };
}

/* ------------------------------------------------------------------ *
 * 6. Collision materials
 *
 * Each surface carries a material index into the BSP's collision_materials
 * block, whose elements are a tag reference to a shader. In a cache file the
 * reference's name pointer is dead and only the tag id is meaningful, so the
 * id is resolved through the tag index to get the shader's path - and a path
 * like "levels\a30\shaders\rock_ground" is a name, which is something the
 * keyword tables in this project already know how to handle.
 *
 * Located by search like everything else. The signature is strong: a run of
 * 20-byte records whose first four bytes are a shader class and whose tag ids
 * all resolve. Random data does not contain runs of valid tag ids.
 * ------------------------------------------------------------------ */

const SHADER_CLASSES = ['senv', 'soso', 'sotr', 'schi', 'scex', 'swat', 'sgla', 'smet', 'spla', 'shdr'];

function scanCollisionMaterials(B, bsp, idx) {
  const cc = (s) => (idx.reversed ? s.split('').reverse().join('') : s);
  const classes = new Set(SHADER_CLASSES.map(cc));
  const byId = new Map(idx.tags.map(t => [t.id, t]));
  const { dataStart, dataEnd, rebase } = bsp;
  let best = null;

  for (let p = dataStart; p + 12 <= dataEnd; p += 4) {
    const count = B.readUInt32LE(p), ptr = B.readUInt32LE(p + 4), pad = B.readUInt32LE(p + 8);
    if (pad !== 0 || count === 0 || count > 2048) continue;
    const at = rebase(ptr);
    if (at < dataStart || at + count * 20 > dataEnd) continue;

    const mats = [];
    let ok = true;
    for (let i = 0; i < count && ok; i++) {
      const o = at + i * 20;
      if (!classes.has(B.toString('latin1', o, o + 4))) { ok = false; break; }
      const tag = byId.get(B.readUInt32LE(o + 12));
      if (!tag) { ok = false; break; }
      mats.push(tag.name || '');
    }
    if (!ok) continue;
    if (!best || mats.length > best.length) best = mats;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * 7. Surfaces -> polygons
 *
 * Winged edges: each edge knows the surface on its left and right and the next
 * edge going each way. Walk the loop, taking the start vertex when this surface
 * is on the left and the end vertex when it is on the right.
 * ------------------------------------------------------------------ */

function surfacePoly(cb, si) {
  const first = cb.surfaces[si * 3 + 1];
  const out = [];
  let e = first;
  for (let guard = 0; guard < 256; guard++) {
    const o = e * 6;
    const left = cb.edges[o + 4] === si;
    const v = left ? cb.edges[o] : cb.edges[o + 1];
    out.push([cb.verts[v * 3], cb.verts[v * 3 + 1], cb.verts[v * 3 + 2]]);
    e = left ? cb.edges[o + 2] : cb.edges[o + 3];
    if (e === first) return out;
    if (e < 0) break;
  }
  return out.length >= 3 ? out : [];
}

/* ------------------------------------------------------------------ *
 * 8. Blocks
 * ------------------------------------------------------------------ */

const TEX_RULES = [
  [/water|ocean|river|coolant/, 'water'],
  [/lava|magma/, 'lava'],
  [/glass|window/, 'glass'],
  [/light|lamp|glow|holo/, 'glowstone'],
  [/grate|grill|fence|vent/, 'iron_bars'],
  [/sand|beach|dune/, 'sandstone'],
  [/snow|ice|frost/, 'snow_block'],
  [/grass|moss|foliage|tree|bush/, 'grass_block'],
  [/dirt|mud|ground|soil/, 'dirt'],
  [/rock|cliff|stone|gravel|boulder|canyon/, 'cobblestone'],
  [/metal|steel|iron|panel|hull|deck|plate|girder|machine|console|tech/, 'iron_block'],
  [/wood|plank|crate/, 'planks'],
  [/brick/, 'bricks'],
  [/concrete|cement|floor|wall|ceiling|column|pillar|structure|hall|base/, 'stone_bricks'],
  [/covenant|cov_|purple|alien/, 'purpur_block'],
];

function buildTexResolver(overrideFile, defaultBlock) {
  const overrides = overrideFile ? JSON.parse(fs.readFileSync(overrideFile, 'utf8')) : {};
  const cache = new Map();
  const unresolved = new Map();
  return {
    unresolved,
    get(name) {
      if (!name) return null;
      if (cache.has(name)) return cache.get(name);
      const low = name.toLowerCase();
      let blk = null;
      for (const [k, v] of Object.entries(overrides))
        if (low.includes(k.toLowerCase())) { blk = v; break; }
      if (!blk) for (const [re, b] of TEX_RULES) if (re.test(low)) { blk = b; break; }
      if (!blk) { unresolved.set(name, (unresolved.get(name) || 0) + 1); blk = defaultBlock; }
      const out = { ...nameToLegacy(blk), full: blk };
      cache.set(name, out);
      return out;
    },
  };
}

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
 * 9. Main
 * ------------------------------------------------------------------ */

const HELP = `
halo2mc - Halo: Combat Evolved .map -> Minecraft schematic

  node halo2mc.js <map.map> [options]

  Reads the cache file directly and classifies points through the collision
  BSP, the same way bsp2mc handles GoldSrc. Xbox, Gearbox PC and Custom
  Edition. Halo 2 onward are different formats and are refused by name.

  --bsp <n>             which structure BSP to convert (default 0; a campaign
                        map has several and the game only loads one at a time)
  --out <file>          output path (default: map name + .schematic)
  --scale <n>           world units per block (default 0.4). A Halo world unit
                        is 10 feet, so unlike every other converter here the
                        source unit is BIGGER than a block and this is a
                        fraction. 0.4 puts a Spartan at about 1.75 blocks
  --format mcedit|sponge  .schematic (legacy) or .schem (Sponge v2)
  --blocks <f.json>     shader path substring -> block, {"rock":"andesite"}
  --default-block <n>   block for shaders no rule matched (stone)
  --shell <n>           keep only n blocks of solid around open space
                        (default 3; Halo BSPs are solid outside the level)
  --no-shell            keep the full solid, which is mostly a giant cube
  --no-slabs            full cubes only; no slope reconstruction
  --max-cells <n>       refuse maps above this cell count (default 8,000,000)
  --mirror              flip handedness
  --list                list the structure BSPs and exit
  --info                report what would be converted, write nothing
  --explain             also show how each structure was located and confirmed
`;

function parseArgs(argv) {
  const o = { scale: 0.4, format: 'mcedit', out: null, bsp: 0, blocks: null,
    defaultBlock: 'stone', shell: 3, slabs: true, maxCells: 8e6, mirror: false,
    info: false, list: false, explain: false };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const val = () => argv[++i];
    if (!a.startsWith('--')) { files.push(a); continue; }
    switch (a) {
      case '--out': o.out = val(); break;
      case '--bsp': o.bsp = parseInt(val(), 10); break;
      case '--scale': o.scale = parseFloat(val()); break;
      case '--format': o.format = val(); break;
      case '--blocks': o.blocks = val(); break;
      case '--default-block': o.defaultBlock = val(); break;
      case '--shell': o.shell = parseInt(val(), 10); break;
      case '--no-shell': o.shell = 0; break;
      case '--no-slabs': o.slabs = false; break;
      case '--max-cells': o.maxCells = parseInt(val(), 10); break;
      case '--mirror': o.mirror = true; break;
      case '--list': o.list = true; break;
      case '--info': o.info = true; break;
      case '--explain': o.explain = true; break;
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
  const h = readHeader(B);
  const idx = readTagIndex(B, h);
  if (!idx.scenario || idx.scenario.cls !== 'scnr')
    throw new Error('the tag the index points at is not a scenario - cannot locate the BSPs');

  const bsps = findStructureBsps(B, h, idx);
  if (!bsps.length)
    throw new Error('found no structure BSP references in the scenario. If this map opens in ' +
      'the game, the reference layout differs from the one searched for here.');

  if (opt.list) {
    console.log(`${h.name} (${h.engine}, ${idx.tags.length} tags), ${bsps.length} structure BSP(s):`);
    bsps.forEach((b, i) => console.log(
      `  ${String(i).padStart(2)}  ${(b.tag.name || '(unnamed)').padEnd(48)} ` +
      `${b.size.toLocaleString().padStart(12)} bytes at ${b.start}`));
    return;
  }

  if (opt.bsp < 0 || opt.bsp >= bsps.length)
    throw new Error(`--bsp ${opt.bsp} out of range; this map has ${bsps.length}. Try --list.`);
  const bsp = bsps[opt.bsp];

  const cb = scanCollisionBsp(B, bsp);
  if (!cb)
    throw new Error('no collision BSP in this structure BSP passed validation. The block layout ' +
      'differs from the one this reader searches for.');

  const mats = scanCollisionMaterials(B, bsp, idx);
  const tex = buildTexResolver(opt.blocks, opt.defaultBlock);

  /* --- bounds and grid --- */
  const LO = [Infinity, Infinity, Infinity], HI = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < cb.counts.vertices; i++)
    for (let k = 0; k < 3; k++) {
      const v = cb.verts[i * 3 + k];
      if (v < LO[k]) LO[k] = v;
      if (v > HI[k]) HI[k] = v;
    }
  const S = opt.scale;
  for (let k = 0; k < 3; k++) { LO[k] -= S * 2; HI[k] += S * 2; }

  const width = Math.max(1, Math.round((HI[0] - LO[0]) / S));
  const height = Math.max(1, Math.round((HI[2] - LO[2]) / S));
  const length = Math.max(1, Math.round((HI[1] - LO[1]) / S));
  const cells = width * height * length;

  const leafAt = makeClassifier(cb);
  const pol = decidePolarity(cb, leafAt, LO, HI);
  const isSolid = pol.solidIsNoLeaf
    ? (x, y, z) => leafAt(x, y, z) === -1
    : (x, y, z) => leafAt(x, y, z) !== -1;

  const report = () => {
    console.log(`map            ${h.name} (${h.engine}, build ${h.build || '?'})`);
    console.log(`tags           ${idx.tags.length}, ${idx.named} with readable paths, ` +
      `classes stored ${idx.reversed ? 'reversed' : 'forward'}`);
    console.log(`bsp            ${opt.bsp} of ${bsps.length}: ${bsp.tag.name || '(unnamed)'}`);
    console.log(`collision      ${cb.counts.nodes.toLocaleString()} nodes, ` +
      `${cb.counts.planes.toLocaleString()} planes, ${cb.counts.leaves.toLocaleString()} leaves, ` +
      `${cb.counts.surfaces.toLocaleString()} surfaces`);
    console.log(`materials      ` + (mats ? `${mats.length} shader(s) resolved through the tag index`
      : 'collision_materials not located - everything becomes ' + opt.defaultBlock));
    console.log(`solid side     ` + (pol.solidIsNoLeaf ? 'no-leaf' : 'leaf') +
      `, from ${pol.probes} probes outside the world` +
      (pol.unanimous ? ' (unanimous)' : ` (${pol.leaf} leaf / ${pol.noleaf} no-leaf - NOT unanimous)`));
    console.log(`bounds         ${(HI[0] - LO[0]).toFixed(1)} x ${(HI[1] - LO[1]).toFixed(1)} x ` +
      `${(HI[2] - LO[2]).toFixed(1)} world units (1 wu = 10 feet)`);
    console.log(`grid at ${S}wu   ${width} x ${height} x ${length} = ${cells.toLocaleString()} cells`);
    if (opt.explain) {
      console.log(`\nhow this was located:`);
      console.log(`  tag base     derived: tagArrayPointer - 40 = 0x${(idx.base >>> 0).toString(16)}`);
      console.log(`  bsp ref      found at file offset ${bsp.refAt}, mapped at 0x${bsp.magic.toString(16)}`);
      console.log(`  bsp header   pointer at ${bsp.start} rebases to ${bsp.dataStart}, as predicted`);
      console.log(`  collision    element at ${cb.at}, all indices in range` +
        (cb.contiguous ? ', blocks contiguous' : ', blocks NOT contiguous'));
    }
  };

  if (opt.info || cells > opt.maxCells) {
    report();
    if (cells > opt.maxCells) {
      const need = Math.ceil(S * Math.cbrt(cells / opt.maxCells) * 100) / 100;
      console.error(`\nerror: ${cells.toLocaleString()} cells exceeds --max-cells ${opt.maxCells.toLocaleString()}.`);
      console.error(`       Raise --scale to about ${need}, or raise --max-cells.`);
      process.exit(1);
    }
    if (opt.info) return;
  }
  if (!pol.unanimous)
    console.warn('\n!! Probes outside the level disagreed about which side of the tree is solid.\n' +
      '   The BSP may not be sealed. If the output looks inside out, that is why.\n');

  /* --- surface materials: push each face into the solid and tag that cell.
   * Which side is solid is not taken from the plane's sign bit - it is probed
   * either side of the face, which cannot be got backwards. --- */
  const wantStates = opt.format === 'sponge';
  const blocks = Buffer.alloc(cells);
  const data = Buffer.alloc(cells);
  const stateNames = wantStates ? new Array(cells).fill('minecraft:air') : null;
  const idxOf = (x, y, z) => (y * length + z) * width + x;
  const cellOf = (p) => {
    const bx = Math.floor((p[0] - LO[0]) / S);
    const bz = opt.mirror ? Math.floor((p[1] - LO[1]) / S) : Math.floor((HI[1] - p[1]) / S);
    const by = Math.floor((p[2] - LO[2]) / S);
    if (bx < 0 || by < 0 || bz < 0 || bx >= width || by >= height || bz >= length) return -1;
    return idxOf(bx, by, bz);
  };

  const faceTex = new Map();
  let tagged = 0, flipped = 0;
  if (mats) {
    for (let si = 0; si < cb.counts.surfaces; si++) {
      const name = mats[cb.surfaces[si * 3 + 2]];
      if (!name) continue;
      const poly = surfacePoly(cb, si);
      if (poly.length < 3) continue;
      const pi = (cb.surfaces[si * 3] & 0x7fffffff) * 4;
      let n = [cb.planes[pi], cb.planes[pi + 1], cb.planes[pi + 2]];

      // Probe both sides of the face centre; keep the direction that is solid.
      let cx = 0, cy = 0, cz = 0;
      for (const v of poly) { cx += v[0]; cy += v[1]; cz += v[2]; }
      cx /= poly.length; cy /= poly.length; cz /= poly.length;
      const e = S * 0.5;
      const fwd = isSolid(cx + n[0] * e, cy + n[1] * e, cz + n[2] * e);
      const bwd = isSolid(cx - n[0] * e, cy - n[1] * e, cz - n[2] * e);
      if (fwd === bwd) continue;                 // knife edge; skip rather than guess
      if (fwd) { n = [-n[0], -n[1], -n[2]]; flipped++; }

      for (let t = 1; t + 1 < poly.length; t++) {
        const edge = Math.max(
          Math.hypot(poly[t][0] - poly[0][0], poly[t][1] - poly[0][1], poly[t][2] - poly[0][2]),
          Math.hypot(poly[t + 1][0] - poly[0][0], poly[t + 1][1] - poly[0][1], poly[t + 1][2] - poly[0][2]));
        const N = Math.min(256, Math.max(2, Math.ceil(edge / (S * 0.5))));
        for (let a = 0; a <= N; a++) for (let b2 = 0; a + b2 <= N; b2++) {
          const u = a / N, v = b2 / N, w = 1 - u - v;
          const p = [0, 1, 2].map(k =>
            poly[0][k] * w + poly[t][k] * u + poly[t + 1][k] * v - n[k] * (S * 0.5));
          const i = cellOf(p);
          if (i >= 0 && !faceTex.has(i)) { faceTex.set(i, name); tagged++; }
        }
      }
    }
  }

  /* --- classify, 8 subsamples per cell, same shape logic as bsp2mc --- */
  const rock = { ...nameToLegacy(opt.defaultBlock), full: opt.defaultBlock };
  const q = S / 4;
  const pop = (v) => ((v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1));
  let solidCells = 0, slabs = 0, stairs = 0;

  for (let by = 0; by < height; by++) {
    for (let bz = 0; bz < length; bz++) {
      for (let bx = 0; bx < width; bx++) {
        const cx = LO[0] + (bx + 0.5) * S;
        const cy = opt.mirror ? LO[1] + (bz + 0.5) * S : HI[1] - (bz + 0.5) * S;
        const cz = LO[2] + (by + 0.5) * S;
        let lm = 0, um = 0;
        for (let k = 0; k < 4; k++) {
          const dx = (k & 1) ? q : -q, dy = (k & 2) ? q : -q;
          if (isSolid(cx + dx, cy + dy, cz - q)) lm |= 1 << k;
          if (isSolid(cx + dx, cy + dy, cz + q)) um |= 1 << k;
        }
        if (!lm && !um) continue;
        const i = idxOf(bx, by, bz);

        const t = faceTex.get(i);
        const blk = (t ? tex.get(t) : null) || rock;
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

  /* --- shell trim. A Halo BSP is a sealed world, so everything that is not
   * the playable interior is solid - including all the space around the level.
   * Without this the output is a cube with a level-shaped hole in it, which is
   * the same situation t3d2mc hits with Unreal's subtractive worlds. --- */
  let trimmed = 0;
  if (opt.shell > 0) {
    const dist = new Int16Array(cells).fill(-1);
    let queue = [];
    for (let i = 0; i < cells; i++) if (!blocks[i]) { dist[i] = 0; queue.push(i); }
    for (let step = 0; step < opt.shell && queue.length; step++) {
      const next = [];
      for (const i of queue) {
        const bx = i % width, by = Math.floor(i / (length * width));
        const bz = Math.floor(i / width) % length;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const x = bx + dx, y = by + dy, z = bz + dz;
          if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= length) continue;
          const j = idxOf(x, y, z);
          if (dist[j] === -1) { dist[j] = step + 1; next.push(j); }
        }
      }
      queue = next;
    }
    for (let i = 0; i < cells; i++) {
      if (blocks[i] && dist[i] === -1) {
        blocks[i] = 0; data[i] = 0;
        if (wantStates) stateNames[i] = 'minecraft:air';
        trimmed++; solidCells--;
      }
    }
  }

  const grid = { width, height, length, blocks, data,
    stateName: (i) => (stateNames ? stateNames[i] : 'minecraft:stone') };
  const ext = opt.format === 'sponge' ? '.schem' : '.schematic';
  const stem = (bsp.tag.name || h.name || 'halo').split(/[\\/]/).pop();
  const outFile = opt.out || path.join(path.dirname(opt.input), stem + ext);
  fs.writeFileSync(outFile, opt.format === 'sponge' ? writeSponge(grid) : writeMcEdit(grid));

  report();
  console.log(`surfaces       ${tagged.toLocaleString()} cells tagged from ${cb.counts.surfaces.toLocaleString()} ` +
    `collision surfaces (${flipped.toLocaleString()} plane normals faced the solid)`);
  if (opt.shell > 0) console.log(`shell          ${trimmed.toLocaleString()} cells trimmed beyond ${opt.shell} blocks of open space`);
  console.log(`fill           ${(100 * solidCells / cells).toFixed(2)}% of the grid`);
  console.log(`filled         ${solidCells.toLocaleString()} blocks (${slabs.toLocaleString()} slabs, ${stairs.toLocaleString()} stairs)`);
  console.log(`wrote          ${outFile}`);

  if (tex.unresolved.size) {
    const list = [...tex.unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.warn(`\n!! ${tex.unresolved.size} shader path(s) matched no rule, so they became ${opt.defaultBlock}:`);
    for (const [n, c] of list) console.warn(`   ${String(c).padStart(6)}  ${n}`);
    console.warn('   Map them with --blocks map.json, e.g. {"rock_ground":"andesite"}');
  }
  if (bsps.length > 1 && opt.bsp === 0)
    console.warn(`\n!! This map has ${bsps.length} structure BSPs and only one was converted.\n` +
      '   Halo loads one at a time, so a campaign level is split across all of them. --list.');
}

module.exports = {
  readHeader, readTagIndex, findStructureBsps, scanCollisionBsp, scanCollisionMaterials,
  loadCollisionBsp, makeClassifier, decidePolarity, surfacePoly, checkContiguity, SZ,
};

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}
