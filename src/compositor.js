import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

const ARMOR_PARTS = [
  "RobeBack",
  "Robe",
  "Chest",
  "Hip",
  "Thigh",
  "Shin",
  "Foot",
  "Shoulder",
  "Hand",
  "Head"
];

const AVATAR_LAYERS = [
  { slot: "cape", phase: "back", order: 10 },
  { slot: "armor", part: "RobeBack", phase: "back", order: 20 },
  { slot: "hair", part: "HairBack", phase: "back", order: 30 },
  { slot: "body", part: "Torso", phase: "body", order: 100, builtIn: true },
  { slot: "armor", part: "Chest", phase: "body", order: 110 },
  { slot: "armor", part: "Hip", phase: "body", order: 120 },
  { slot: "armor", part: "Thigh", phase: "body", order: 130 },
  { slot: "armor", part: "Shin", phase: "body", order: 140 },
  { slot: "armor", part: "Foot", phase: "body", order: 150 },
  { slot: "armor", part: "Robe", phase: "body", order: 160 },
  { slot: "body", part: "Head", phase: "head", order: 200, builtIn: true },
  { slot: "hair", part: "Hair", phase: "head", order: 210 },
  { slot: "helm", phase: "head", order: 220 },
  { slot: "armor", part: "Shoulder", phase: "arms", order: 300 },
  { slot: "armor", part: "Hand", phase: "arms", order: 310 },
  { slot: "weapon", phase: "front", order: 400 },
  { slot: "misc", phase: "front", order: 500 },
  { slot: "pet", phase: "pet", order: 900 }
];

function cleanSymbolBase(value) {
  return path.basename(String(value || ""), ".swf").replace(/[^\w$]/g, "");
}

function numberColor(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return {
      raw: value || "",
      hex: ""
    };
  }

  return {
    raw: String(value),
    decimal: number,
    hex: `#${number.toString(16).padStart(6, "0").slice(-6).toUpperCase()}`
  };
}

function swfBodyFromBuffer(buffer) {
  const signature = buffer.subarray(0, 3).toString("ascii");
  const version = buffer[3];
  const declaredLength = buffer.readUInt32LE(4);

  if (signature === "FWS") {
    return {
      signature,
      version,
      declaredLength,
      body: buffer.subarray(8)
    };
  }

  if (signature === "CWS") {
    return {
      signature,
      version,
      declaredLength,
      body: inflateSync(buffer.subarray(8))
    };
  }

  return {
    signature,
    version,
    declaredLength,
    body: null,
    error: signature === "ZWS"
      ? "LZMA-compressed SWF inspection is not implemented."
      : `Unknown SWF signature ${signature}.`
  };
}

function bitReader(buffer) {
  return {
    readBits(bitOffset, count) {
      let value = 0;

      for (let index = 0; index < count; index += 1) {
        const currentBit = bitOffset + index;
        const byte = buffer[Math.floor(currentBit / 8)];
        const bit = 7 - (currentBit % 8);
        value = (value << 1) | ((byte >> bit) & 1);
      }

      return value;
    }
  };
}

function firstTagOffset(body) {
  if (!body || body.length < 8) return 0;

  const reader = bitReader(body);
  const rectBits = reader.readBits(0, 5);
  const rectByteLength = Math.ceil((5 + rectBits * 4) / 8);

  return rectByteLength + 4;
}

function readNullTerminatedString(buffer, offset, end) {
  let cursor = offset;

  while (cursor < end && buffer[cursor] !== 0) {
    cursor += 1;
  }

  return {
    value: buffer.subarray(offset, cursor).toString("utf8"),
    nextOffset: Math.min(cursor + 1, end)
  };
}

function parseSymbolTag(buffer, start, end, source) {
  if (start + 2 > end) return [];

  const symbols = [];
  const count = buffer.readUInt16LE(start);
  let cursor = start + 2;

  for (let index = 0; index < count && cursor + 2 <= end; index += 1) {
    const characterId = buffer.readUInt16LE(cursor);
    const stringResult = readNullTerminatedString(buffer, cursor + 2, end);
    cursor = stringResult.nextOffset;

    if (stringResult.value) {
      symbols.push({
        characterId,
        name: stringResult.value,
        source
      });
    }
  }

  return symbols;
}

