import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCompositorManifest } from "./compositor.js";
import { writeCharacterBMinimalSwf } from "./custom-swf.js";

const AQ_CHARPAGE_URL = "https://account.aq.com/CharPage";
const AQ_GAME_FILES_URL = "https://game.aq.com/game/gamefiles";
const LOCAL_GAME_FILES_PREFIX = "/aqw/gamefiles/";
const LOCAL_CACHE_PREFIX = "/cache/aqw/";
const LOCAL_RUFFLE_PREFIX = "/vendor/ruffle/";
const CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".cache", "aqw-gamefiles");
const RENDER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".cache", "renders");
const RUFFLE_CACHE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".cache", "ruffle");
const REQUEST_LOG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".cache", "logs", "requests.log");
const NODE_EXE = process.execPath;
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const RUFFLE_CDN_BASE = (process.env.RUFFLE_CDN_BASE || "https://unpkg.com/@ruffle-rs/ruffle@0.2.0-nightly.2026.5.4").replace(/\/+$/, "");
const LOG_TIME_ZONE = process.env.LOG_TIME_ZONE || "Asia/Manila";
const REQUEST_FILE_LOG =
  process.env.REQUEST_FILE_LOG === "1" ||
  (process.env.REQUEST_FILE_LOG !== "0" && process.env.NODE_ENV !== "production");
const SHARED_VIEWER_CACHE_KEY = "_shared";
const CUSTOM_VIEWER_CACHE_KEY = "_custom";
const CUSTOM_VIEWER_GAME_FILE_PATH = "etc/chardetail/characterMinimal.swf";
const AQW_FETCH_LIMIT = Math.max(1, Number(process.env.AQW_FETCH_LIMIT || 2));
const AQW_FETCH_WINDOW_MS = Math.max(250, Number(process.env.AQW_FETCH_WINDOW_MS || 3000));
const RENDER_MANIFEST_VERSION = "flashvars-v1";
const DOWNLOADS_DIR = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, "Downloads")
  : path.resolve("Downloads");

let aqwFetchQueue = Promise.resolve();
const aqwFetchStarts = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scheduleAqwFetch(task) {
  const run = aqwFetchQueue.then(async () => {
    const now = Date.now();

    while (aqwFetchStarts.length > 0 && now - aqwFetchStarts[0] >= AQW_FETCH_WINDOW_MS) {
      aqwFetchStarts.shift();
    }

    if (aqwFetchStarts.length >= AQW_FETCH_LIMIT) {
      const waitMs = AQW_FETCH_WINDOW_MS - (now - aqwFetchStarts[0]);

      if (waitMs > 0) {
        await delay(waitMs);
      }

      const afterWait = Date.now();
      while (aqwFetchStarts.length > 0 && afterWait - aqwFetchStarts[0] >= AQW_FETCH_WINDOW_MS) {
        aqwFetchStarts.shift();
      }
    }

    aqwFetchStarts.push(Date.now());
    return task();
  });

  aqwFetchQueue = run.catch(() => {});
  return run;
}

function fetchAqwGameFile(url, options) {
  return scheduleAqwFetch(() => fetch(url, options));
}

function normalizeName(rawName) {
  const name = String(rawName || "").trim();

  if (!name || name.length > 25) {
    throw Object.assign(new Error("Character name must be 1-25 characters."), {
      status: 400
    });
  }

  return name;
}

function parseFlashVars(rawFlashVars) {
  const decoded = decodeHtmlEntities(rawFlashVars || "");
  const params = new URLSearchParams(decoded.startsWith("&") ? decoded.slice(1) : decoded);
  return Object.fromEntries(params.entries());
}

