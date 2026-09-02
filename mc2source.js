#!/usr/bin/env node
/**
 * mc2source.js - Convert a Minecraft .schematic into a Source engine map.
 *
 *   node mc2source.js input.schematic [options]
 *
 * Outputs a .vmf (Valve Map Format, text) that opens in Hammer for
 * Counter-Strike: Source / any Source 1 game, and can be imported into
 * Counter-Strike 2's Source 2 Hammer (File -> Import -> VMF).
 * Optionally also writes a .obj/.mtl mesh for the ModelDoc route in CS2.
 *
 * No dependencies. Node 16+.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ *
 * 1. NBT reader
 * ------------------------------------------------------------------ */

const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};

class NBTReader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u1() { return this.b.readUInt8(this.o++); }
  i1() { return this.b.readInt8(this.o++); }
  i2() { const v = this.b.readInt16BE(this.o); this.o += 2; return v; }
  i4() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  i8() { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v; }
  f4() { const v = this.b.readFloatBE(this.o); this.o += 4; return v; }
  f8() { const v = this.b.readDoubleBE(this.o); this.o += 8; return v; }
  str() {
    const n = this.b.readUInt16BE(this.o); this.o += 2;
    const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s;
  }
  payload(type) {
    switch (type) {
      case TAG.BYTE: return this.i1();
      case TAG.SHORT: return this.i2();
      case TAG.INT: return this.i4();
      case TAG.LONG: return this.i8();
      case TAG.FLOAT: return this.f4();
      case TAG.DOUBLE: return this.f8();
      case TAG.BYTE_ARRAY: {
        const n = this.i4(); const s = this.b.subarray(this.o, this.o + n); this.o += n; return s;
      }
      case TAG.STRING: return this.str();
      case TAG.LIST: {
        const t = this.u1(); const n = this.i4(); const out = [];
        for (let i = 0; i < n; i++) out.push(this.payload(t));
        return out;
      }
      case TAG.COMPOUND: {
        const out = {};
        for (;;) {
          const t = this.u1();
          if (t === TAG.END) break;
          const name = this.str();
          out[name] = this.payload(t);
        }
        return out;
      }
      case TAG.INT_ARRAY: {
        const n = this.i4(); const a = new Int32Array(n);
        for (let i = 0; i < n; i++) a[i] = this.i4();
        return a;
      }
      case TAG.LONG_ARRAY: {
        const n = this.i4(); const a = new BigInt64Array(n);
        for (let i = 0; i < n; i++) a[i] = this.i8();
        return a;
      }
      default: throw new Error('Unknown NBT tag type ' + type + ' at ' + this.o);
    }
  }
  root() {
    const t = this.u1();
    if (t !== TAG.COMPOUND) throw new Error('NBT root is not a compound tag');
    this.str(); // root name, usually "Schematic"
    return this.payload(TAG.COMPOUND);
  }
}

function decompress(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  if (buf[0] === 0x78) return zlib.inflateSync(buf);
  return buf; // uncompressed NBT
}

/* ------------------------------------------------------------------ *
 * 2. Schematic loaders (MCEdit legacy + Sponge v1/v2/v3)
 * ------------------------------------------------------------------ */

