import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

function pushUi8(bytes, value) {
  bytes.push(value & 0xff);
}

function pushUi16(bytes, value) {
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

function pushUi32(bytes, value) {
  bytes.push(
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff
  );
}

function pushString(bytes, value) {
  for (const byte of Buffer.from(String(value), "utf8")) {
    bytes.push(byte);
  }
  bytes.push(0);
}

function bitWriter() {
  const bytes = [];
  let current = 0;
  let used = 0;

  function writeBit(bit) {
    current = (current << 1) | (bit ? 1 : 0);
    used += 1;

    if (used === 8) {
      bytes.push(current);
      current = 0;
      used = 0;
    }
  }

  return {
    writeUnsigned(value, bits) {
      for (let index = bits - 1; index >= 0; index -= 1) {
        writeBit((value >> index) & 1);
      }
    },
    writeSigned(value, bits) {
      const encoded = value < 0
        ? (1 << bits) + value
        : value;
      this.writeUnsigned(encoded, bits);
    },
    finish() {
      if (used > 0) {
        bytes.push(current << (8 - used));
      }

      return bytes;
    }
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

function signedBitCount(values) {
  let bits = 1;

  for (const value of values) {
    const magnitude = Math.abs(Number(value) || 0);

    while (magnitude >= (1 << (bits - 1))) {
      bits += 1;
    }
  }

  return bits + 1;
}

function rectBytes(widthPixels, heightPixels) {
  const xmax = Math.round(widthPixels * 20);
  const ymax = Math.round(heightPixels * 20);
  const bits = signedBitCount([0, xmax, ymax]);
  const writer = bitWriter();

  writer.writeUnsigned(bits, 5);
  writer.writeSigned(0, bits);
  writer.writeSigned(xmax, bits);
  writer.writeSigned(0, bits);
  writer.writeSigned(ymax, bits);

  return writer.finish();
}

function matrixBytes({ x = 0, y = 0, scaleX = 1, scaleY = 1 } = {}) {
  const tx = Math.round(x * 20);
  const ty = Math.round(y * 20);
  const sx = Math.round(scaleX * 65536);
  const sy = Math.round(scaleY * 65536);
  const writer = bitWriter();

  const hasScale = sx !== 65536 || sy !== 65536;
  writer.writeUnsigned(hasScale ? 1 : 0, 1);

  if (hasScale) {
    const scaleBits = signedBitCount([sx, sy]);
    writer.writeUnsigned(scaleBits, 5);
    writer.writeSigned(sx, scaleBits);
    writer.writeSigned(sy, scaleBits);
  }

  writer.writeUnsigned(0, 1);

  const translateBits = signedBitCount([tx, ty]);
  writer.writeUnsigned(translateBits, 5);
  writer.writeSigned(tx, translateBits);
  writer.writeSigned(ty, translateBits);

  return writer.finish();
}

function skipMatrixBytes(buffer, offset) {
  let bit = offset * 8;
  const reader = bitReader(buffer);
  const hasScale = reader.readBits(bit, 1);
  bit += 1;

  if (hasScale) {
    const bits = reader.readBits(bit, 5);
    bit += 5 + bits * 2;
  }

  const hasRotate = reader.readBits(bit, 1);
  bit += 1;

  if (hasRotate) {
    const bits = reader.readBits(bit, 5);
    bit += 5 + bits * 2;
  }

  const translateBits = reader.readBits(bit, 5);
  bit += 5 + translateBits * 2;

  return Math.ceil((bit - offset * 8) / 8);
}

function tagBytes(code, payload = []) {
  const bytes = [];
  const length = payload.length;

  if (length < 0x3f) {
    pushUi16(bytes, (code << 6) | length);
  } else {
    pushUi16(bytes, (code << 6) | 0x3f);
    pushUi32(bytes, length);
  }

  return [...bytes, ...payload];
}

function firstTagOffset(body) {
  if (!body || body.length < 8) return 0;

  const reader = bitReader(body);
  const rectBits = reader.readBits(0, 5);
  const rectByteLength = Math.ceil((5 + rectBits * 4) / 8);

  return rectByteLength + 4;
}

function swfBodyFromBuffer(buffer) {
  const signature = buffer.subarray(0, 3).toString("ascii");

  if (signature === "FWS") return buffer.subarray(8);
  if (signature === "CWS") return inflateSync(buffer.subarray(8));

  throw new Error(`Unsupported SWF signature ${signature}.`);
}

function parseTags(body) {
  const tags = [];
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

    const start = cursor;
    const end = Math.min(cursor + length, body.length);

    tags.push({
      code,
      payload: [...body.subarray(start, end)]
    });

    cursor = end;

    if (code === 0) break;
  }

  return tags;
}

function readNullTerminatedString(payload, offset, end = payload.length) {
  let cursor = offset;

  while (cursor < end && payload[cursor] !== 0) {
    cursor += 1;
  }

  return {
    value: Buffer.from(payload.slice(offset, cursor)).toString("utf8"),
    nextOffset: Math.min(cursor + 1, end)
  };
}

function rewriteSymbolClassPayload(payload) {
  if (payload.length < 2) return payload;

  const buffer = Buffer.from(payload);
  const symbols = [];
  const count = buffer.readUInt16LE(0);
  let cursor = 2;

  for (let index = 0; index < count && cursor + 2 <= payload.length; index += 1) {
    const characterId = buffer.readUInt16LE(cursor);
    const stringResult = readNullTerminatedString(payload, cursor + 2);
    cursor = stringResult.nextOffset;

    if (stringResult.value && characterId !== 0) {
      symbols.push({
        characterId,
        name: stringResult.value
      });
    }
  }

  const rewritten = [];
  pushUi16(rewritten, symbols.length);

  for (const symbol of symbols) {
    pushUi16(rewritten, symbol.characterId);
    pushString(rewritten, symbol.name);
  }

  return rewritten;
}

function rewritePlaceObject2Payload(payload, visibleTransform, hiddenTransform) {
  if (payload.length < 3) return payload;

  const buffer = Buffer.from(payload);
  let cursor = 0;
  const flags = buffer[cursor];
  cursor += 1;
  const depth = buffer.readUInt16LE(cursor);
  cursor += 2;
  let characterId = null;

  if (flags & 0x02) {
    if (cursor + 2 > payload.length) return payload;
    characterId = buffer.readUInt16LE(cursor);
    cursor += 2;
  }

  const matrixStart = cursor;
  const matrixLength = flags & 0x04 ? skipMatrixBytes(buffer, cursor) : 0;
  const restStart = matrixStart + matrixLength;
  const isAvatar = characterId === 127 || depth === 11;
  const transform = isAvatar ? visibleTransform : hiddenTransform;
  const rewritten = [];

  pushUi8(rewritten, flags | 0x04);
  pushUi16(rewritten, depth);

  if (flags & 0x02) {
    pushUi16(rewritten, characterId);
  }

  rewritten.push(...matrixBytes(transform), ...payload.slice(restStart));

  return rewritten;
}

function rewritePlaceObject3Payload(payload, visibleTransform, hiddenTransform) {
  if (payload.length < 4) return payload;

  const buffer = Buffer.from(payload);
  let cursor = 0;
  const flags = buffer[cursor];
  cursor += 1;
  const extraFlags = buffer[cursor];
  cursor += 1;
  const depth = buffer.readUInt16LE(cursor);
  cursor += 2;

  if (extraFlags & 0x08 || ((extraFlags & 0x10) && (flags & 0x02))) {
    const stringResult = readNullTerminatedString(payload, cursor);
    cursor = stringResult.nextOffset;
  }

  let characterId = null;
  if (flags & 0x02) {
    if (cursor + 2 > payload.length) return payload;
    characterId = buffer.readUInt16LE(cursor);
    cursor += 2;
  }

  const matrixStart = cursor;
  const matrixLength = flags & 0x04 ? skipMatrixBytes(buffer, cursor) : 0;
  const restStart = matrixStart + matrixLength;
  const isAvatar = characterId === 127 || depth === 11;
  const transform = isAvatar ? visibleTransform : hiddenTransform;
  const rewritten = [];

  pushUi8(rewritten, flags | 0x04);
  pushUi8(rewritten, extraFlags);
  pushUi16(rewritten, depth);

  if (extraFlags & 0x08 || ((extraFlags & 0x10) && (flags & 0x02))) {
    const stringResult = readNullTerminatedString(payload, 4);
    pushString(rewritten, stringResult.value);
  }

  if (flags & 0x02) {
    pushUi16(rewritten, characterId);
  }

  rewritten.push(...matrixBytes(transform), ...payload.slice(restStart));

  return rewritten;
}

function fileAttributesTag() {
  const payload = [];

  // ActionScript 3 + network access. Imported AQW symbols are AVM2 SWFs.
  pushUi32(payload, 0x08 | 0x80);

  return tagBytes(69, payload);
}

function importAssets2Tag(url, assets) {
  const payload = [];

  pushString(payload, url);
  pushUi8(payload, 1);
  pushUi8(payload, 0);
  pushUi16(payload, assets.length);

  for (const asset of assets) {
    pushUi16(payload, asset.id);
    pushString(payload, asset.name);
  }

  return tagBytes(71, payload);
}

function placeObject2Tag({ id, depth, x, y, scaleX, scaleY, name }) {
  const payload = [];

  let flags = 0x02 | 0x04;
  if (name) flags |= 0x20;

  pushUi8(payload, flags);
  pushUi16(payload, depth);
  pushUi16(payload, id);
  payload.push(...matrixBytes({ x, y, scaleX, scaleY }));

  if (name) pushString(payload, name);

  return tagBytes(26, payload);
}

export function buildAvatarOnlySwf({
  avatarSourceUrl,
  width = 720,
  height = 1119,
  avatarX = 360,
  avatarY = 610,
  avatarScale = 1
}) {
  const body = [
    ...fileAttributesTag(),
    ...importAssets2Tag(avatarSourceUrl, [{ id: 1, name: "AvatarMC" }]),
    ...placeObject2Tag({
      id: 1,
      depth: 1,
      x: avatarX,
      y: avatarY,
      scaleX: avatarScale,
      scaleY: avatarScale,
      name: "avatar"
    }),
    ...tagBytes(1),
    ...tagBytes(0)
  ];

  const header = [];
  header.push(...Buffer.from("FWS", "ascii"));
  pushUi8(header, 15);

  const frame = [
    ...rectBytes(width, height),
    0x00,
    0x18,
    0x01,
    0x00
  ];
  const length = header.length + 4 + frame.length + body.length;

  pushUi32(header, length);

  return Buffer.from([...header, ...frame, ...body]);
}

export function buildCharacterBAvatarShellSwf({
  characterBBuffer,
  width = 720,
  height = 1119,
  avatarSymbolId = 127,
  avatarX = 360,
  avatarY = 700,
  avatarScaleX = -2.3,
  avatarScaleY = 2.3
}) {
  const sourceBody = swfBodyFromBuffer(characterBBuffer);
  const sourceTags = parseTags(sourceBody);
  const skippedRootTimelineTags = new Set([
    0,  // End
    1,  // ShowFrame
    4,  // PlaceObject
    5,  // RemoveObject
    9,  // SetBackgroundColor
    12, // DoAction
    26, // PlaceObject2
    28, // RemoveObject2
    43, // FrameLabel
    70, // PlaceObject3
    86  // DefineSceneAndFrameLabelData
  ]);
  const body = [
    ...fileAttributesTag()
  ];

  for (const tag of sourceTags) {
    if (tag.code === 69 || skippedRootTimelineTags.has(tag.code)) continue;

    body.push(...tagBytes(
      tag.code,
      tag.code === 76 ? rewriteSymbolClassPayload(tag.payload) : tag.payload
    ));
  }

  body.push(
    ...placeObject2Tag({
      id: avatarSymbolId,
      depth: 1,
      x: avatarX,
      y: avatarY,
      scaleX: avatarScaleX,
      scaleY: avatarScaleY,
      name: "pMC"
    }),
    ...tagBytes(1),
    ...tagBytes(0)
  );

  const header = [];
  header.push(...Buffer.from("FWS", "ascii"));
  pushUi8(header, 15);

  const frame = [
    ...rectBytes(width, height),
    0x00,
    0x18,
    0x01,
    0x00
  ];
  const length = header.length + 4 + frame.length + body.length;

  pushUi32(header, length);

  return Buffer.from([...header, ...frame, ...body]);
}

export function buildCharacterBMinimalSwf({
  characterBBuffer,
  width = 720,
  height = 1119,
  avatarX = 360,
  avatarY = 760,
  avatarScaleX = -2.298095703125,
  avatarScaleY = 2.298095703125
}) {
  const sourceBody = swfBodyFromBuffer(characterBBuffer);
  const sourceTags = parseTags(sourceBody);
  const visibleTransform = {
    x: avatarX,
    y: avatarY,
    scaleX: avatarScaleX,
    scaleY: avatarScaleY
  };
  const hiddenTransform = {
    x: -5000,
    y: -5000,
    scaleX: 1,
    scaleY: 1
  };
  const body = [];

  for (const tag of sourceTags) {
    if (tag.code === 0 || tag.code === 9) continue;

    let payload = tag.payload;
    if (tag.code === 26) {
      payload = rewritePlaceObject2Payload(payload, visibleTransform, hiddenTransform);
    } else if (tag.code === 70) {
      payload = rewritePlaceObject3Payload(payload, visibleTransform, hiddenTransform);
    }

    body.push(...tagBytes(tag.code, payload));
  }

  body.push(...tagBytes(0));

  const header = [];
  header.push(...Buffer.from("FWS", "ascii"));
  pushUi8(header, 15);

  const frame = [
    ...rectBytes(width, height),
    0x00,
    0x18,
    0x01,
    0x00
  ];
  const length = header.length + 4 + frame.length + body.length;

  pushUi32(header, length);

  return Buffer.from([...header, ...frame, ...body]);
}

export async function writeCharacterBAvatarShellSwf(filePath, options) {
  const characterBBuffer = options.characterBBuffer || await readFile(options.characterBPath);

  await writeFile(filePath, buildCharacterBAvatarShellSwf({
    ...options,
    characterBBuffer
  }));
}

export async function writeCharacterBMinimalSwf(filePath, options) {
  const characterBBuffer = options.characterBBuffer || await readFile(options.characterBPath);

  await writeFile(filePath, buildCharacterBMinimalSwf({
    ...options,
    characterBBuffer
  }));
}

export async function writeAvatarOnlySwf(filePath, options) {
  await writeFile(filePath, buildAvatarOnlySwf(options));
}