function decodeHtmlEntities(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function firstMatch(text, pattern) {
  return pattern.exec(text)?.[1];
}

function cacheKeyForName(name) {
  return String(name || "character")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "character";
}

function normalizeGameFilePath(value) {
  const rawValue = String(value || "").trim();

  if (!rawValue || rawValue.toLowerCase() === "none") return null;

  let pathname = rawValue;
  try {
    const url = new URL(rawValue);

    if (url.origin !== "https://game.aq.com" || !url.pathname.startsWith("/game/gamefiles/")) {
      return null;
    }

    pathname = url.pathname.slice("/game/gamefiles/".length);
  } catch {
    pathname = rawValue.split("?")[0].split("#")[0];
  }

  pathname = pathname.replaceAll("\\", "/").replace(/^\/+/, "");

  if (!pathname || pathname.includes("..") || !pathname.toLowerCase().endsWith(".swf")) {
    return null;
  }

  return pathname;
}

function cacheFilePath(cacheKey, gameFilePath) {
  return path.join(CACHE_DIR, cacheKey, ...gameFilePath.split("/"));
}

function cacheFileUrl(cacheKey, gameFilePath) {
  return `${LOCAL_CACHE_PREFIX}${encodeURIComponent(cacheKey)}/${gameFilePath.split("/").map(encodeURIComponent).join("/")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])])
    );
  }

  return value;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

function renderManifestPath(outputPath) {
  return `${outputPath}.json`;
}

function renderInputHash(character, options) {
  return sha256({
    version: RENDER_MANIFEST_VERSION,
    flashVars: character.flashVars,
    swfUrl: character.swfUrl,
    options
  });
}

function renderCacheSignature(character, options) {
  return {
    flashVarsHash: sha256(character.flashVars),
    optionsHash: sha256({
      version: RENDER_MANIFEST_VERSION,
      options
    })
  };
}

async function readRenderManifest(outputPath) {
  try {
    return JSON.parse(await readFile(renderManifestPath(outputPath), "utf8"));
  } catch {
    return null;
  }
}

async function writeRenderManifest(outputPath, manifest) {
  await writeFile(renderManifestPath(outputPath), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function canReuseRender(outputPath, expectedSignature) {
  if (!(await fileExists(outputPath))) return false;

  const manifest = await readRenderManifest(outputPath);
  return (
    manifest?.flashVarsHash === expectedSignature.flashVarsHash &&
    manifest?.optionsHash === expectedSignature.optionsHash
  );
}

async function fileExists(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function gameFilePathForFlashVar(key, value, flashVars) {
  const gameFilePath = normalizeGameFilePath(value);

  if (!gameFilePath) return null;

  if (
    !gameFilePath.includes("/") &&
    ["strClassFile", "strCustArmorFile"].includes(key)
  ) {
    const gender = flashVars.strGender === "M" ? "M" : "F";
    return `classes/${gender}/${gameFilePath}`;
  }

  return gameFilePath;
}

function isGroundItemFile(key, value, flashVars) {
  const gameFilePath = gameFilePathForFlashVar(key, value, flashVars);
  return key === "strMiscFile" || gameFilePath?.toLowerCase().includes("/grounds/");
}

function pickDisplayEquipment(flashVars) {
  return {
    class: flashVars.strClassName || "",
    weapon: flashVars.strCustWeaponName || flashVars.strWeaponName || "",
    armor: flashVars.strCustArmorName || flashVars.strArmorName || "",
    helm: flashVars.strCustHelmName || flashVars.strHelmName || "",
    cape: flashVars.strCustCapeName || flashVars.strCapeName || "",
    pet: flashVars.strCustPetName || flashVars.strPetName || "",
    misc: flashVars.strCustMiscName || flashVars.strMiscName || ""
  };
}

function pickEquippedEquipment(flashVars) {
  return {
    class: flashVars.strClassName || "",
    weapon: flashVars.strWeaponName || "",
    armor: flashVars.strArmorName || "",
    helm: flashVars.strHelmName || "",
    cape: flashVars.strCapeName || "",
    pet: flashVars.strPetName || "",
    misc: flashVars.strMiscName || ""
  };
}

function compositorSlot(gameFilePath, symbolBase) {
  return gameFilePath
    ? {
      gameFilePath,
      symbolBase: symbolBase || ""
    }
    : null;
}

function pickCompositorSlots(flashVars, options = {}) {
  const includePet = options.includePet !== false;
  const includeGround = options.includeGround === true;
  const armorPath =
    gameFilePathForFlashVar("strCustArmorFile", flashVars.strCustArmorFile, flashVars) ||
    gameFilePathForFlashVar("strArmorFile", flashVars.strArmorFile, flashVars) ||
    gameFilePathForFlashVar("strClassFile", flashVars.strClassFile, flashVars);

  return {
    armor: compositorSlot(
      armorPath,
      flashVars.strCustArmorLink || flashVars.strArmorLink || flashVars.strClassLink
    ),
    hair: compositorSlot(
      gameFilePathForFlashVar("strHairFile", flashVars.strHairFile, flashVars),
      flashVars.strHairName
    ),
    helm: compositorSlot(
      gameFilePathForFlashVar("strHelmFile", flashVars.strHelmFile, flashVars),
      flashVars.strCustHelmLink || flashVars.strHelmLink
    ),
    cape: compositorSlot(
      gameFilePathForFlashVar("strCapeFile", flashVars.strCapeFile, flashVars),
      flashVars.strCustCapeLink || flashVars.strCapeLink
    ),
    weapon: compositorSlot(
      gameFilePathForFlashVar("strWeaponFile", flashVars.strWeaponFile, flashVars),
      flashVars.strCustWeaponLink || flashVars.strWeaponLink
    ),
    pet: includePet
      ? compositorSlot(
        gameFilePathForFlashVar("strPetFile", flashVars.strPetFile, flashVars),
        flashVars.strCustPetLink || flashVars.strPetLink
      )
      : null,
    misc: includeGround
      ? compositorSlot(
        gameFilePathForFlashVar("strMiscFile", flashVars.strMiscFile, flashVars),
        flashVars.strCustMiscLink || flashVars.strMiscLink
      )
      : null
  };
}

function toLocalGameFileUrl(value) {
  try {
    const url = new URL(value);

    if (url.origin === "https://game.aq.com" && url.pathname.startsWith("/game/gamefiles/")) {
      return `${LOCAL_GAME_FILES_PREFIX}${url.pathname.slice("/game/gamefiles/".length)}${url.search}`;
    }
  } catch {
    return value;
  }

  return value;
}

function getGameFileContentType(pathname, upstreamType) {
  if (upstreamType) return upstreamType;
  if (pathname.endsWith(".swf")) return "application/x-shockwave-flash";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".xml")) return "application/xml; charset=utf-8";
  return "application/octet-stream";
}

function getRuffleContentType(fileName) {
  if (fileName.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (fileName.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function normalizeRuffleFileName(value) {
  const fileName = String(value || "").trim();

  if (!/^[a-z0-9._-]+$/i.test(fileName)) return null;
  if (!fileName.endsWith(".js") && !fileName.endsWith(".wasm")) return null;

  return fileName;
}

async function ensureRuffleFile(fileName) {
  const safeName = normalizeRuffleFileName(fileName);

  if (!safeName) {
    throw Object.assign(new Error("Invalid Ruffle file path."), { status: 400 });
  }

  const destination = path.join(RUFFLE_CACHE_DIR, safeName);

  if (await fileExists(destination)) {
    return destination;
  }

  await mkdir(RUFFLE_CACHE_DIR, { recursive: true });
  const response = await fetch(`${RUFFLE_CDN_BASE}/${safeName}`, {
    headers: {
      "User-Agent": "aqworlds-character-api/1.0"
    }
  });

  if (!response.ok) {
    throw Object.assign(new Error(`Ruffle returned ${response.status}.`), {
      status: 502
    });
  }

  const content = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, content);

  return destination;
}

async function serveRuffleFile(reqUrl, res) {
  const fileName = normalizeRuffleFileName(decodeURIComponent(reqUrl.pathname.slice(LOCAL_RUFFLE_PREFIX.length)));

  if (!fileName) {
    send(res, 400, "application/json; charset=utf-8", JSON.stringify({ error: "Invalid Ruffle file path." }));
    return;
  }

  const filePath = await ensureRuffleFile(fileName);
  const info = await stat(filePath);

  res.writeHead(200, {
    "Content-Type": getRuffleContentType(fileName),
    "Content-Length": info.size,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*"
  });
  createReadStream(filePath).pipe(res);
}

async function proxyGameFile(reqUrl, res) {
  const suffix = reqUrl.pathname.slice(LOCAL_GAME_FILES_PREFIX.length);

  if (!suffix || suffix.includes("..")) {
    send(res, 400, "application/json; charset=utf-8", JSON.stringify({ error: "Invalid game file path." }));
    return;
  }

  const upstreamUrl = `${AQ_GAME_FILES_URL}/${suffix}${reqUrl.search}`;
  const response = await fetchAqwGameFile(upstreamUrl, {
    headers: {
      "User-Agent": "aqworlds-character-api/1.0"
    }
  });

  if (!response.ok) {
    send(res, response.status, "application/json; charset=utf-8", JSON.stringify({
      error: `AQWorlds game file returned ${response.status}.`
    }));
    return;
  }

  const content = Buffer.from(await response.arrayBuffer());
  res.writeHead(200, {
    "Content-Type": getGameFileContentType(suffix, response.headers.get("content-type")),
    "Content-Length": content.length,
    "Cache-Control": "public, max-age=86400",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(content);
}

function remoteCandidatesForGameFile(gameFilePath) {
  if (gameFilePath.includes("/")) {
    return [`${AQ_GAME_FILES_URL}/${gameFilePath}`];
  }

  return [
    `${AQ_GAME_FILES_URL}/${gameFilePath}`,
    `${AQ_GAME_FILES_URL}/classes/F/${gameFilePath}`,
    `${AQ_GAME_FILES_URL}/classes/M/${gameFilePath}`,
    `${AQ_GAME_FILES_URL}/classes/${gameFilePath}`,
    `${AQ_GAME_FILES_URL}/items/classes/${gameFilePath}`,
    `${AQ_GAME_FILES_URL}/items/armors/${gameFilePath}`,
    `${AQ_GAME_FILES_URL}/armors/${gameFilePath}`
  ];
}

function directGameFileUrl(gameFilePath) {
  return `${AQ_GAME_FILES_URL}/${gameFilePath}`;
}

function isSharedViewerSwf(gameFilePath) {
  return gameFilePath === "etc/chardetail/characterB.swf";
}

async function ensureCustomViewerSwf() {
  const sourcePath = cacheFilePath(SHARED_VIEWER_CACHE_KEY, "etc/chardetail/characterB.swf");
  const destination = cacheFilePath(CUSTOM_VIEWER_CACHE_KEY, CUSTOM_VIEWER_GAME_FILE_PATH);

  if (await fileExists(destination)) return destination;

  if (!(await fileExists(sourcePath))) {
    await downloadGameFile(SHARED_VIEWER_CACHE_KEY, "etc/chardetail/characterB.swf");
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await writeCharacterBMinimalSwf(destination, {
    characterBPath: sourcePath,
    width: 720,
    height: 1119,
    avatarX: 620,
    avatarY: 920,
    avatarScaleX: -5,
    avatarScaleY: 5
  });

  return destination;
}

function profileGifSourcePath(characterName) {
  return path.join(DOWNLOADS_DIR, `${cacheKeyForName(characterName)}.gif`);
}

async function downloadGameFile(cacheKey, gameFilePath) {
  const destination = cacheFilePath(cacheKey, gameFilePath);

  if (await fileExists(destination)) {
    return {
      gameFilePath,
      localUrl: cacheFileUrl(cacheKey, gameFilePath),
      directUrl: directGameFileUrl(gameFilePath),
      cached: true,
      available: true
    };
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const attempts = [];

  for (const remoteUrl of remoteCandidatesForGameFile(gameFilePath)) {
    try {
      const response = await fetchAqwGameFile(remoteUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 aqworlds-character-api/1.0"
        }
      });

      attempts.push({
        remoteUrl,
        status: response.status,
        retryAfter: response.headers.get("retry-after") || undefined
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");

        return {
          gameFilePath,
          requestedLocalUrl: cacheFileUrl(cacheKey, gameFilePath),
          directUrl: directGameFileUrl(gameFilePath),
          available: false,
          retryAfterSeconds: retryAfter ? Number(retryAfter) : null,
          attempts,
          error: `AQWorlds rate limited the SWF download (429). Try again${retryAfter ? ` in about ${retryAfter} seconds` : " after a short cooldown"}.`
        };
      }

      if (!response.ok) continue;

      const content = Buffer.from(await response.arrayBuffer());
      const signature = content.subarray(0, 3).toString("ascii");

      if (!["FWS", "CWS", "ZWS"].includes(signature)) {
        attempts.at(-1).error = `unexpected signature ${signature}`;
        continue;
      }

      await writeFile(destination, content);

      return {
        gameFilePath,
        localUrl: cacheFileUrl(cacheKey, gameFilePath),
      remoteUrl,
      directUrl: directGameFileUrl(gameFilePath),
      cached: false,
      available: true,
      bytes: content.length
      };
    } catch (error) {
      attempts.push({
        remoteUrl,
        error: error.message
      });
    }
  }

  return {
    gameFilePath,
    requestedLocalUrl: cacheFileUrl(cacheKey, gameFilePath),
    directUrl: directGameFileUrl(gameFilePath),
    available: false,
    attempts,
    error: "not found on AQWorlds game files"
  };
}

function collectCharacterSwfFiles(character, options = {}) {
  const includePet = options.includePet !== false;
  const includeGround = options.includeGround === true;
  const files = [normalizeGameFilePath(character.swfUrl)];

  for (const [key, value] of Object.entries(character.flashVars)) {
    if (!includePet && key === "strPetFile") continue;
    if (!includeGround && isGroundItemFile(key, value, character.flashVars)) continue;

    if (key.endsWith("File")) {
      files.push(gameFilePathForFlashVar(key, value, character.flashVars));
    }
  }

  return uniqueValues(files);
}

function collectItemSwfFiles(character) {
  const files = [];

  for (const [key, value] of Object.entries(character.flashVars)) {
    if (key.endsWith("File")) {
      files.push(gameFilePathForFlashVar(key, value, character.flashVars));
    }
  }

  return uniqueValues(files);
}

async function prepareCharacterAssets(character, options = {}) {
  const includePet = options.includePet !== false;
  const includeGround = options.includeGround === true;
  const cacheKey = cacheKeyForName(character.name);
  const swfFiles = collectCharacterSwfFiles(character, { includePet, includeGround });
  const downloads = await Promise.all(swfFiles.map(async (gameFilePath) => {
    const assetCacheKey = isSharedViewerSwf(gameFilePath) ? SHARED_VIEWER_CACHE_KEY : cacheKey;
    const asset = await downloadGameFile(assetCacheKey, gameFilePath);

    return {
      ...asset,
      cacheKey: assetCacheKey,
      shared: assetCacheKey === SHARED_VIEWER_CACHE_KEY
    };
  }));

  const mainPath = normalizeGameFilePath(character.swfUrl);

  return {
    cacheKey,
    viewerCacheKey: SHARED_VIEWER_CACHE_KEY,
    baseUrl: `${LOCAL_CACHE_PREFIX}${encodeURIComponent(cacheKey)}/`,
    main: downloads.find((asset) => asset.gameFilePath === mainPath),
    files: downloads
  };
}

async function prepareItemAssets(character) {
  const cacheKey = cacheKeyForName(character.name);
  const swfFiles = collectItemSwfFiles(character);
  const downloads = await Promise.all(swfFiles.map((gameFilePath) => downloadGameFile(cacheKey, gameFilePath)));

  return {
    cacheKey,
    baseUrl: `${LOCAL_CACHE_PREFIX}${encodeURIComponent(cacheKey)}/`,
    files: downloads
  };
}

async function serveCachedGameFile(reqUrl, res) {
  const rawPath = reqUrl.pathname.slice(LOCAL_CACHE_PREFIX.length);
  const [cacheKey, ...fileParts] = rawPath.split("/").map(decodeURIComponent);
  const gameFilePath = fileParts.join("/");

  if (!cacheKey || !gameFilePath || gameFilePath.includes("..")) {
    send(res, 400, "application/json; charset=utf-8", JSON.stringify({ error: "Invalid cached game file path." }));
    return;
  }

  const filePath = cacheFilePath(cacheKey, gameFilePath);

  if (!(await fileExists(filePath))) {
    const asset = await downloadGameFile(cacheKey, gameFilePath);

    if (!asset.available) {
      send(res, 404, "application/json; charset=utf-8", JSON.stringify({
        error: "Cached game file was not found and could not be downloaded.",
        asset
      }));
      return;
    }
  }

  const info = await stat(filePath);
  res.writeHead(200, {
    "Content-Type": getGameFileContentType(gameFilePath),
    "Content-Length": info.size,
    "Cache-Control": "public, max-age=86400",
    "Access-Control-Allow-Origin": "*"
  });
  createReadStream(filePath).pipe(res);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(Object.assign(new Error(stderr || stdout || `Process exited with code ${code}`), {
        code,
        stdout,
        stderr
      }));
    });
  });
}

async function renderProfileGifFromDownload(sourcePath, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });

  const script = `
from PIL import Image, ImageSequence
import sys

source_path = sys.argv[1]
output_path = sys.argv[2]
source = Image.open(source_path)
frames = []
durations = []

for source_frame in ImageSequence.Iterator(source):
    frame = source_frame.convert("RGBA")
    width, height = frame.size
    pixels = frame.load()

    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            is_green_screen = (
                g > 150 and
                g > r * 1.55 and
                g > b * 1.55 and
                (g - max(r, b)) > 65
            )

            if is_green_screen or y < 72:
                pixels[x, y] = (r, g, b, 0)

    frames.append(frame)
    durations.append(source_frame.info.get("duration", source.info.get("duration", 100)))

if not frames:
    raise SystemExit("Profile GIF source had no frames")

bbox = None
for frame in frames:
    frame_bbox = frame.getbbox()
    if not frame_bbox:
        continue

    if bbox is None:
        bbox = frame_bbox
    else:
        bbox = (
            min(bbox[0], frame_bbox[0]),
            min(bbox[1], frame_bbox[1]),
            max(bbox[2], frame_bbox[2]),
            max(bbox[3], frame_bbox[3])
        )

if bbox is None:
    raise SystemExit("Profile GIF became fully transparent")

pad = 10
bbox = (
    max(0, bbox[0] - pad),
    max(0, bbox[1] - pad),
    min(frames[0].width, bbox[2] + pad),
    min(frames[0].height, bbox[3] + pad)
)
frames = [frame.crop(bbox) for frame in frames]

if output_path.lower().endswith(".png"):
    frames[0].save(output_path, format="PNG")
else:
    frames[0].save(
        output_path,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=False
    )
`;

  await runProcess("C:\\Users\\Yska\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe", [
    "-c",
    script,
    sourcePath,
    outputPath
  ]);
}

async function renderCharacterImage(characterName, reqUrl, character) {
  const cacheKey = cacheKeyForName(characterName);
  await mkdir(RENDER_DIR, { recursive: true });

  const mode = reqUrl.searchParams.get("mode") || "compositor";
  const includePet = reqUrl.searchParams.get("pet") === "1";
  const includeGround = reqUrl.searchParams.get("ground") === "1";
  const sourceMode = reqUrl.searchParams.get("source") || "custom";
  const profileSourcePath = profileGifSourcePath(characterName);
  const useProfileSource =
    !includePet &&
    mode !== "full" &&
    sourceMode === "download" &&
    await fileExists(profileSourcePath);
  const rendererKey = useProfileSource ? "profile" : "viewer";
  const layerKey = [
    includePet ? "pet" : "nopet",
    includeGround ? "ground" : "noground"
  ].join("-");
  const outputPath = path.join(RENDER_DIR, `${cacheKey}-${mode}-${layerKey}-${rendererKey}-${sourceMode}.png`);
  const renderOptions = {
    mode,
    includePet,
    includeGround,
    sourceMode,
    rendererKey
  };
  const inputHash = character ? renderInputHash(character, renderOptions) : null;
  const cacheSignature = character ? renderCacheSignature(character, renderOptions) : null;

  if (cacheSignature && await canReuseRender(outputPath, cacheSignature)) {
    return outputPath;
  }

  if (!inputHash && reqUrl.searchParams.get("refresh") !== "1" && await fileExists(outputPath)) {
    return outputPath;
  }

  if (useProfileSource) {
    await renderProfileGifFromDownload(profileSourcePath, outputPath);
    if (inputHash) {
      await writeRenderManifest(outputPath, {
        inputHash,
        ...cacheSignature,
        character: character.name,
        options: renderOptions,
        renderer: "download",
        updatedAt: new Date().toISOString()
      });
    }
    return outputPath;
  }

  if (sourceMode === "custom") {
    await ensureCustomViewerSwf();
  }

  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "render-gif.mjs");
  const origin = `http://${reqUrl.host}`;
  const characterInputPath = `${outputPath}.input.json`;
  await writeFile(characterInputPath, `${JSON.stringify(character)}\n`);

  await runProcess(NODE_EXE, [
    scriptPath,
    characterName,
    outputPath,
    origin,
    mode,
    [
      includePet ? "pet" : "nopet",
      includeGround ? "ground" : "noground"
    ].join(","),
    sourceMode,
    characterInputPath
  ], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  });

  if (inputHash) {
    await writeRenderManifest(outputPath, {
      inputHash,
      ...cacheSignature,
      character: character.name,
      options: renderOptions,
      renderer: "ruffle",
      updatedAt: new Date().toISOString()
    });
  }

  return outputPath;
}