// Numeric block id -> modern-ish name, for legacy (pre-1.13) schematics.
const LEGACY_NAMES = {
  0: 'air', 1: 'stone', 2: 'grass_block', 3: 'dirt', 4: 'cobblestone', 5: 'planks',
  6: 'sapling', 7: 'bedrock', 8: 'water', 9: 'water', 10: 'lava', 11: 'lava',
  12: 'sand', 13: 'gravel', 14: 'gold_ore', 15: 'iron_ore', 16: 'coal_ore',
  17: 'log', 18: 'leaves', 19: 'sponge', 20: 'glass', 21: 'lapis_ore', 22: 'lapis_block',
  23: 'dispenser', 24: 'sandstone', 25: 'note_block', 26: 'bed', 27: 'rail', 28: 'rail',
  29: 'piston', 30: 'cobweb', 31: 'tall_grass', 32: 'dead_bush', 33: 'piston', 34: 'piston_head',
  35: 'wool', 37: 'flower', 38: 'flower', 39: 'mushroom', 40: 'mushroom',
  41: 'gold_block', 42: 'iron_block', 43: 'double_stone_slab', 44: 'stone_slab',
  45: 'bricks', 46: 'tnt', 47: 'bookshelf', 48: 'mossy_cobblestone', 49: 'obsidian',
  50: 'torch', 51: 'fire', 52: 'spawner', 53: 'oak_stairs', 54: 'chest', 55: 'redstone_wire',
  56: 'diamond_ore', 57: 'diamond_block', 58: 'crafting_table', 59: 'wheat', 60: 'farmland',
  61: 'furnace', 62: 'furnace', 63: 'sign', 64: 'door', 65: 'ladder', 66: 'rail', 67: 'cobblestone_stairs',
  68: 'sign', 69: 'lever', 70: 'pressure_plate', 71: 'door', 72: 'pressure_plate', 73: 'redstone_ore',
  74: 'redstone_ore', 75: 'torch', 76: 'torch', 77: 'button', 78: 'snow_layer', 79: 'ice',
  80: 'snow_block', 81: 'cactus', 82: 'clay', 83: 'sugar_cane', 84: 'jukebox', 85: 'fence',
  86: 'pumpkin', 87: 'netherrack', 88: 'soul_sand', 89: 'glowstone', 90: 'portal',
  91: 'jack_o_lantern', 92: 'cake', 93: 'repeater', 94: 'repeater', 95: 'stained_glass',
  96: 'trapdoor', 97: 'infested_stone', 98: 'stone_bricks', 99: 'mushroom_block', 100: 'mushroom_block',
  101: 'iron_bars', 102: 'glass_pane', 103: 'melon', 104: 'stem', 105: 'stem', 106: 'vine',
  107: 'fence_gate', 108: 'brick_stairs', 109: 'stone_brick_stairs', 110: 'mycelium',
  111: 'lily_pad', 112: 'nether_bricks', 113: 'nether_brick_fence', 114: 'nether_brick_stairs',
  115: 'nether_wart', 116: 'enchanting_table', 117: 'brewing_stand', 118: 'cauldron',
  119: 'end_portal', 120: 'end_portal_frame', 121: 'end_stone', 122: 'dragon_egg',
  123: 'redstone_lamp', 124: 'redstone_lamp_on', 125: 'double_wooden_slab', 126: 'wooden_slab',
  127: 'cocoa', 128: 'sandstone_stairs', 129: 'emerald_ore', 130: 'ender_chest', 131: 'tripwire_hook',
  132: 'tripwire', 133: 'emerald_block', 134: 'spruce_stairs', 135: 'birch_stairs', 136: 'jungle_stairs',
  137: 'command_block', 138: 'beacon', 139: 'cobblestone_wall', 140: 'flower_pot', 141: 'carrots',
  142: 'potatoes', 143: 'button', 144: 'skull', 145: 'anvil', 146: 'chest', 147: 'pressure_plate',
  148: 'pressure_plate', 149: 'comparator', 150: 'comparator', 151: 'daylight_detector',
  152: 'redstone_block', 153: 'nether_quartz_ore', 154: 'hopper', 155: 'quartz_block',
  156: 'quartz_stairs', 157: 'rail', 158: 'dropper', 159: 'terracotta', 160: 'stained_glass_pane',
  161: 'leaves', 162: 'log', 163: 'acacia_stairs', 164: 'dark_oak_stairs', 165: 'slime_block',
  166: 'barrier', 167: 'iron_trapdoor', 168: 'prismarine', 169: 'sea_lantern', 170: 'hay_block',
  171: 'carpet', 172: 'terracotta', 173: 'coal_block', 174: 'packed_ice', 175: 'tall_flower',
  176: 'banner', 177: 'banner', 178: 'daylight_detector', 179: 'red_sandstone',
  180: 'red_sandstone_stairs', 181: 'double_stone_slab', 182: 'stone_slab', 183: 'fence_gate',
  184: 'fence_gate', 185: 'fence_gate', 186: 'fence_gate', 187: 'fence_gate', 188: 'fence',
  189: 'fence', 190: 'fence', 191: 'fence', 192: 'fence', 193: 'door', 194: 'door', 195: 'door',
  196: 'door', 197: 'door', 198: 'end_rod', 199: 'chorus_plant', 200: 'chorus_flower',
  201: 'purpur_block', 202: 'purpur_pillar', 203: 'purpur_stairs', 204: 'purpur_block',
  205: 'purpur_slab', 206: 'end_stone_bricks', 207: 'beetroots', 208: 'grass_path',
  209: 'end_gateway', 210: 'repeating_command_block', 211: 'chain_command_block',
  212: 'frosted_ice', 213: 'magma_block', 214: 'nether_wart_block', 215: 'red_nether_bricks',
  216: 'bone_block', 217: 'structure_void', 218: 'observer', 219: 'shulker_box',
  235: 'glazed_terracotta', 236: 'glazed_terracotta', 237: 'glazed_terracotta',
  238: 'glazed_terracotta', 239: 'glazed_terracotta', 240: 'glazed_terracotta',
  241: 'glazed_terracotta', 242: 'glazed_terracotta', 243: 'glazed_terracotta',
  244: 'glazed_terracotta', 245: 'glazed_terracotta', 246: 'glazed_terracotta',
  247: 'glazed_terracotta', 248: 'glazed_terracotta', 249: 'glazed_terracotta',
  250: 'glazed_terracotta', 251: 'concrete', 252: 'concrete_powder',
  255: 'structure_block',
};

// --- Sub-block shapes -------------------------------------------------
// shape codes: 0 = full cube, 1 = bottom slab, 2 = top slab,
//              10+d = stairs (d: 0=+X 1=-X 2=+Z 3=-Z is the FULL-height side),
//              20+d = upside-down stairs.
const SLAB_IDS = new Set([44, 126, 182, 205]);          // 43/125/181/204 are double slabs = full
const STAIR_IDS = new Set([53, 67, 108, 109, 114, 128, 134, 135, 136, 156, 163, 164, 180, 203]);
const FACE_DIR = { east: 0, west: 1, south: 2, north: 3 };

function legacyShape(id, dv) {
  if (SLAB_IDS.has(id)) return (dv & 8) ? 2 : 1;
  if (STAIR_IDS.has(id)) return ((dv & 4) ? 20 : 10) + (dv & 3);
  return 0;
}

// "minecraft:oak_stairs[facing=east,half=bottom]" -> {facing:'east', half:'bottom'}
function parseProps(key) {
  const m = key.match(/\[(.*)\]/);
  if (!m) return {};
  const out = {};
  for (const pair of m[1].split(',')) {
    const [k, v] = pair.split('=');
    if (k) out[k.trim()] = (v || '').trim();
  }
  return out;
}

function spongeShape(key) {
  const name = normalizeName(key), p = parseProps(key);
  if (name.endsWith('_slab') || name === 'slab') {
    if (p.type === 'double') return 0;
    return p.type === 'top' ? 2 : 1;
  }
  if (name.endsWith('_stairs') || name === 'stairs') {
    const d = FACE_DIR[p.facing] !== undefined ? FACE_DIR[p.facing] : 0;
    return (p.half === 'top' ? 20 : 10) + d;
  }
  return 0;
}

// Colour suffixes for wool / terracotta / concrete / stained glass data values.
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const COLORED = new Set(['wool', 'terracotta', 'concrete', 'concrete_powder',
  'stained_glass', 'stained_glass_pane', 'carpet', 'shulker_box', 'glazed_terracotta']);
const WOOD = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak'];

function legacyName(id, data) {
  let n = LEGACY_NAMES[id];
  if (n === undefined) return 'unknown_' + id;
  if (COLORED.has(n)) return COLORS[data & 15] + '_' + n;
  if (n === 'planks' || n === 'log' || n === 'leaves') {
    const w = WOOD[(n === 'log' ? (data & 3) : (data & 7)) % 6] || 'oak';
    return w + '_' + n;
  }
  if (n === 'stone' && (data & 7) !== 0) return 'granite_family_stone';
  return n;
}