function parseSwfSymbols(body) {
  const symbols = [];
  let cursor = firstTagOffset(body);

  while (cursor + 2 <= body.length) {
    const rawHeader = body.readUInt16LE(cursor);
    cursor += 2;

    const code = rawHeader >> 6;
    let length = rawHeader & 0x3f;

    if (length === 0x3f) {
      if (cursor + 4 > body.length) break;
      length = body.readUInt32LE(cursor);
      cursor += 4;
    }

    const tagStart = cursor;
    const tagEnd = Math.min(cursor + length, body.length);

    if (code === 56) {
      symbols.push(...parseSymbolTag(body, tagStart, tagEnd, "ExportAssets"));
    } else if (code === 76) {
      symbols.push(...parseSymbolTag(body, tagStart, tagEnd, "SymbolClass"));
    }

    cursor = tagEnd;

    if (code === 0) break;
  }

  const seen = new Set();
  return symbols.filter((symbol) => {
    const key = `${symbol.characterId}:${symbol.name}:${symbol.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function inspectSwfFile(filePath) {
  const buffer = await readFile(filePath);
  const swf = swfBodyFromBuffer(buffer);
  const symbols = swf.body ? parseSwfSymbols(swf.body) : [];

  return {
    signature: swf.signature,
    version: swf.version,
    declaredLength: swf.declaredLength,
    exportedSymbols: symbols.map((symbol) => symbol.name),
    symbols,
    error: swf.error || undefined
  };
}

function symbolMatches(symbols, names) {
  const symbolSet = new Set(symbols);
  return names.map((name) => ({
    name,
    available: symbolSet.has(name)
  }));
}

function slotInfo(slots, slot) {
  const value = slots[slot];

  if (!value) {
    return {
      gameFilePath: null,
      symbolBase: ""
    };
  }

  if (typeof value === "string") {
    return {
      gameFilePath: value,
      symbolBase: cleanSymbolBase(value)
    };
  }

  return {
    gameFilePath: value.gameFilePath || null,
    symbolBase: cleanSymbolBase(value.symbolBase || value.gameFilePath)
  };
}

function assetForSlot(slots, slot) {
  return slotInfo(slots, slot).gameFilePath;
}

function expectedSymbolsForLayer(layer, slots, gender) {
  const { gameFilePath, symbolBase } = slotInfo(slots, layer.slot);
  const base = symbolBase || cleanSymbolBase(gameFilePath);

  if (layer.builtIn) {
    return [{
      name: `Avatar${gender}${layer.part}`,
      available: false,
      builtIn: true
    }];
  }

  if (!gameFilePath || !base) return [];

  if (layer.slot === "armor" && layer.part) {
    return [{ name: `${base}${gender}${layer.part}`, available: false }];
  }

  if (layer.slot === "hair" && layer.part) {
    return [{ name: `${base}${gender}${layer.part}`, available: false }];
  }

  return [{ name: base, available: false }];
}

function layerPlan(slots, assetRecords, gender) {
  const assetsByPath = new Map(assetRecords.map((asset) => [asset.gameFilePath, asset]));

  return AVATAR_LAYERS.map((layer) => {
    const assetPath = assetForSlot(slots, layer.slot);
    const asset = assetPath ? assetsByPath.get(assetPath) : null;
    const expected = expectedSymbolsForLayer(layer, slots, gender);
    const matched = asset
      ? symbolMatches(asset.exportedSymbols, expected.map((symbol) => symbol.name))
      : expected;

    return {
      ...layer,
      asset: assetPath,
      expectedSymbols: matched,
      available: layer.builtIn || matched.length === 0 || matched.some((symbol) => symbol.available)
    };
  }).filter((layer) => layer.builtIn || layer.asset || layer.expectedSymbols.length > 0);
}

function slotSummary(slots, assetRecords) {
  const assetsByPath = new Map(assetRecords.map((asset) => [asset.gameFilePath, asset]));

  return Object.fromEntries(Object.keys(slots).map((slot) => {
    const { gameFilePath, symbolBase } = slotInfo(slots, slot);
    const asset = gameFilePath ? assetsByPath.get(gameFilePath) : null;

    return [slot, {
      gameFilePath,
      available: Boolean(asset?.available),
      localUrl: asset?.localUrl || "",
      symbolBase: symbolBase || (gameFilePath ? cleanSymbolBase(gameFilePath) : ""),
      exportedSymbols: asset?.exportedSymbols || []
    }];
  }));
}

export async function buildCompositorManifest(character, itemAssets, slots, resolveCacheFilePath) {
  const gender = character.flashVars.strGender === "M" ? "M" : "F";
  const assetRecords = [];

  for (const asset of itemAssets.files) {
    if (!asset?.gameFilePath) continue;

    const record = {
      gameFilePath: asset.gameFilePath,
      localUrl: asset.localUrl || "",
      directUrl: asset.directUrl || "",
      available: Boolean(asset.available),
      cached: Boolean(asset.cached),
      symbolBase: cleanSymbolBase(asset.gameFilePath)
    };

    if (asset.available) {
      try {
        const inspection = await inspectSwfFile(resolveCacheFilePath(asset.gameFilePath));
        Object.assign(record, inspection);
      } catch (error) {
        record.error = error.message;
        record.exportedSymbols = [];
        record.symbols = [];
      }
    } else {
      record.error = asset.error || "SWF asset is not available.";
      record.exportedSymbols = [];
      record.symbols = [];
    }

    assetRecords.push(record);
  }

  return {
    character: {
      name: character.name,
      gender,
      source: character.source
    },
    renderer: {
      type: "item-swf-compositor-manifest",
      usesCharacterBSwf: false,
      status: "manifest-only",
      reason: "AQWorlds item SWFs are Flash symbol libraries. This endpoint resolves the libraries, symbols, colors, and layer order for a separate compositor; rasterizing those symbols still requires an AS3 wrapper SWF/compiler or a SWF vector/AVM2 renderer."
    },
    colors: {
      hair: numberColor(character.flashVars.intColorHair),
      skin: numberColor(character.flashVars.intColorSkin),
      eye: numberColor(character.flashVars.intColorEye),
      trim: numberColor(character.flashVars.intColorTrim),
      base: numberColor(character.flashVars.intColorBase),
      accessory: numberColor(character.flashVars.intColorAccessory)
    },
    slots: slotSummary(slots, assetRecords),
    armorParts: ARMOR_PARTS,
    layers: layerPlan(slots, assetRecords, gender),
    assets: {
      cacheKey: itemAssets.cacheKey,
      baseUrl: itemAssets.baseUrl,
      files: assetRecords
    }
  };
}