async function fetchCharacter(name) {
  const characterName = normalizeName(name);
  const url = `${AQ_CHARPAGE_URL}?id=${encodeURIComponent(characterName)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "aqworlds-character-api/1.0"
    }
  });

  if (!response.ok) {
    throw Object.assign(new Error(`AQWorlds returned ${response.status}.`), {
      status: 502
    });
  }

  const html = await response.text();
  const objectMovie = firstMatch(html, /<param\s+name=["']movie["']\s+value=["']([^"']+)["']/i);
  const embedSrc = firstMatch(html, /<embed\b[^>]*\bsrc=["']([^"']+)["']/i);
  const swfUrl = objectMovie || embedSrc;
  const rawFlashVars =
    firstMatch(html, /<param\s+name=["']FlashVars["']\s+value=["']([^"']*)["']/i) ||
    firstMatch(html, /<embed\b[^>]*\bflashvars=["']([^"']*)["']/i);

  if (!swfUrl || !rawFlashVars) {
    throw Object.assign(new Error("Character viewer data was not found."), {
      status: 404
    });
  }

  const flashVars = parseFlashVars(rawFlashVars);
  const resolvedName =
    decodeHtmlEntities(firstMatch(html, /<h1[^>]*>(.*?)<\/h1>/is) || "").trim() ||
    flashVars.strName ||
    characterName;
  const title = decodeHtmlEntities(firstMatch(html, /<h4[^>]*>\s*<em[^>]*>(.*?)<\/em>\s*<\/h4>/is) || "").trim();

  return {
    name: resolvedName,
    title,
    level: Number(flashVars.level || flashVars.intLevel) || null,
    faction: flashVars.strFaction || "",
    guild: flashVars.guild || "",
    gender: flashVars.strGender || "",
    swfUrl,
    flashVars,
    equipment: {
      display: pickDisplayEquipment(flashVars),
      equipped: pickEquippedEquipment(flashVars)
    },
    source: url
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderCharacterOnlyPage(character) {
  const flashVars = new URLSearchParams(character.flashVars).toString();
  const assets = character.assets;
  const hasCachedMain = assets?.main?.available && assets.main.localUrl;
  const localSwfUrl = hasCachedMain ? assets.main.localUrl : toLocalGameFileUrl(character.swfUrl);
  const assetBaseUrl = hasCachedMain ? assets.baseUrl : LOCAL_GAME_FILES_PREFIX;
  const missingAssets = assets?.files?.filter((asset) => !asset.available) || [];
  const retryAfterSeconds = Math.max(0, ...missingAssets.map((asset) => Number(asset.retryAfterSeconds) || 0));
  const missingAssetLinks = missingAssets.map((asset) =>
    `<li>
      <a href="${escapeHtml(asset.directUrl || directGameFileUrl(asset.gameFilePath))}" target="_blank" rel="noreferrer">${escapeHtml(asset.gameFilePath)}</a>
      <code>${escapeHtml(asset.requestedLocalUrl || "")}</code>
    </li>`
  ).join("");
  const playerMarkup = hasCachedMain
    ? `<object data="${escapeHtml(localSwfUrl)}" type="application/x-shockwave-flash">
        <param name="movie" value="${escapeHtml(localSwfUrl)}">
        <param name="FlashVars" value="${escapeHtml(flashVars)}">
        <param name="quality" value="high">
        <param name="loop" value="true">
        <param name="scale" value="showall">
        <param name="allowScriptAccess" value="always">
        <param name="menu" value="true">
        <param name="wmode" value="opaque">
        <embed src="${escapeHtml(localSwfUrl)}" flashvars="${escapeHtml(flashVars)}" wmode="opaque" allowScriptAccess="always" loop="true" quality="high" type="application/x-shockwave-flash" menu="true" scale="showAll"></embed>
      </object>`
    : `<div class="status">
        <strong>SWF files are not cached yet.</strong>
        <span>AQWorlds is currently blocking direct SWF downloads with Cloudflare 429.${retryAfterSeconds ? ` Try again in about ${retryAfterSeconds} seconds.` : ""}</span>
        <span>When the block clears, refreshing this page will download each SWF into the local cache automatically.</span>
        <ul>${missingAssetLinks}</ul>
        <small>${escapeHtml(missingAssets.map((asset) => `${asset.gameFilePath}: ${asset.error}`).join("\n"))}</small>
      </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(character.name)} - AQWorlds Character</title>
  <style>
    html, body {
      height: 100%;
      margin: 0;
      background: #050505;
      color: #f5e7bf;
      font-family: Arial, sans-serif;
    }

    main {
      min-height: 100%;
      display: grid;
      place-items: center;
      padding: 16px;
      box-sizing: border-box;
    }

    .viewer {
      width: min(715px, 100%);
    }

    ruffle-player, object, embed {
      display: block;
      width: 100%;
      aspect-ratio: 715 / 455;
      background: #000;
    }

    .status {
      min-height: 320px;
      display: grid;
      align-content: center;
      gap: 12px;
      padding: 24px;
      box-sizing: border-box;
      background: #140f0f;
      border: 1px solid #5a4330;
      color: #ffe4a3;
    }

    .status strong,
    .status span,
    .status small {
      display: block;
      white-space: pre-wrap;
    }

    .status small {
      color: #d8c28e;
      font-size: 12px;
    }

    .status ul {
      display: grid;
      gap: 8px;
      margin: 0;
      padding-left: 18px;
    }

    .status li {
      overflow-wrap: anywhere;
    }

    .status a {
      color: #9ac7ff;
    }

    .status code {
      display: block;
      margin-top: 2px;
      color: #d8c28e;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <main>
    <section class="viewer" aria-label="AQWorlds character viewer">
      ${playerMarkup}
    </section>
  </main>
  <script>
    window.RufflePlayer = window.RufflePlayer || {};
    const aqwAssetBase = window.location.origin + "${assetBaseUrl}";
    window.RufflePlayer.config = {
      autoplay: "on",
      unmuteOverlay: "hidden",
      backgroundColor: "#000000",
      base: aqwAssetBase,
      urlRewriteRules: [
        [/^https?:\\/\\/game\\.aq\\.com\\/game\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"],
        [/^https?:\\/\\/game\\.aq\\.com\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"],
        [/^https?:\\/\\/localhost\\/game\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"],
        [/^https?:\\/\\/localhost:3000\\/game\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"],
        [/^\\/game\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"]
      ]
    };
  </script>
  <script src="https://unpkg.com/@ruffle-rs/ruffle"></script>
</body>
</html>`;
}

function renderCleanCompositorPage(character, reqUrl) {
  const params = new URLSearchParams();
  const includePet = reqUrl.searchParams.get("pet") === "1";
  const includeGround = reqUrl.searchParams.get("ground") === "1";
  const previewBackground = reqUrl.searchParams.get("bg") || "checker";

  params.set("pet", includePet ? "1" : "0");
  params.set("ground", includeGround ? "1" : "0");
  params.set("source", reqUrl.searchParams.get("source") || "custom");

  if (reqUrl.searchParams.get("refresh") === "1") {
    params.set("refresh", "1");
  }

  params.set("t", String(Date.now()));

  const imageUrl = `/api/character/${encodeURIComponent(character.name)}/png?${params}`;
  const usesCheckerBackground = previewBackground === "checker";
  const pageBackground = previewBackground === "transparent"
    ? "transparent"
    : previewBackground === "white"
    ? "#fff"
    : previewBackground === "black"
      ? "#000"
      : `
        linear-gradient(45deg, #d8d8d8 25%, transparent 25%),
        linear-gradient(-45deg, #d8d8d8 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #d8d8d8 75%),
        linear-gradient(-45deg, transparent 75%, #d8d8d8 75%),
        #f4f4f4
      `;
  const pageBackgroundSize = usesCheckerBackground
    ? "32px 32px"
    : "auto";
  const pageBackgroundPosition = usesCheckerBackground
    ? "0 0, 0 16px, 16px -16px, -16px 0"
    : "0 0";
  const loadingErrorText = JSON.stringify(`Could not load ${character.name}`);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(character.name)} - AQWorlds Character PNG</title>
  <style>
    html, body {
      min-height: 100%;
      margin: 0;
      background: ${pageBackground};
      background-size: ${pageBackgroundSize};
      background-position: ${pageBackgroundPosition};
    }

    body {
      display: grid;
      place-items: center;
    }

    .loading {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      color: #f7f7f7;
      font: 700 18px/1.4 Arial, sans-serif;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
      transition: opacity 180ms ease, visibility 180ms ease;
      pointer-events: none;
    }

    .loading-text {
      display: inline-flex;
      align-items: baseline;
      gap: 1px;
      padding: 10px 12px;
      background: rgba(0, 0, 0, 0.62);
      border-radius: 6px;
    }

    .loading-text span {
      animation: loadingDot 900ms infinite ease-in-out;
    }

    .loading-text span:nth-child(2) {
      animation-delay: 120ms;
    }

    .loading-text span:nth-child(3) {
      animation-delay: 240ms;
    }

    .is-loaded .loading {
      opacity: 0;
      visibility: hidden;
    }

    .loading.is-error .loading-text span {
      display: none;
    }

    @keyframes loadingDot {
      0%, 80%, 100% {
        opacity: 0.25;
        transform: translateY(0);
      }

      40% {
        opacity: 1;
        transform: translateY(-3px);
      }
    }

    img {
      display: block;
      max-width: min(100vw, 560px);
      max-height: 100vh;
      object-fit: contain;
      image-rendering: auto;
    }
  </style>
</head>
<body>
  <div class="loading" id="loading">
    <div class="loading-text" id="loadingText">Loading ${escapeHtml(character.name)}<span>.</span><span>.</span><span>.</span></div>
  </div>
  <img id="characterImage" src="${escapeHtml(imageUrl)}" alt="">
  <script>
    const image = document.getElementById("characterImage");
    const loading = document.getElementById("loading");
    const loadingText = document.getElementById("loadingText");

    function markLoaded() {
      document.body.classList.add("is-loaded");
    }

    if (image.complete && image.naturalWidth > 0) {
      markLoaded();
    } else {
      image.addEventListener("load", markLoaded, { once: true });
    }

    image.addEventListener("error", () => {
      loading.classList.add("is-error");
      loadingText.textContent = ${loadingErrorText};
    }, { once: true });
  </script>
</body>
</html>`;
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function getRouteName(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rawName = pathname.slice(prefix.length);
  return rawName ? decodeURIComponent(rawName) : null;
}

function getRequestIp(req) {
  const forwardedFor = Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"];
  const realIp = Array.isArray(req.headers["x-real-ip"])
    ? req.headers["x-real-ip"][0]
    : req.headers["x-real-ip"];
  const cfIp = Array.isArray(req.headers["cf-connecting-ip"])
    ? req.headers["cf-connecting-ip"][0]
    : req.headers["cf-connecting-ip"];
  const rawIp = (forwardedFor?.split(",")[0] || cfIp || realIp || req.socket.remoteAddress || "unknown").trim();

  return rawIp.replace(/^::ffff:/, "").replace(/^::1$/, "127.0.0.1");
}

function formatLogDateTime(date) {
  return {
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: LOG_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(date),
    time: new Intl.DateTimeFormat("en-US", {
      timeZone: LOG_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    }).format(date)
  };
}

function logCharacterRequest(req, route, username) {
  const loggedAt = new Date();
  const { date, time } = formatLogDateTime(loggedAt);
  const entry = {
    ip: getRequestIp(req),
    username: String(username || ""),
    route,
    path: req.url || "",
    date,
    time
  };
  const line = [
    `Username: ${entry.username}`,
    `IP Address: ${entry.ip}`,
    `Time: ${entry.time}`,
    `Date: ${entry.date}`,
    `Route: ${entry.route}`,
    `Path: ${entry.path}`,
    ""
  ].join("\n");

  console.log(`[character-request] Username: ${entry.username} | IP Address: ${entry.ip} | Time: ${entry.time} | Date: ${entry.date}`);

  if (!REQUEST_FILE_LOG) return;

  mkdir(path.dirname(REQUEST_LOG_PATH), { recursive: true })
    .then(() => appendFile(REQUEST_LOG_PATH, `${line}\n`))
    .catch((error) => {
      console.warn(`Failed to write request log: ${error.message}`);
    });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      send(res, 204, "text/plain; charset=utf-8", "");
      return;
    }

    if (req.method !== "GET") {
      send(res, 405, "application/json; charset=utf-8", JSON.stringify({ error: "Method not allowed." }));
      return;
    }

    if (url.pathname.startsWith(LOCAL_CACHE_PREFIX)) {
      await serveCachedGameFile(url, res);
      return;
    }

    if (url.pathname.startsWith(LOCAL_GAME_FILES_PREFIX)) {
      await proxyGameFile(url, res);
      return;
    }

    if (url.pathname === "/api/custom-character.swf") {
      const customViewerPath = await ensureCustomViewerSwf();
      const info = await stat(customViewerPath);

      res.writeHead(200, {
        "Content-Type": "application/x-shockwave-flash",
        "Content-Length": info.size,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*"
      });
      createReadStream(customViewerPath).pipe(res);
      return;
    }

    if (url.pathname.startsWith(LOCAL_RUFFLE_PREFIX)) {
      await serveRuffleFile(url, res);
      return;
    }

    if (url.pathname === "/health") {
      send(res, 200, "application/json; charset=utf-8", JSON.stringify({
        status: "ok",
        service: "aqworlds-character-api",
        time: new Date().toISOString()
      }));
      return;
    }

    if (url.pathname === "/") {
      send(res, 200, "text/plain; charset=utf-8", [
        "AQWorlds Character API",
        "",
        "GET /health",
        "GET /api/character/:name",
        "GET /api/character/:name/compositor",
        "GET /api/character/:name/compiler",
        "GET /api/character/:name/png",
        "GET /api/custom-character.swf",
        "",
        `AQW SWF throttle: ${AQW_FETCH_LIMIT} file(s) every ${AQW_FETCH_WINDOW_MS / 1000}s`,
        "Configure with AQW_FETCH_LIMIT and AQW_FETCH_WINDOW_MS.",
        "",
        "GET /character/:name",
        "GET /character/:name?swf=1",
        "GET /compile/:name",
        "GET /compositor/:name"
      ].join("\n"));
      return;
    }

    const apiName = getRouteName(url.pathname, "/api/character/");
    if (apiName) {
      const compositorApiName = apiName.endsWith("/compositor") ? apiName.slice(0, -"/compositor".length) : null;
      const compilerApiName = apiName.endsWith("/compiler") ? apiName.slice(0, -"/compiler".length) : null;
      const pngName = apiName.endsWith("/png") ? apiName.slice(0, -"/png".length) : null;
      const legacyGifName = apiName.endsWith("/gif") ? apiName.slice(0, -"/gif".length) : null;
      const imageName = pngName || legacyGifName;

      if (compositorApiName || compilerApiName) {
        logCharacterRequest(req, compositorApiName ? "api-compositor" : "api-compiler", compositorApiName || compilerApiName);
        const includePet = url.searchParams.get("pet") === "1";
        const includeGround = url.searchParams.get("ground") === "1";
        const character = await fetchCharacter(compositorApiName || compilerApiName);
        const itemAssets = await prepareItemAssets(character);
        const manifest = await buildCompositorManifest(
          character,
          itemAssets,
          pickCompositorSlots(character.flashVars, { includePet, includeGround }),
          (gameFilePath) => cacheFilePath(itemAssets.cacheKey, gameFilePath)
        );

        send(res, 200, "application/json; charset=utf-8", JSON.stringify(manifest, null, 2));
        return;
      }

      if (imageName) {
        logCharacterRequest(req, legacyGifName ? "api-gif" : "api-png", imageName);
        const includePet = url.searchParams.get("pet") === "1";
        const includeGround = url.searchParams.get("ground") === "1";
        const character = await fetchCharacter(imageName);
        character.assets = await prepareCharacterAssets(character, { includePet, includeGround });

        const missingAssets = character.assets.files.filter((asset) => !asset.available);
        if (missingAssets.length > 0) {
          send(res, 424, "application/json; charset=utf-8", JSON.stringify({
            error: "Cannot render PNG until all AQWorlds SWFs are cached.",
            missingAssets
          }, null, 2));
          return;
        }

        const imagePath = await renderCharacterImage(imageName, url, character);
        const info = await stat(imagePath);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": info.size,
          "Cache-Control": url.searchParams.get("refresh") === "1"
            ? "no-store"
            : "public, max-age=3600",
          "Access-Control-Allow-Origin": "*"
        });
        createReadStream(imagePath).pipe(res);
        return;
      }

      logCharacterRequest(req, "api-json", apiName);
      const character = await fetchCharacter(apiName);
      character.assets = await prepareCharacterAssets(character, {
        includePet: url.searchParams.get("pet") !== "0",
        includeGround: url.searchParams.get("ground") === "1"
      });
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(character, null, 2));
      return;
    }

    const compileName = getRouteName(url.pathname, "/compile/");
    if (compileName) {
      logCharacterRequest(req, "compile-page", compileName);
      const character = await fetchCharacter(compileName);
      send(res, 200, "text/html; charset=utf-8", renderCleanCompositorPage(character, url));
      return;
    }

    const compositorName = getRouteName(url.pathname, "/compositor/");
    if (compositorName) {
      logCharacterRequest(req, "compositor-page", compositorName);
      const character = await fetchCharacter(compositorName);
      send(res, 200, "text/html; charset=utf-8", renderCleanCompositorPage(character, url));
      return;
    }

    const viewerName = getRouteName(url.pathname, "/character/");
    if (viewerName) {
      logCharacterRequest(req, url.searchParams.get("swf") === "1" ? "character-swf-page" : "character-page", viewerName);
      const character = await fetchCharacter(viewerName);

      if (url.searchParams.get("swf") === "1") {
        character.assets = await prepareCharacterAssets(character, {
          includePet: url.searchParams.get("pet") === "1",
          includeGround: url.searchParams.get("ground") === "1"
        });
        send(res, 200, "text/html; charset=utf-8", renderCharacterOnlyPage(character));
        return;
      }

      send(res, 200, "text/html; charset=utf-8", renderCleanCompositorPage(character, url));
      return;
    }

    send(res, 404, "application/json; charset=utf-8", JSON.stringify({ error: "Route not found." }));
  } catch (error) {
    const status = error.status || 500;
    send(res, status, "application/json; charset=utf-8", JSON.stringify({
      error: error.message || "Unexpected server error."
    }));
  }
});

server.listen(DEFAULT_PORT, () => {
  console.log(`AQWorlds Character API listening on http://localhost:${DEFAULT_PORT}`);
});