function loadSchematic(file) {
  const raw = decompress(fs.readFileSync(file));
  const nbt = new NBTReader(raw).root();

  // --- Sponge v3: everything under "Blocks" ---
  const spongeBlocks = nbt.Blocks && !Buffer.isBuffer(nbt.Blocks) ? nbt.Blocks : null;
  const palette = (spongeBlocks && spongeBlocks.Palette) || nbt.Palette;
  const blockData = (spongeBlocks && spongeBlocks.Data) || nbt.BlockData;

  const width = nbt.Width, height = nbt.Height, length = nbt.Length;
  if (!width || !height || !length) throw new Error('Not a schematic: missing Width/Height/Length');

  const size = width * height * length;
  const cells = new Int32Array(size);          // index into names[]
  const shapes = new Int8Array(size);          // 0 full, 1/2 slab, 10+/20+ stairs
  const names = [];
  const nameIndex = new Map();
  const intern = (n) => {
    let i = nameIndex.get(n);
    if (i === undefined) { i = names.length; names.push(n); nameIndex.set(n, i); }
    return i;
  };
  intern('air'); // always index 0

  if (palette && blockData) {
    // --- Sponge format: varint-indexed palette ---
    const idToName = [], idToShape = [];
    for (const [k, v] of Object.entries(palette)) {
      idToName[v] = normalizeName(k);
      idToShape[v] = spongeShape(k);
    }
    let o = 0, i = 0;
    while (o < blockData.length && i < size) {
      let value = 0, shift = 0, b;
      do { b = blockData[o++]; value |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      shapes[i] = idToShape[value] || 0;
      cells[i++] = intern(idToName[value] || 'unknown_' + value);
    }
    return { width, height, length, cells, shapes, names, format: 'sponge' };
  }

  // --- MCEdit legacy format: Blocks + Data (+ optional AddBlocks/Add) ---
  const blocks = nbt.Blocks;
  if (!blocks) throw new Error('Unrecognised schematic: no Palette/BlockData and no Blocks array');
  const data = nbt.Data || Buffer.alloc(size);
  const add = nbt.AddBlocks || nbt.Add || null;

  for (let i = 0; i < size; i++) {
    let id = blocks[i] & 0xff;
    if (add) {
      const nib = add[i >> 1];
      id |= ((i & 1) === 0 ? (nib >> 4) & 0x0f : nib & 0x0f) << 8;
    }
    const dv = data[i] & 0x0f;
    cells[i] = id === 0 ? 0 : intern(legacyName(id, dv));
    shapes[i] = id === 0 ? 0 : legacyShape(id, dv);
  }
  return { width, height, length, cells, shapes, names, format: 'mcedit' };
}

function normalizeName(k) {
  // "minecraft:oak_stairs[facing=east]" -> "oak_stairs"
  let n = k.split('[')[0];
  if (n.startsWith('minecraft:')) n = n.slice(10);
  return n;
}

/* ------------------------------------------------------------------ *
 * 3. Block classification + material table
 * ------------------------------------------------------------------ */

// Blocks that produce no geometry at all (plants, redstone wiring, decoration).
const SKIP = new Set([
  'air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light',
  'sapling', 'tall_grass', 'dead_bush', 'flower', 'mushroom', 'torch', 'fire',
  'redstone_wire', 'wheat', 'sign', 'wall_sign', 'ladder', 'rail', 'lever',
  'pressure_plate', 'button', 'stem', 'vine', 'lily_pad', 'nether_wart',
  'carrots', 'potatoes', 'beetroots', 'tall_flower', 'banner', 'cocoa',
  'tripwire', 'tripwire_hook', 'flower_pot', 'snow_layer', 'portal',
  'end_portal', 'end_gateway', 'cobweb', 'piston_head', 'end_rod',
  'chorus_plant', 'chorus_flower', 'grass', 'fern', 'seagrass', 'kelp',
]);

// Blocks you can see through: they don't hide a neighbouring face.
const TRANSPARENT = /(glass|water|ice|leaves|bars|fence|pane|slab|stairs|carpet|door|trapdoor|lantern)/;

// Blocks that should become a func_illusionary / water rather than solid world brush.
const LIQUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);

const M = {
  // Source 1 (HL2 / CS:S) material set. Anything missing shows as the purple
  // checkerboard in Hammer - fix by editing the JSON from --dump-materials.
  css: {
    _default: 'DEV/DEV_MEASUREGENERIC01B',
    stone: 'CONCRETE/CONCRETEWALL001A',
    granite_family_stone: 'CONCRETE/CONCRETEWALL004A',
    cobblestone: 'CONCRETE/CONCRETEFLOOR001A',
    mossy_cobblestone: 'NATURE/ROCKWALL001A',
    stone_bricks: 'BRICK/BRICKWALL001A',
    bricks: 'BRICK/BRICKWALL003A',
    nether_bricks: 'BRICK/BRICKWALL006A',
    red_nether_bricks: 'BRICK/BRICKWALL003A',
    bedrock: 'CONCRETE/CONCRETEFLOOR004A',
    dirt: 'NATURE/DIRTFLOOR001A',
    grass_block: { top: 'NATURE/BLENDGRASSDIRT001A', side: 'NATURE/DIRTFLOOR001A', bottom: 'NATURE/DIRTFLOOR001A' },
    grass_path: 'NATURE/DIRTFLOOR004A',
    sand: 'DE_DUST/DUST_FLOOR_02', red_sandstone: 'DE_DUST/DUST_WALL_01',
    sandstone: 'DE_DUST/DUST_WALL_01',
    gravel: 'NATURE/GRAVELFLOOR001A',
    clay: 'CONCRETE/CONCRETEFLOOR002A',
    terracotta: 'CONCRETE/CONCRETEFLOOR003A',
    glass: 'GLASS/GLASSWINDOW003A',
    stained_glass: 'GLASS/GLASSWINDOW004A',
    glass_pane: 'GLASS/GLASSWINDOW003A',
    iron_bars: 'METAL/METALGRATE011A',
    iron_block: 'METAL/METALWALL048A',
    gold_block: 'METAL/METALWALL044A',
    diamond_block: 'METAL/METALWALL048A',
    emerald_block: 'METAL/METALWALL048A',
    redstone_block: 'METAL/METALWALL005A',
    coal_block: 'CONCRETE/CONCRETEFLOOR004A',
    quartz_block: 'TILE/TILEFLOOR001A',
    planks: 'WOOD/WOODWALL009A',
    log: 'WOOD/WOODWALL006A',
    leaves: 'NATURE/BLENDGRASSDIRT001A',
    bookshelf: 'WOOD/WOODWALL013A',
    crafting_table: 'WOOD/WOODCRATE001A',
    chest: 'WOOD/WOODCRATE004A',
    wool: 'PLASTER/PLASTERWALL021A',
    concrete: 'CONCRETE/CONCRETEWALL003A',
    concrete_powder: 'CONCRETE/CONCRETEFLOOR005A',
    glowstone: 'LIGHTS/WHITE001',
    sea_lantern: 'LIGHTS/WHITE002',
    redstone_lamp_on: 'LIGHTS/WHITE001',
    redstone_lamp: 'LIGHTS/FLUORESCENTCOOL001A',
    obsidian: 'CONCRETE/CONCRETEWALL005A',
    netherrack: 'BRICK/BRICKWALL006A',
    end_stone: 'DE_DUST/DUST_WALL_01',
    end_stone_bricks: 'DE_DUST/DUST_WALL_02',
    ice: 'GLASS/GLASSWINDOW004A', packed_ice: 'GLASS/GLASSWINDOW004A',
    snow_block: 'NATURE/SNOWFLOOR001A',
    hay_block: 'NATURE/DIRTFLOOR004A',
    bone_block: 'PLASTER/PLASTERWALL021A',
    note_block: 'WOOD/WOODWALL009A',
    water: 'NATURE/WATER_CANALS_MURKY',
    lava: 'LIGHTS/WHITE001',
    _sky: 'TOOLS/TOOLSSKYBOX',
    _nodraw: 'TOOLS/TOOLSNODRAW',
    _trigger: 'TOOLS/TOOLSTRIGGER',
  },
  // Blockout profile - only dev textures, which always exist.
  dev: {
    _default: 'DEV/DEV_MEASUREGENERIC01B',
    _sky: 'TOOLS/TOOLSSKYBOX',
    _nodraw: 'TOOLS/TOOLSNODRAW',
    _trigger: 'TOOLS/TOOLSTRIGGER',
  },
};

function buildMaterialResolver(profile, overrideFile) {
  const table = Object.assign({}, M[profile] || M.css);
  if (overrideFile) Object.assign(table, JSON.parse(fs.readFileSync(overrideFile, 'utf8')));
  const cache = new Map();
  return {
    table,
    get(name) {
      if (cache.has(name)) return cache.get(name);
      let e = table[name];
      if (e === undefined) {
        // try progressively less specific keys: red_stained_glass -> stained_glass -> glass
        const parts = name.split('_');
        for (let i = 1; i < parts.length && e === undefined; i++) e = table[parts.slice(i).join('_')];
        for (let i = parts.length - 1; i > 0 && e === undefined; i--) e = table[parts.slice(0, i).join('_')];
      }
      if (e === undefined) e = table._default;
      const r = typeof e === 'string' ? { top: e, side: e, bottom: e } : {
        top: e.top || e.side || table._default,
        side: e.side || e.top || table._default,
        bottom: e.bottom || e.side || e.top || table._default,
      };
      cache.set(name, r);
      return r;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4. Greedy meshing: voxels -> as few axis-aligned boxes as possible
 * ------------------------------------------------------------------ */

function greedyBoxes(schem, keep) {
  const { width, height, length, cells, shapes } = schem;
  const idx = (x, y, z) => (y * length + z) * width + x;
  const used = new Uint8Array(cells.length);
  const boxes = [];

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y, z);
        const m = cells[i], s = shapes[i];
        if (used[i] || !keep[m]) continue;

        // Stairs are two-part shapes with a facing direction - merging them
        // would smear the step across the whole run. Keep them 1x1x1.
        if (s >= 10) {
          used[i] = 1;
          boxes.push({ x, y, z, dx: 1, dy: 1, dz: 1, m, s });
          continue;
        }
        const match = (j) => !used[j] && cells[j] === m && shapes[j] === s;

        // grow along X
        let dx = 1;
        while (x + dx < width && match(idx(x + dx, y, z))) dx++;
        // grow along Z (whole row must match)
        let dz = 1;
        grow_z: while (z + dz < length) {
          for (let xx = 0; xx < dx; xx++) if (!match(idx(x + xx, y, z + dz))) break grow_z;
          dz++;
        }
        // grow along Y - only for full cubes. Stacking half-slabs into one tall
        // box would fill the gaps between them.
        let dy = 1;
        if (s === 0) {
          grow_y: while (y + dy < height) {
            for (let zz = 0; zz < dz; zz++)
              for (let xx = 0; xx < dx; xx++)
                if (!match(idx(x + xx, y + dy, z + zz))) break grow_y;
            dy++;
          }
        }

        for (let yy = 0; yy < dy; yy++)
          for (let zz = 0; zz < dz; zz++)
            for (let xx = 0; xx < dx; xx++) used[idx(x + xx, y + yy, z + zz)] = 1;

        boxes.push({ x, y, z, dx, dy, dz, m, s });
      }
    }
  }
  return boxes;
}

// A meshed box -> one or more sub-boxes in fractional Minecraft block units.
function blockBoxes(b) {
  const { x, y, z, dx, dy, dz, s } = b;
  if (s === 1) return [{ x1: x, x2: x + dx, y1: y, y2: y + 0.5, z1: z, z2: z + dz }];
  if (s === 2) return [{ x1: x, x2: x + dx, y1: y + 0.5, y2: y + 1, z1: z, z2: z + dz }];
  if (s >= 10) {
    const d = s % 10, up = s >= 20;
    const slab = up ? [y + 0.5, y + 1] : [y, y + 0.5];   // the full half
    const step = up ? [y, y + 0.5] : [y + 0.5, y + 1];   // the quarter on the tall side
    const q = [
      [x + 0.5, x + 1, z, z + 1], [x, x + 0.5, z, z + 1],
      [x, x + 1, z + 0.5, z + 1], [x, x + 1, z, z + 0.5],
    ][d];
    return [
      { x1: x, x2: x + 1, y1: slab[0], y2: slab[1], z1: z, z2: z + 1 },
      { x1: q[0], x2: q[1], y1: step[0], y2: step[1], z1: q[2], z2: q[3] },
    ];
  }
  return [{ x1: x, x2: x + dx, y1: y, y2: y + dy, z1: z, z2: z + dz }];
}

/* ------------------------------------------------------------------ *
 * 5. VMF writing
 * ------------------------------------------------------------------ */

let nextId = 1;
const id = () => nextId++;

// Face order: top(+Z) bottom(-Z) west(-X) east(+X) north(+Y) south(-Y)
const UV = {
  top: ['[1 0 0 0]', '[0 -1 0 0]'],
  bottom: ['[1 0 0 0]', '[0 -1 0 0]'],
  west: ['[0 1 0 0]', '[0 0 -1 0]'],
  east: ['[0 1 0 0]', '[0 0 -1 0]'],
  north: ['[1 0 0 0]', '[0 0 -1 0]'],
  south: ['[1 0 0 0]', '[0 0 -1 0]'],
};

function planePoints(b, face) {
  const { x1, y1, z1, x2, y2, z2 } = b;
  const p = (x, y, z) => `(${x} ${y} ${z})`;
  switch (face) {
    case 'top': return [p(x1, y2, z2), p(x2, y2, z2), p(x2, y1, z2)];
    case 'bottom': return [p(x1, y1, z1), p(x2, y1, z1), p(x2, y2, z1)];
    case 'west': return [p(x1, y2, z2), p(x1, y1, z2), p(x1, y1, z1)];
    case 'east': return [p(x2, y2, z1), p(x2, y1, z1), p(x2, y1, z2)];
    case 'north': return [p(x2, y2, z2), p(x1, y2, z2), p(x1, y2, z1)];
    case 'south': return [p(x2, y1, z1), p(x1, y1, z1), p(x1, y1, z2)];
  }
}

function solidVmf(box, mats, opt, indent) {
  const t = indent, t2 = indent + '\t', t3 = indent + '\t\t';
  const out = [`${t}solid`, `${t}{`, `${t2}"id" "${id()}"`];
  for (const face of ['top', 'bottom', 'west', 'east', 'north', 'south']) {
    const [u, v] = UV[face];
    out.push(
      `${t2}side`, `${t2}{`,
      `${t3}"id" "${id()}"`,
      `${t3}"plane" "${planePoints(box, face).join(' ')}"`,
      `${t3}"material" "${mats[face]}"`,
      `${t3}"uaxis" "${u} ${opt.texscale}"`,
      `${t3}"vaxis" "${v} ${opt.texscale}"`,
      `${t3}"rotation" "0"`,
      `${t3}"lightmapscale" "${opt.lightmap}"`,
      `${t3}"smoothing_groups" "0"`,
      `${t2}}`);
  }
  out.push(
    `${t2}editor`, `${t2}{`,
    `${t3}"color" "0 180 220"`,
    `${t3}"visgroupshown" "1"`,
    `${t3}"visgroupautoshown" "1"`,
    `${t2}}`, `${t}}`);
  return out.join('\n');
}

function entityVmf(classname, kv, solids, opt) {
  const out = ['entity', '{', `\t"id" "${id()}"`, `\t"classname" "${classname}"`];
  for (const [k, v] of Object.entries(kv)) out.push(`\t"${k}" "${v}"`);
  if (solids) for (const s of solids) out.push(s);
  out.push('\teditor', '\t{', '\t\t"color" "220 30 220"', '\t\t"visgroupshown" "1"',
    '\t\t"visgroupautoshown" "1"', '\t}', '}');
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * 6. Main conversion
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = {
    scale: 32, texscale: 0.25, lightmap: 16, profile: 'css',
    detail: 'auto', detailMin: 2, skybox: true, spawns: 10,
    sky: 'sky_day02_05', obj: false, materials: null, out: null,
    water: 'solid', nodraw: true, info: false, maxHeight: Infinity, mirror: false,
    slabs: 'half', stairs: 'steps',
  };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (!a.startsWith('--')) { files.push(a); continue; }
    switch (a) {
      case '--scale': o.scale = parseFloat(val()); break;
      case '--texscale': o.texscale = parseFloat(val()); break;
      case '--lightmap': o.lightmap = parseInt(val()); break;
      case '--profile': o.profile = val(); break;
      case '--materials': o.materials = val(); break;
      case '--detail': o.detail = val(); break;
      case '--detail-min': o.detailMin = parseInt(val()); break;
      case '--spawns': o.spawns = parseInt(val()); break;
      case '--sky': o.sky = val(); break;
      case '--max-height': o.maxHeight = parseInt(val()); break;
      case '--water': o.water = val(); break;
      case '--slabs': o.slabs = val(); break;
      case '--stairs': o.stairs = val(); break;
      case '--out': o.out = val(); break;
      case '--obj': o.obj = true; break;
      case '--mirror': o.mirror = true; break;
      case '--no-skybox': o.skybox = false; break;
      case '--no-nodraw': o.nodraw = false; break;
      case '--info': o.info = true; break;
      case '--dump-materials': o.dump = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error('Unknown option ' + a);
    }
  }
  o.input = files[0];
  return o;
}

const HELP = `
mc2source - Minecraft .schematic -> Source engine .vmf

  node mc2source.js <input.schematic> [options]

  --out <file>          output path (default: alongside input, .vmf)
  --scale <n>           Source units per Minecraft block (default 32;
                        player is 72 units tall, so 32 = comfortably scaled,
                        48-64 = "giant Minecraft world")
  --profile css|dev     material set (default css; dev = blockout textures)
  --materials <f.json>  override/extend the block->material table
  --dump-materials      print the active table as JSON and exit
  --detail auto|all|none  which brushes become func_detail (default auto)
  --detail-min <n>      auto: brushes thinner than n blocks -> func_detail (2)
  --texscale <n>        texture scale on every face (default 0.25)
  --lightmap <n>        lightmap luxel size (default 16; raise to 32 for faster VRAD)
  --sky <name>          skyname keyvalue (default sky_day02_05)
  --spawns <n>          spawn points per team (default 10, 0 to skip)
  --max-height <n>      ignore blocks above this Y layer
  --water solid|skip    how to treat water/lava (default solid)
  --mirror              don't flip Z (produces a mirrored map)
  --no-skybox           don't wrap the map in a sealing skybox shell
  --no-nodraw           don't nodraw fully hidden faces
  --obj                 also write .obj/.mtl (for CS2 ModelDoc / Blender)
  --info                print schematic stats and exit
`;

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.input) { console.log(HELP); process.exit(opt.input ? 0 : 1); }

  const mats = buildMaterialResolver(opt.profile, opt.materials);
  if (opt.dump) { console.log(JSON.stringify(mats.table, null, 2)); return; }

  const schem = loadSchematic(opt.input);
  const { width, height, length, cells, shapes, names } = schem;

  // --- histogram / classification ---
  const counts = new Int32Array(names.length);
  for (let i = 0; i < cells.length; i++) counts[cells[i]]++;

  if (opt.info) {
    console.log(`format:  ${schem.format}`);
    console.log(`size:    ${width} x ${height} x ${length}  (${cells.length} cells)`);
    const rows = names.map((n, i) => [n, counts[i]]).filter(r => r[1] > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [n, c] of rows) console.log(String(c).padStart(8), n, '->', mats.get(n).side);
    return;
  }

  // keep[] = does this palette entry generate a brush?
  const keep = new Uint8Array(names.length);
  const opaque = new Uint8Array(names.length);
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    const base = n.replace(/^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_/, '')
      .replace(/^(oak|spruce|birch|jungle|acacia|dark_oak)_/, '');
    const skip = SKIP.has(n) || SKIP.has(base);
    const liquid = LIQUIDS.has(base) || LIQUIDS.has(n);
    keep[i] = (!skip && !(liquid && opt.water === 'skip')) ? 1 : 0;
    opaque[i] = keep[i] && !TRANSPARENT.test(n) && !liquid ? 1 : 0;
  }
  keep[0] = 0; opaque[0] = 0;

  // --max-height: blank everything above the cut
  if (opt.maxHeight < height) {
    for (let y = opt.maxHeight; y < height; y++) {
      cells.fill(0, y * length * width, (y + 1) * length * width);
      shapes.fill(0, y * length * width, (y + 1) * length * width);
    }
  }

  // --slabs full / --stairs full|slab collapse sub-block shapes back to cubes
  if (opt.slabs === 'full' || opt.stairs !== 'steps') {
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      if (s === 0) continue;
      if (s < 10) { if (opt.slabs === 'full') shapes[i] = 0; }
      else if (opt.stairs === 'full') shapes[i] = 0;
      else if (opt.stairs === 'slab') shapes[i] = s >= 20 ? 2 : 1;
    }
  }

  const t0 = Date.now();
  const boxes = greedyBoxes(schem, keep);
  let solidCells = 0;
  for (let i = 0; i < cells.length; i++) if (keep[cells[i]]) solidCells++;

  // --- geometry -> world coordinates ---
  const S = opt.scale;
  const cx = width / 2, cz = length / 2;
  const idx = (x, y, z) => (y * length + z) * width + x;
  // A slab or stair only partly fills its cell, so it can't hide a neighbour's face.
  const isOpaqueAt = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= length) return false;
    const i = idx(x, y, z);
    return !!opaque[cells[i]] && shapes[i] === 0;
  };

  // fractional Minecraft block box -> Source world box
  const worldBox = (m) => {
    const zA = Math.round((m.z1 - cz) * S), zB = Math.round((m.z2 - cz) * S);
    return {
      x1: Math.round((m.x1 - cx) * S), x2: Math.round((m.x2 - cx) * S),
      y1: opt.mirror ? zA : -zB, y2: opt.mirror ? zB : -zA,
      z1: Math.round(m.y1 * S), z2: Math.round(m.y2 * S),
    };
  };
  const toWorld = (b) => worldBox(blockBoxes(b)[0]);

  // Fully-buried faces get nodraw so VRAD/VBSP don't waste time on them.
  const faceMaterials = (b) => {
    const base = mats.get(names[b.m]);
    const nd = mats.table._nodraw;
    const covered = (dxi, dyi, dzi) => {
      if (!opt.nodraw) return false;
      for (let yy = 0; yy < b.dy; yy++)
        for (let zz = 0; zz < b.dz; zz++)
          for (let xx = 0; xx < b.dx; xx++) {
            // only cells on the relevant boundary layer matter
            if (dxi && ((dxi > 0 && xx !== b.dx - 1) || (dxi < 0 && xx !== 0))) continue;
            if (dyi && ((dyi > 0 && yy !== b.dy - 1) || (dyi < 0 && yy !== 0))) continue;
            if (dzi && ((dzi > 0 && zz !== b.dz - 1) || (dzi < 0 && zz !== 0))) continue;
            if (!isOpaqueAt(b.x + xx + dxi, b.y + yy + dyi, b.z + zz + dzi)) return false;
          }
      return true;
    };
    const sy = opt.mirror ? 1 : -1;
    return {
      top: covered(0, 1, 0) ? nd : base.top,
      bottom: covered(0, -1, 0) ? nd : base.bottom,
      east: covered(1, 0, 0) ? nd : base.side,
      west: covered(-1, 0, 0) ? nd : base.side,
      north: covered(0, 0, sy > 0 ? 1 : -1) ? nd : base.side,
      south: covered(0, 0, sy > 0 ? -1 : 1) ? nd : base.side,
    };
  };

  const worldSolids = [];
  const detailSolids = [];
  let nodrawFaces = 0, brushCount = 0, slabCount = 0, stairCount = 0;
  const allWorld = [];
  for (const b of boxes) {
    if (b.s === 1 || b.s === 2) slabCount++;
    if (b.s >= 10) stairCount++;
    // Partial shapes never fully cover a neighbour, so don't nodraw them.
    const base = mats.get(names[b.m]);
    const fm = b.s === 0 ? faceMaterials(b)
      : { top: base.top, bottom: base.bottom, east: base.side, west: base.side, north: base.side, south: base.side };
    for (const k in fm) if (fm[k] === mats.table._nodraw) nodrawFaces++;

    for (const mb of blockBoxes(b)) {
      const w = worldBox(mb);
      if (w.x2 <= w.x1 || w.y2 <= w.y1 || w.z2 <= w.z1) continue;  // degenerate at tiny --scale
      allWorld.push(w);
      brushCount++;
      const minDim = Math.min(w.x2 - w.x1, w.y2 - w.y1, w.z2 - w.z1);
      const isDetail = opt.detail === 'all' ? true
        : opt.detail === 'none' ? false
          : minDim < opt.detailMin * S;
      (isDetail ? detailSolids : worldSolids).push(solidVmf(w, fm, opt, '\t'));
    }
  }

  // --- map bounds ---
  let X1 = Infinity, X2 = -Infinity, Y1 = Infinity, Y2 = -Infinity, Z1 = 0, Z2 = -Infinity;
  for (const w of allWorld) {
    X1 = Math.min(X1, w.x1); X2 = Math.max(X2, w.x2);
    Y1 = Math.min(Y1, w.y1); Y2 = Math.max(Y2, w.y2);
    Z1 = Math.min(Z1, w.z1); Z2 = Math.max(Z2, w.z2);
  }
  if (!isFinite(X1)) throw new Error('No solid blocks found in schematic');

  // --- sealing skybox shell ---
  const shell = [];
  const T = 64, PAD = Math.max(128, S * 2), HEAD = Math.max(512, S * 6);
  const sx1 = X1 - PAD, sx2 = X2 + PAD, sy1 = Y1 - PAD, sy2 = Y2 + PAD;
  const sz1 = Z1 - PAD, sz2 = Z2 + HEAD;
  if (opt.skybox) {
    const sky = mats.table._sky;
    const sm = { top: sky, bottom: sky, east: sky, west: sky, north: sky, south: sky };
    const push = (x1, y1, z1, x2, y2, z2) =>
      shell.push(solidVmf({ x1, y1, z1, x2, y2, z2 }, sm, opt, '\t'));
    push(sx1 - T, sy1 - T, sz1 - T, sx2 + T, sy2 + T, sz1);          // floor
    push(sx1 - T, sy1 - T, sz2, sx2 + T, sy2 + T, sz2 + T);          // ceiling
    push(sx1 - T, sy1 - T, sz1, sx1, sy2 + T, sz2);                  // west
    push(sx2, sy1 - T, sz1, sx2 + T, sy2 + T, sz2);                  // east
    push(sx1, sy1 - T, sz1, sx2, sy1, sz2);                          // south
    push(sx1, sy2, sz1, sx2, sy2 + T, sz2);                          // north
  }

  // --- spawn points on walkable surfaces ---
  const spawnEnts = [];
  const buyzones = [];
  if (opt.spawns > 0) {
    const headroom = Math.max(3, Math.ceil(72 / S) + 1);
    const cand = [];
    // Scan bottom-up so spawns land on the ground floor / street, not on roofs.
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < height - headroom - 1; y++) {
          const i0 = idx(x, y, z);
          if (!opaque[cells[i0]]) continue;
          let free = true;
          for (let h = 1; h <= headroom; h++) if (keep[cells[idx(x, y + h, z)]]) { free = false; break; }
          // a bottom slab's walking surface is half a block lower
          if (free) { cand.push({ x, y, z, top: shapes[i0] === 1 ? y + 0.5 : y + 1 }); break; }
        }
      }
    }
    // Keep only the dominant floor level (+2 blocks) so nothing spawns on a
    // perimeter wall or an isolated ledge that happens to be a column's minimum.
    if (cand.length) {
      const hist = new Map();
      for (const c of cand) hist.set(c.y, (hist.get(c.y) || 0) + 1);
      let floorY = 0, best = -1;
      for (const [y, n] of hist) if (n > best) { best = n; floorY = y; }
      const near = cand.filter(c => c.y >= floorY - 1 && c.y <= floorY + 2);
      if (near.length >= opt.spawns * 2) { cand.length = 0; cand.push(...near); }
    }

    // world coords, split into two teams along the longest horizontal axis
    const pts = cand.map(c => ({
      wx: Math.round((c.x + 0.5 - cx) * S),
      wy: Math.round(((opt.mirror ? 1 : -1) * (c.z + 0.5 - cz)) * S),
      wz: Math.round(c.top * S) + 4,
    }));
    const alongX = (X2 - X1) >= (Y2 - Y1);
    pts.sort((a, b) => alongX ? a.wx - b.wx : a.wy - b.wy);
    const pick = (list) => {
      const out = [];
      const minD = S * 2;
      for (const p of list) {
        if (out.length >= opt.spawns) break;
        if (out.every(q => Math.hypot(q.wx - p.wx, q.wy - p.wy) >= minD)) out.push(p);
      }
      return out;
    };
    const tSide = pick(pts);
    const ctSide = pick(pts.slice().reverse());
    const mk = (cls, arr) => arr.forEach((p, i) =>
      spawnEnts.push(entityVmf(cls, {
        origin: `${p.wx} ${p.wy} ${p.wz}`, angles: '0 ' + (cls.endsWith('terrorist') ? 0 : 180) + ' 0',
        priority: i, enabled: 1,
      }, null, opt)));
    mk('info_player_terrorist', tSide);
    mk('info_player_counterterrorist', ctSide);

    const zone = (arr, cls) => {
      if (!arr.length) return;
      let a1 = Infinity, a2 = -Infinity, b1 = Infinity, b2 = -Infinity, c1 = Infinity;
      for (const p of arr) {
        a1 = Math.min(a1, p.wx - S); a2 = Math.max(a2, p.wx + S);
        b1 = Math.min(b1, p.wy - S); b2 = Math.max(b2, p.wy + S);
        c1 = Math.min(c1, p.wz - 8);
      }
      const m = mats.table._trigger;
      const fm = { top: m, bottom: m, east: m, west: m, north: m, south: m };
      buyzones.push(entityVmf(cls, {},
        [solidVmf({ x1: a1, y1: b1, z1: c1, x2: a2, y2: b2, z2: c1 + 128 }, fm, opt, '\t')], opt));
    };
    zone(tSide, 'func_buyzone');
    zone(ctSide, 'func_buyzone');
  }

  // --- assemble the VMF ---
  const cxw = Math.round((X1 + X2) / 2), cyw = Math.round((Y1 + Y2) / 2);
  const chunks = [];
  chunks.push(
    'versioninfo\n{\n\t"editorversion" "400"\n\t"editorbuild" "8600"\n\t"mapversion" "1"' +
    '\n\t"formatversion" "100"\n\t"prefab" "0"\n}',
    'visgroups\n{\n}',
    'viewsettings\n{\n\t"bSnapToGrid" "1"\n\t"bShowGrid" "1"\n\t"nGridSpacing" "' +
    Math.max(1, Math.round(S)) + '"\n}');

  const world = ['world', '{', `\t"id" "${id()}"`, '\t"mapversion" "1"',
    '\t"classname" "worldspawn"', `\t"skyname" "${opt.sky}"`,
    '\t"maxpropscreenwidth" "-1"', '\t"detailvbsp" "detail.vbsp"',
    '\t"detailmaterial" "detail/detailsprites"'];
  world.push(...shell, ...worldSolids, '}');
  chunks.push(world.join('\n'));

  // func_detail brushes, chunked so no single entity gets absurd
  for (let i = 0; i < detailSolids.length; i += 512) {
    chunks.push(entityVmf('func_detail', {}, detailSolids.slice(i, i + 512), opt));
  }

  chunks.push(entityVmf('light_environment', {
    origin: `${cxw} ${cyw} ${Z2 + 128}`, angles: '0 300 0', pitch: -45,
    _light: '255 250 235 400', _ambient: '160 175 200 120',
    _lightscaleHDR: 1, _ambientscaleHDR: 1, SunSpreadAngle: 5,
  }, null, opt));
  chunks.push(entityVmf('sky_camera', {
    origin: `${cxw} ${cyw} ${Z2 + 64}`, scale: 16, fogenable: 0,
  }, null, opt));
  chunks.push(entityVmf('info_map_parameters', {
    origin: `${cxw} ${cyw} ${Z1 + S}`, buying: 0, bombradius: 500,
  }, null, opt));
  chunks.push(...spawnEnts, ...buyzones);
  chunks.push('cameras\n{\n\t"activecamera" "-1"\n}', 'cordons\n{\n\t"active" "0"\n}');

  const outFile = opt.out || opt.input.replace(/\.[^.]+$/, '') + '.vmf';
  fs.writeFileSync(outFile, chunks.join('\n') + '\n');

  // --- optional OBJ ---
  let objFile = null;
  if (opt.obj) objFile = writeObj(outFile.replace(/\.vmf$/, '.obj'), boxes, names, toWorld, isOpaqueAt);

  // --- report ---
  const brushes = brushCount + shell.length;
  const ents = spawnEnts.length + buyzones.length + 3 + Math.ceil(detailSolids.length / 512);
  console.log(`input          ${path.basename(opt.input)} (${schem.format}, ${width}x${height}x${length})`);
  console.log(`solid voxels   ${solidCells.toLocaleString()}`);
  console.log(`brushes        ${brushes.toLocaleString()}  (${worldSolids.length} world, ${detailSolids.length} func_detail, ${shell.length} skybox)`);
  console.log(`compression    ${(solidCells / Math.max(1, brushCount)).toFixed(1)} voxels/brush`);
  console.log(`sub-block      ${slabCount.toLocaleString()} slabs, ${stairCount.toLocaleString()} stairs`);
  console.log(`nodraw faces   ${nodrawFaces.toLocaleString()} of ${(boxes.length * 6).toLocaleString()}`);
  console.log(`step height    ${S / 2} units (slab/stair rise) - Source max is 18`);
  console.log(`entities       ${ents}`);
  console.log(`world size     ${X2 - X1} x ${Y2 - Y1} x ${Z2 - Z1} units`);
  console.log(`time           ${Date.now() - t0} ms`);
  console.log(`wrote          ${outFile}${objFile ? '\nwrote          ' + objFile : ''}`);

  if ((slabCount || stairCount) && S / 2 > 18)
    console.warn(`\n!! At --scale ${S} a half-block step is ${S / 2} units, above Source's 18-unit\n   step height. Players will have to jump every step. Use --scale 36 or lower.`);
  if (brushes > 8192) console.warn(`\n!! ${brushes} brushes exceeds VBSP's 8192 limit. Raise --scale is no help;\n   try --max-height, or split the schematic, or accept a failed compile.`);
  if (Math.max(X2 - X1, Y2 - Y1, Z2 - Z1) > 32768) console.warn('\n!! Map exceeds the +-16384 unit world bounds. Lower --scale.');
}

/* ------------------------------------------------------------------ *
 * 7. OBJ export (CS2 ModelDoc / Blender route)
 * ------------------------------------------------------------------ */

function writeObj(file, boxes, names, toWorld, isOpaqueAt) {
  const lines = ['# generated by mc2source.js', 'mtllib ' + path.basename(file).replace(/\.obj$/, '.mtl')];
  const used = new Set();
  let v = 1;
  const byMat = new Map();
  for (const b of boxes) {
    const n = names[b.m];
    if (!byMat.has(n)) byMat.set(n, []);
    byMat.get(n).push(b);
  }
  for (const [n, list] of byMat) {
    lines.push('usemtl ' + n);
    used.add(n);
    for (const b of list) {
      const w = toWorld(b);
      const P = [
        [w.x1, w.y1, w.z1], [w.x2, w.y1, w.z1], [w.x2, w.y2, w.z1], [w.x1, w.y2, w.z1],
        [w.x1, w.y1, w.z2], [w.x2, w.y1, w.z2], [w.x2, w.y2, w.z2], [w.x1, w.y2, w.z2]];
      for (const p of P) lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
      const f = (a, bb, c, d) => lines.push(`f ${v + a} ${v + bb} ${v + c} ${v + d}`);
      f(0, 3, 2, 1); f(4, 5, 6, 7); f(0, 1, 5, 4);
      f(2, 3, 7, 6); f(1, 2, 6, 5); f(0, 4, 7, 3);
      v += 8;
    }
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.writeFileSync(file.replace(/\.obj$/, '.mtl'),
    [...used].map(n => `newmtl ${n}\nKd 0.8 0.8 0.8\n`).join('\n'));
  return file;
}

try { main(); } catch (e) {
  console.error('error: ' + e.message);
  process.exit(1);
}
