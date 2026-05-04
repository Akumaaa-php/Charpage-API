import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const [, , characterName, outputPath, origin = "http://localhost:3000", mode = "viewer", petMode = "nopet", sourceMode = "template", characterJsonPath = ""] = process.argv;
const itemModes = new Set(petMode.split(",").map((value) => value.trim()).filter(Boolean));
const includePet = itemModes.has("pet");
const includeGround = itemModes.has("ground");
const useCustomViewer = sourceMode === "custom";
const stageWidth = useCustomViewer ? 720 : 715;
const stageHeight = useCustomViewer ? 1119 : 455;
const useTemplateScale = sourceMode === "template" || sourceMode === "profile" || useCustomViewer;
const renderScale = useTemplateScale ? 3 : 1;
const outputFormat = outputPath.toLowerCase().endsWith(".png") ? "png" : "gif";
const customNetworkIdleTimeoutMs = Math.max(500, Number(process.env.RENDER_CUSTOM_NETWORK_IDLE_MS || 1200));
const customSettleMs = Math.max(1000, Number(process.env.RENDER_CUSTOM_SETTLE_MS || 1800));
const defaultNetworkIdleTimeoutMs = Math.max(1000, Number(process.env.RENDER_NETWORK_IDLE_MS || 12000));
const defaultSettleMs = Math.max(1000, Number(process.env.RENDER_SETTLE_MS || 3200));

if (!characterName || !outputPath) {
  console.error("Usage: node src/render-gif.mjs <characterName> <outputPath> [origin] [mode] [pet|nopet] [profile|template|viewer]");
  process.exit(2);
}

const require = createRequire(import.meta.url);

async function loadCharacter() {
  if (characterJsonPath) {
    return JSON.parse(await readFile(characterJsonPath, "utf8"));
  }

  return (await (await fetch(`${origin}/api/character/${encodeURIComponent(characterName)}?pet=${includePet ? "1" : "0"}&ground=${includeGround ? "1" : "0"}`)).json());
}

function optionalRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

const playwright =
  optionalRequire("playwright") ||
  optionalRequire("C:/Users/Yska/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

if (!playwright) {
  throw new Error("Playwright is required. Run npm install, or set NODE_PATH to a Playwright installation.");
}

const { chromium } = playwright;
const localChromeFallback = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const localPythonFallback = "C:/Users/Yska/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe";
const CHROME_EXE =
  process.env.CHROME_EXE ||
  (existsSync(localChromeFallback) ? localChromeFallback : undefined);
const PYTHON_EXE =
  process.env.PYTHON_EXE ||
  process.env.PYTHON ||
  (existsSync(localPythonFallback) ? localPythonFallback : process.platform === "win32" ? "python" : "python3");
const frameDir = path.join(path.dirname(outputPath), `${path.parse(outputPath).name}-frames`);

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

      reject(new Error(stderr || stdout || `Process exited with code ${code}`));
    });
  });
}

function assetBaseFor(character) {
  return `${origin}${character.assets.baseUrl}`;
}

function flashVarsFor(character, blank = false, cleanText = false) {
  const vars = { ...character.flashVars };

  if (blank) {
    for (const key of Object.keys(vars)) {
      if (key.endsWith("File")) vars[key] = "none";
      if (key.endsWith("Link")) vars[key] = "none";
    }
  }

  if (cleanText) {
    for (const key of Object.keys(vars)) {
      if (key.endsWith("Name")) vars[key] = "";
    }

    vars.strName = "";
    vars.intLevel = "";
    vars.level = "";
    vars.guild = "";
    vars.strFaction = "";
  }

  if (!includePet) {
    vars.strPetFile = "none";
    vars.strPetLink = "none";
    vars.strPetName = "";
    vars.strCustPetFile = "none";
    vars.strCustPetLink = "none";
    vars.strCustPetName = "";
  }

  if (!includeGround) {
    vars.strMiscFile = "none";
    vars.strMiscLink = "none";
    vars.strMiscName = "";
    vars.strCustMiscFile = "none";
    vars.strCustMiscLink = "none";
    vars.strCustMiscName = "";
  }

  return new URLSearchParams(vars).toString();
}

function renderHtml(character, blank = false, cleanText = false) {
  const swfUrl = useCustomViewer
    ? `${origin}/api/custom-character.swf`
    : `${origin}${character.assets.main.localUrl}`;
  const flashVars = flashVarsFor(character, blank, cleanText);
  const base = assetBaseFor(character);
  const background = useCustomViewer ? "transparent" : "#000";
  const wmode = useCustomViewer ? "transparent" : "opaque";
  const ruffleBackground = useCustomViewer ? "null" : "\"#000000\"";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body {
      margin: 0;
      width: ${stageWidth}px;
      height: ${stageHeight}px;
      overflow: hidden;
      background: ${background};
    }

    object, embed, ruffle-player {
      display: block;
      width: ${stageWidth}px;
      height: ${stageHeight}px;
      background: transparent;
    }
  </style>
</head>
<body>
  <object data="${swfUrl}" type="application/x-shockwave-flash">
    <param name="movie" value="${swfUrl}">
    <param name="FlashVars" value="${flashVars}">
    <param name="quality" value="high">
    <param name="loop" value="true">
    <param name="scale" value="showall">
    <param name="allowScriptAccess" value="always">
    <param name="menu" value="true">
    <param name="wmode" value="${wmode}">
    <embed src="${swfUrl}" flashvars="${flashVars}" wmode="${wmode}" allowScriptAccess="always" loop="true" quality="high" type="application/x-shockwave-flash" menu="true" scale="showAll"></embed>
  </object>
  <script>
    window.RufflePlayer = window.RufflePlayer || {};
    const aqwAssetBase = "${base}";
    window.RufflePlayer.config = {
      autoplay: "on",
      unmuteOverlay: "hidden",
      backgroundColor: ${ruffleBackground},
      base: aqwAssetBase,
      urlRewriteRules: [
        [/^https?:\\/\\/game\\.aq\\.com\\/game\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"],
        [/^https?:\\/\\/game\\.aq\\.com\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"],
        [/^https?:\\/\\/localhost(?::\\d+)?\\/game\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"],
        [/^https?:\\/\\/127\\.0\\.0\\.1(?::\\d+)?\\/game\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"],
        [/^https?:\\/\\/[^\\/]+\\/game\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"],
        [/^\\/game\\/gamefiles\\/(.*)$/i, aqwAssetBase + "$1"]
      ]
    };
  </script>
  <script src="${origin}/vendor/ruffle/ruffle.js"></script>
</body>
</html>`;
}

async function captureFrames(page, framePaths, blank = false, cleanText = false) {
  await page.setContent(renderHtml(character, blank, cleanText), { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: useCustomViewer ? customNetworkIdleTimeoutMs : defaultNetworkIdleTimeoutMs }).catch(() => {});

  if (blank) {
    await page.waitForTimeout(900);
  } else {
    await page.waitForFunction(() => document.querySelector("ruffle-player"), null, { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(useCustomViewer ? customSettleMs : defaultSettleMs);
  }

  if (blank) {
    await page.screenshot({
      path: framePaths[0],
      clip: { x: 0, y: 0, width: stageWidth, height: stageHeight },
      omitBackground: useCustomViewer
    });
    return;
  }

  for (let index = 0; index < framePaths.length; index += 1) {
    await page.screenshot({
      path: framePaths[index],
      clip: { x: 0, y: 0, width: stageWidth, height: stageHeight },
      omitBackground: useCustomViewer
    });
    await page.waitForTimeout(140);
  }
}

async function encodeGif(framePaths, backgroundPath, cleanOutput) {
  const script = `
from PIL import Image
from PIL import ImageChops, ImageFilter
import sys

out = sys.argv[1]
background_path = sys.argv[2]
clean = sys.argv[3] == "1"
layout_mode = sys.argv[4]
template_output = layout_mode in ("template", "profile")
profile_output = layout_mode == "profile"
custom_output = layout_mode == "custom"
frame_paths = sys.argv[5:]
frames = []

if clean and not custom_output:
    bg = Image.open(background_path).convert("RGBA")
    width, height = bg.size
    processed = []

    def sizable_components(mask):
        source = mask.load()
        output = Image.new("L", mask.size, 0)
        output_px = output.load()
        seen = set()
        w, h = mask.size

        for y in range(h):
            for x in range(w):
                if not source[x, y] or (x, y) in seen:
                    continue

                queue = [(x, y)]
                seen.add((x, y))
                points = []
                min_x = max_x = x
                min_y = max_y = y

                for cx, cy in queue:
                    points.append((cx, cy))
                    min_x = min(min_x, cx)
                    max_x = max(max_x, cx)
                    min_y = min(min_y, cy)
                    max_y = max(max_y, cy)

                    for ny in range(cy - 1, cy + 2):
                        for nx in range(cx - 1, cx + 2):
                            if nx < 0 or ny < 0 or nx >= w or ny >= h or (nx, ny) in seen:
                                continue

                            if source[nx, ny]:
                                seen.add((nx, ny))
                                queue.append((nx, ny))

                component_width = max_x - min_x + 1
                component_height = max_y - min_y + 1
                if len(points) >= 80 or (component_width >= 8 and component_height >= 8):
                    for px, py in points:
                        output_px[px, py] = 255

        return output

    def remove_viewer_ui_components(mask):
        source = mask.load()
        output = mask.copy()
        output_px = output.load()
        seen = set()
        w, h = mask.size
        scale_x = w / 715
        scale_y = h / 455
        # Regions owned by characterB.swf's equipment labels/buttons. A
        # connected component must be fully inside one of these boxes before
        # it is removed, so wide gear such as Selena's sword is preserved.
        raw_ui_regions = [
            (0, 112, 130, 335),   # Level/equipment icon and None list
            (0, 330, 160, 380),   # Profile Pic button
            (445, 330, 575, 380)  # Cosmetics button
        ]
        ui_regions = [
            (
                round(left * scale_x),
                round(top * scale_y),
                round(right * scale_x),
                round(bottom * scale_y)
            )
            for left, top, right, bottom in raw_ui_regions
        ]

        def inside_ui_region(bounds):
            min_x, min_y, max_x, max_y = bounds
            return any(
                min_x >= left and min_y >= top and max_x <= right and max_y <= bottom
                for left, top, right, bottom in ui_regions
            )

        for y in range(h):
            for x in range(w):
                if not source[x, y] or (x, y) in seen:
                    continue

                queue = [(x, y)]
                seen.add((x, y))
                points = []
                min_x = max_x = x
                min_y = max_y = y

                for cx, cy in queue:
                    points.append((cx, cy))
                    min_x = min(min_x, cx)
                    max_x = max(max_x, cx)
                    min_y = min(min_y, cy)
                    max_y = max(max_y, cy)

                    for ny in range(cy - 1, cy + 2):
                        for nx in range(cx - 1, cx + 2):
                            if nx < 0 or ny < 0 or nx >= w or ny >= h or (nx, ny) in seen:
                                continue

                            if source[nx, ny]:
                                seen.add((nx, ny))
                                queue.append((nx, ny))

                if inside_ui_region((min_x, min_y, max_x + 1, max_y + 1)):
                    for px, py in points:
                        output_px[px, py] = 0

        return output

    def remove_viewer_text_pixels(mask, frame):
        mask_px = mask.load()
        frame_px = frame.load()
        text_mask = Image.new("L", mask.size, 0)
        text_px = text_mask.load()
        scale_x = width / 715
        scale_y = height / 455
        raw_ui_regions = [
            (0, 98, 165, 350),
            (0, 330, 175, 385),
            (440, 330, 590, 385)
        ]
        ui_regions = [
            (
                max(0, round(left * scale_x)),
                max(0, round(top * scale_y)),
                min(width, round(right * scale_x)),
                min(height, round(bottom * scale_y))
            )
            for left, top, right, bottom in raw_ui_regions
        ]

        for left, top, right, bottom in ui_regions:
            for y in range(top, bottom):
                for x in range(left, right):
                    if not mask_px[x, y]:
                        continue

                    r, g, b, a = frame_px[x, y]
                    bright_text = r > 180 and g > 170 and b > 145
                    yellow_text = r > 170 and g > 105 and b < 95

                    if bright_text or yellow_text:
                        text_px[x, y] = 255

        grow = max(5, round(scale_x) * 2 + 5)
        if grow % 2 == 0:
            grow += 1

        text_mask = text_mask.filter(ImageFilter.MaxFilter(grow))
        return ImageChops.subtract(mask, text_mask)

    def remove_floor_shadow(mask, frame):
        mask_px = mask.load()
        frame_px = frame.load()
        bg_px = bg.load()

        for y in range(height):
            for x in range(width):
                if not mask_px[x, y]:
                    continue

                bg_r, bg_g, bg_b, _ = bg_px[x, y]
                fr_r, fr_g, fr_b, _ = frame_px[x, y]
                bg_max = max(bg_r, bg_g, bg_b)
                fg_max = max(fr_r, fr_g, fr_b)
                fg_min = min(fr_r, fr_g, fr_b)

                if bg_max < 95:
                    continue

                ratios = [
                    fr_r / (bg_r + 1),
                    fr_g / (bg_g + 1),
                    fr_b / (bg_b + 1)
                ]
                average_ratio = sum(ratios) / 3
                ratio_spread = max(ratios) - min(ratios)
                saturation = fg_max - fg_min

                # The viewer adds a translucent floor/shadow that is mostly a
                # uniformly darkened copy of the background. Keep crisp dark
                # outlines and bright item effects, but drop that tinted floor.
                if (
                    0.16 < average_ratio < 0.72 and
                    ratio_spread < 0.10 and
                    35 < fg_max < 150 and
                    saturation < 48
                ):
                    mask_px[x, y] = 0

        return mask

    def remove_tan_floor_pixels(frame):
        frame_px = frame.load()
        start_y = int(height * 0.5)

        for y in range(start_y, height):
            for x in range(width):
                r, g, b, a = frame_px[x, y]

                if not a:
                    continue

                if (
                    r > 80 and
                    r >= g - 8 and
                    g >= b + 8 and
                    (r - b) < 125 and
                    (max(r, g, b) - min(r, g, b)) < 92 and
                    b < 175
                ):
                    frame_px[x, y] = (r, g, b, 0)

        return frame

    for path in frame_paths:
        frame = Image.open(path).convert("RGBA")
        diff = ImageChops.difference(frame, bg).convert("RGB")
        mask = Image.new("L", frame.size, 0)
        diff_px = diff.load()
        mask_px = mask.load()

        for y in range(height):
            for x in range(width):
                r, g, b = diff_px[x, y]
                distance = r + g + b
                if distance > 38:
                    mask_px[x, y] = 255

        mask = sizable_components(mask)
        mask = remove_viewer_ui_components(mask)
        mask = remove_viewer_text_pixels(mask, frame)
        mask = remove_floor_shadow(mask, frame)
        mask = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
        mask = mask.filter(ImageFilter.GaussianBlur(0.35)).point(lambda value: 255 if value > 20 else 0)
        frame.putalpha(mask)
        frame = remove_tan_floor_pixels(frame)
        processed.append(frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT))

    bbox = None
    for frame in processed:
        current = frame.getbbox()
        if not current:
            continue
        if bbox is None:
            bbox = current
        else:
            bbox = (
                min(bbox[0], current[0]),
                min(bbox[1], current[1]),
                max(bbox[2], current[2]),
                max(bbox[3], current[3])
            )

    if bbox is None:
        raise SystemExit("Transparent compositor produced no visible pixels")

    pad = max(24, round(processed[0].width / 30))
    bbox = (
        max(0, bbox[0] - pad),
        max(0, bbox[1] - pad),
        min(processed[0].width, bbox[2] + pad),
        min(processed[0].height, bbox[3] + pad)
    )

    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    canvas_width = width + pad * 2
    canvas_height = height + round(pad * 1.4)
    offset = ((canvas_width - width) // 2, (canvas_height - height) // 2)

    def repair_transparent_holes(canvas, bounds=None, close_size=None, max_hole_area=None, max_hole_span=None):
        canvas_px = canvas.load()
        alpha = canvas.getchannel("A")
        image_width, image_height = canvas.size
        if bounds is None:
            left, top, right, bottom = 0, 0, image_width, image_height
        else:
            left, top, right, bottom = bounds
            left = max(0, min(image_width, left))
            top = max(0, min(image_height, top))
            right = max(left, min(image_width, right))
            bottom = max(top, min(image_height, bottom))

        region = Image.new("L", canvas.size, 0)
        region_px = region.load()

        for y in range(top, bottom):
            for x in range(left, right):
                region_px[x, y] = 255

        if close_size is None:
            close_size = max(17, round(image_width * 0.018))
        if close_size % 2 == 0:
            close_size += 1

        closed_alpha = alpha.filter(ImageFilter.MaxFilter(close_size)).filter(ImageFilter.MinFilter(close_size))
        candidate_mask = ImageChops.multiply(ImageChops.subtract(closed_alpha, alpha), region)
        candidate_px = candidate_mask.load()
        repair_mask = Image.new("L", canvas.size, 0)
        repair_px = repair_mask.load()

        if max_hole_area is None:
            max_hole_area = max(160, round(image_width * image_height * 0.0035))

        if max_hole_span is None:
            max_hole_span = max(18, round(min(image_width, image_height) * 0.12))

        seen = set()

        for y in range(top, bottom):
            for x in range(left, right):
                if not candidate_px[x, y] or (x, y) in seen:
                    continue

                queue = [(x, y)]
                seen.add((x, y))
                points = []
                min_x = max_x = x
                min_y = max_y = y

                for cx, cy in queue:
                    points.append((cx, cy))
                    min_x = min(min_x, cx)
                    max_x = max(max_x, cx)
                    min_y = min(min_y, cy)
                    max_y = max(max_y, cy)

                    for ny in range(cy - 1, cy + 2):
                        for nx in range(cx - 1, cx + 2):
                            if nx < left or ny < top or nx >= right or ny >= bottom or (nx, ny) in seen:
                                continue

                            if candidate_px[nx, ny]:
                                seen.add((nx, ny))
                                queue.append((nx, ny))

                span_x = max_x - min_x + 1
                span_y = max_y - min_y + 1

                if len(points) <= max_hole_area and max(span_x, span_y) <= max_hole_span:
                    for px, py in points:
                        repair_px[px, py] = 255

        def nearby_dark_color(cx, cy):
            for radius in (4, 8, 14, 22):
                colors = []
                min_x = max(0, cx - radius)
                max_x = min(image_width - 1, cx + radius)
                min_y = max(0, cy - radius)
                max_y = min(image_height - 1, cy + radius)

                for sy in range(min_y, max_y + 1):
                    for sx in range(min_x, max_x + 1):
                        sr, sg, sb, sa = canvas_px[sx, sy]

                        color_max = max(sr, sg, sb)
                        color_min = min(sr, sg, sb)
                        green_background = sg > sr + 14 and sg > sb + 14
                        tan_background = sr > sg - 6 and sg > sb + 10 and sr - sb > 34

                        if (
                            sa > 180 and
                            color_max < 105 and
                            color_max - color_min < 58 and
                            not green_background and
                            not tan_background
                        ):
                            colors.append((sr, sg, sb))

                if colors:
                    colors.sort(key=lambda color: color[0] + color[1] + color[2])
                    return colors[len(colors) // 2]

            return (8, 6, 6)

        for y in range(top, bottom):
            for x in range(left, right):
                if repair_px[x, y]:
                    r, g, b = nearby_dark_color(x, y)
                    canvas_px[x, y] = (r, g, b, 255)

        return canvas

    def clean_edge_text(canvas):
        canvas_px = canvas.load()
        text_mask = Image.new("L", canvas.size, 0)
        text_px = text_mask.load()
        left = round(canvas_width * 0.76)
        top = round(canvas_height * 0.60)
        right = round(canvas_width * 0.96)
        bottom = round(canvas_height * 0.84)

        for y in range(top, bottom):
            for x in range(left, right):
                r, g, b, a = canvas_px[x, y]

                if not a:
                    continue

                near_white = r > 170 and g > 170 and b > 155 and (max(r, g, b) - min(r, g, b)) < 95

                if near_white:
                    text_px[x, y] = 255

        repair_mask = text_mask.filter(ImageFilter.MaxFilter(9))
        repair_px = repair_mask.load()

        for y in range(top, bottom):
            for x in range(left, right):
                if repair_px[x, y]:
                    canvas_px[x, y] = (8, 6, 6, 255)

        return repair_transparent_holes(canvas, (left, top, right, bottom), max(19, round(canvas_width * 0.018)))

    def remove_profile_background_artifacts(image):
        alpha = image.getchannel("A")
        source = alpha.load()
        remove_mask = Image.new("L", image.size, 0)
        remove_px = remove_mask.load()
        image_width, image_height = image.size
        seen = set()

        for y in range(image_height):
            for x in range(image_width):
                if not source[x, y] or (x, y) in seen:
                    continue

                queue = [(x, y)]
                seen.add((x, y))
                points = []
                min_x = max_x = x
                min_y = max_y = y

                for cx, cy in queue:
                    points.append((cx, cy))
                    min_x = min(min_x, cx)
                    max_x = max(max_x, cx)
                    min_y = min(min_y, cy)
                    max_y = max(max_y, cy)

                    for ny in range(cy - 1, cy + 2):
                        for nx in range(cx - 1, cx + 2):
                            if nx < 0 or ny < 0 or nx >= image_width or ny >= image_height or (nx, ny) in seen:
                                continue

                            if source[nx, ny]:
                                seen.add((nx, ny))
                                queue.append((nx, ny))

                component_width = max_x - min_x + 1
                component_height = max_y - min_y + 1
                touches_top_or_bottom = min_y <= 2 or max_y >= image_height - 3
                top_ui_strip = min_y < image_height * 0.14 and component_width > image_width * 0.35 and component_height < image_height * 0.08
                bottom_ui_strip = max_y > image_height * 0.90 and component_width > image_width * 0.28 and component_height < image_height * 0.11
                edge_hairline = touches_top_or_bottom and component_width > image_width * 0.18 and component_height <= 8
                tiny_edge_noise = len(points) < 90 and (
                    min_y < image_height * 0.08 or
                    max_y > image_height * 0.92 or
                    min_x < 4 or
                    max_x > image_width - 5
                )

                if top_ui_strip or bottom_ui_strip or edge_hairline or tiny_edge_noise:
                    for px, py in points:
                        remove_px[px, py] = 255

        if remove_mask.getbbox():
            alpha = ImageChops.subtract(alpha, remove_mask)
            image.putalpha(alpha)

        return image

    def fill_enclosed_character_holes(image):
        image_px = image.load()
        alpha = image.getchannel("A")
        alpha_px = alpha.load()
        image_width, image_height = image.size
        fill_mask = Image.new("L", image.size, 0)
        fill_px = fill_mask.load()
        seen = set()

        def nearby_fill_color(cx, cy):
            for radius in (4, 8, 14, 22):
                colors = []
                for sy in range(max(0, cy - radius), min(image_height, cy + radius + 1)):
                    for sx in range(max(0, cx - radius), min(image_width, cx + radius + 1)):
                        sr, sg, sb, sa = image_px[sx, sy]

                        if sa < 180:
                            continue

                        # Avoid borrowing stage greens/browns for repaired character holes.
                        if (
                            (sg > 16 and sg >= sr + 4 and sg >= sb + 10 and sr < 70 and sb < 50) or
                            (sr < 75 and sg < 65 and sb < 45 and sr >= sg + 3 and sg >= sb + 3 and sr - sb > 8)
                        ):
                            continue

                        if max(sr, sg, sb) < 150:
                            colors.append((sr, sg, sb))

                if colors:
                    colors.sort(key=lambda color: color[0] + color[1] + color[2])
                    return colors[len(colors) // 2]

            return (12, 12, 12)

        for y in range(image_height):
            for x in range(image_width):
                if alpha_px[x, y] or (x, y) in seen:
                    continue

                queue = [(x, y)]
                seen.add((x, y))
                points = []
                min_x = max_x = x
                min_y = max_y = y
                touches_edge = x == 0 or y == 0 or x == image_width - 1 or y == image_height - 1

                for cx, cy in queue:
                    points.append((cx, cy))
                    min_x = min(min_x, cx)
                    max_x = max(max_x, cx)
                    min_y = min(min_y, cy)
                    max_y = max(max_y, cy)

                    if cx == 0 or cy == 0 or cx == image_width - 1 or cy == image_height - 1:
                        touches_edge = True

                    for ny in range(cy - 1, cy + 2):
                        for nx in range(cx - 1, cx + 2):
                            if nx < 0 or ny < 0 or nx >= image_width or ny >= image_height or (nx, ny) in seen:
                                continue

                            if not alpha_px[nx, ny]:
                                seen.add((nx, ny))
                                queue.append((nx, ny))

                span_x = max_x - min_x + 1
                span_y = max_y - min_y + 1
                small_hole = len(points) <= image_width * image_height * 0.003 and max(span_x, span_y) <= 58

                if not touches_edge and small_hole:
                    for px, py in points:
                        fill_px[px, py] = 255

        if fill_mask.getbbox():
            fill_px = fill_mask.load()
            for y in range(image_height):
                for x in range(image_width):
                    if fill_px[x, y]:
                        r, g, b = nearby_fill_color(x, y)
                        image_px[x, y] = (r, g, b, 255)

        return image

    def repair_small_white_fragments(image):
        image_px = image.load()
        image_width, image_height = image.size
        profile_echo_regions = [
            (
                round(image_width * 0.58),
                round(image_height * 0.195),
                round(image_width * 0.635),
                round(image_height * 0.235)
            ),
            (
                round(image_width * 0.145),
                round(image_height * 0.495),
                round(image_width * 0.19),
                round(image_height * 0.522)
            ),
            (
                round(image_width * 0.082),
                round(image_height * 0.758),
                round(image_width * 0.12),
                round(image_height * 0.782)
            )
        ]

        def is_stage_color(r, g, b):
            return (
                (g > 34 and g >= r + 4 and g >= b + 10 and r < 95 and b < 80) or
                (r > 55 and g > 42 and r >= g - 8 and g >= b + 10 and r - b > 24)
            )

        def region_patch_color(left, top, right, bottom):
            for pad in (5, 9, 15, 24):
                colors = []
                sample_left = max(0, left - pad)
                sample_top = max(0, top - pad)
                sample_right = min(image_width, right + pad)
                sample_bottom = min(image_height, bottom + pad)

                for sy in range(sample_top, sample_bottom):
                    for sx in range(sample_left, sample_right):
                        if left <= sx < right and top <= sy < bottom:
                            continue

                        sr, sg, sb, sa = image_px[sx, sy]

                        if sa < 180 or is_stage_color(sr, sg, sb):
                            continue

                        if max(sr, sg, sb) < 145 and max(sr, sg, sb) - min(sr, sg, sb) < 96:
                            colors.append((sr, sg, sb))

                if colors:
                    colors.sort(key=lambda color: color[0] + color[1] + color[2])
                    return colors[len(colors) // 2]

            return (18, 18, 18)

        def nearby_opaque_count(cx, cy):
            count = 0

            for sy in range(max(0, cy - 4), min(image_height, cy + 5)):
                for sx in range(max(0, cx - 4), min(image_width, cx + 5)):
                    if sx == cx and sy == cy:
                        continue

                    if image_px[sx, sy][3] > 180:
                        count += 1

            return count

        low_alpha_mask = Image.new("L", image.size, 0)
        low_alpha_px = low_alpha_mask.load()

        for y in range(image_height):
            for x in range(image_width):
                if image_px[x, y][3] < 245 and nearby_opaque_count(x, y) >= 14:
                    low_alpha_px[x, y] = 255

        source = low_alpha_mask.load()
        seen = set()

        for y in range(image_height):
            for x in range(image_width):
                if not source[x, y] or (x, y) in seen:
                    continue

                queue = [(x, y)]
                seen.add((x, y))
                points = []
                min_x = max_x = x
                min_y = max_y = y

                for cx, cy in queue:
                    points.append((cx, cy))
                    min_x = min(min_x, cx)
                    max_x = max(max_x, cx)
                    min_y = min(min_y, cy)
                    max_y = max(max_y, cy)

                    for ny in range(cy - 1, cy + 2):
                        for nx in range(cx - 1, cx + 2):
                            if nx < 0 or ny < 0 or nx >= image_width or ny >= image_height or (nx, ny) in seen:
                                continue

                            if source[nx, ny]:
                                seen.add((nx, ny))
                                queue.append((nx, ny))

                span_x = max_x - min_x + 1
                span_y = max_y - min_y + 1
                touches_outer_edge = min_x <= 2 or min_y <= 2 or max_x >= image_width - 3 or max_y >= image_height - 3
                small_ui_hole = 7 <= span_x <= 58 and 7 <= span_y <= 48 and 12 <= len(points) <= 760
                center_x = (min_x + max_x) / 2
                center_y = (min_y + max_y) / 2
                protected_face = image_width * 0.33 < center_x < image_width * 0.56 and image_height * 0.20 < center_y < image_height * 0.37

                if small_ui_hole and not touches_outer_edge and not protected_face:
                    patch_color = region_patch_color(min_x, min_y, max_x + 1, max_y + 1)
                    paint_left = max(0, min_x - 4)
                    paint_top = max(0, min_y - 4)
                    paint_right = min(image_width - 1, max_x + 4)
                    paint_bottom = min(image_height - 1, max_y + 4)

                    for py in range(paint_top, paint_bottom + 1):
                        for px in range(paint_left, paint_right + 1):
                            pr, pg, pb, pa = image_px[px, py]
                            neutral_ui = pa and pr > 110 and pg > 110 and pb > 110 and max(pr, pg, pb) - min(pr, pg, pb) < 110

                            if source[px, py] or neutral_ui:
                                image_px[px, py] = (*patch_color, 255)

        white_mask = Image.new("L", image.size, 0)
        white_px = white_mask.load()

        for y in range(image_height):
            for x in range(image_width):
                r, g, b, a = image_px[x, y]
                if a > 80 and r > 110 and g > 110 and b > 110 and max(r, g, b) - min(r, g, b) < 110:
                    white_px[x, y] = 255

        source = white_mask.load()
        seen = set()

        for y in range(image_height):
            for x in range(image_width):
                if not source[x, y] or (x, y) in seen:
                    continue

                queue = [(x, y)]
                seen.add((x, y))
                points = []
                min_x = max_x = x
                min_y = max_y = y

                for cx, cy in queue:
                    points.append((cx, cy))
                    min_x = min(min_x, cx)
                    max_x = max(max_x, cx)
                    min_y = min(min_y, cy)
                    max_y = max(max_y, cy)

                    for ny in range(cy - 1, cy + 2):
                        for nx in range(cx - 1, cx + 2):
                            if nx < 0 or ny < 0 or nx >= image_width or ny >= image_height or (nx, ny) in seen:
                                continue

                            if source[nx, ny]:
                                seen.add((nx, ny))
                                queue.append((nx, ny))

                span_x = max_x - min_x + 1
                span_y = max_y - min_y + 1
                center_x = (min_x + max_x) / 2
                center_y = (min_y + max_y) / 2
                upper_right_echo = center_x > image_width * 0.55 and center_y < image_height * 0.30
                small_square_edge = 3 <= span_x <= 24 and 2 <= span_y <= 24 and len(points) <= 90

                if upper_right_echo and small_square_edge:
                    patch_color = region_patch_color(min_x, min_y, max_x + 1, max_y + 1)

                    if max(patch_color) < 85:
                        for px, py in points:
                            image_px[px, py] = (*patch_color, 255)

        upper_edge_left = round(image_width * 0.585)
        upper_edge_top = round(image_height * 0.197)
        upper_edge_right = round(image_width * 0.635)
        upper_edge_bottom = round(image_height * 0.235)
        patch_color = region_patch_color(upper_edge_left, upper_edge_top, upper_edge_right, upper_edge_bottom)

        if max(patch_color) < 85:
            for y in range(upper_edge_top, upper_edge_bottom):
                for x in range(upper_edge_left, upper_edge_right):
                    if image_px[x, y][3] < 245 and nearby_opaque_count(x, y) >= 8:
                        image_px[x, y] = (*patch_color, 255)

        return image

        for left, top, right, bottom in profile_echo_regions:
            patch_color = region_patch_color(left, top, right, bottom)

            for y in range(max(0, top), min(image_height, bottom)):
                for x in range(max(0, left), min(image_width, right)):
                    r, g, b, a = image_px[x, y]
                    neutral_ui = a and r > 115 and g > 115 and b > 115 and max(r, g, b) - min(r, g, b) < 95
                    translucent_cut = a < 245

                    if (neutral_ui or translucent_cut) and nearby_opaque_count(x, y) >= 14:
                        image_px[x, y] = (*patch_color, 255)

        return image

        white_mask = Image.new("L", image.size, 0)
        white_px = white_mask.load()

        for y in range(image_height):
            for x in range(image_width):
                r, g, b, a = image_px[x, y]

                if not a:
                    continue

                neutral_white = r > 145 and g > 145 and b > 145 and max(r, g, b) - min(r, g, b) < 45

                if neutral_white:
                    white_px[x, y] = 255

        component_mask = white_mask.filter(ImageFilter.MaxFilter(5))
        source = component_mask.load()
        seen = set()

        def is_stage_color(r, g, b):
            return (
                (g > 34 and g >= r + 4 and g >= b + 10 and r < 95 and b < 80) or
                (r > 55 and g > 42 and r >= g - 8 and g >= b + 10 and r - b > 24)
            )

        def nearby_patch_color(min_x, min_y, max_x, max_y):
            for pad in (5, 9, 15, 24):
                colors = []
                left = max(0, min_x - pad)
                top = max(0, min_y - pad)
                right = min(image_width - 1, max_x + pad)
                bottom = min(image_height - 1, max_y + pad)

                for sy in range(top, bottom + 1):
                    for sx in range(left, right + 1):
                        if min_x <= sx <= max_x and min_y <= sy <= max_y:
                            continue

                        sr, sg, sb, sa = image_px[sx, sy]

                        if sa < 180 or source[sx, sy]:
                            continue

                        if is_stage_color(sr, sg, sb):
                            continue

                        if max(sr, sg, sb) < 135 and max(sr, sg, sb) - min(sr, sg, sb) < 92:
                            colors.append((sr, sg, sb))

                if colors:
                    colors.sort(key=lambda color: color[0] + color[1] + color[2])
                    return colors[len(colors) // 2]

            return (12, 12, 12)

        for y in range(image_height):
            for x in range(image_width):
                if not source[x, y] or (x, y) in seen:
                    continue

                queue = [(x, y)]
                seen.add((x, y))
                points = []
                min_x = max_x = x
                min_y = max_y = y

                for cx, cy in queue:
                    points.append((cx, cy))
                    min_x = min(min_x, cx)
                    max_x = max(max_x, cx)
                    min_y = min(min_y, cy)
                    max_y = max(max_y, cy)

                    for ny in range(cy - 1, cy + 2):
                        for nx in range(cx - 1, cx + 2):
                            if nx < 0 or ny < 0 or nx >= image_width or ny >= image_height or (nx, ny) in seen:
                                continue

                            if source[nx, ny]:
                                seen.add((nx, ny))
                                queue.append((nx, ny))

                span_x = max_x - min_x + 1
                span_y = max_y - min_y + 1
                small_box = 7 <= span_x <= 46 and 7 <= span_y <= 38 and len(points) <= 660
                face_region = image_width * 0.34 < min_x < image_width * 0.58 and image_height * 0.18 < min_y < image_height * 0.38
                sword_highlight = span_x > span_y * 3 or span_y > span_x * 3
                center_x = (min_x + max_x) / 2
                center_y = (min_y + max_y) / 2
                ui_echo_zone = (
                    (image_width * 0.54 < center_x < image_width * 0.66 and image_height * 0.16 < center_y < image_height * 0.25) or
                    (image_width * 0.10 < center_x < image_width * 0.22 and image_height * 0.47 < center_y < image_height * 0.56) or
                    (image_width * 0.06 < center_x < image_width * 0.18 and image_height * 0.74 < center_y < image_height * 0.82)
                )

                if ui_echo_zone and small_box and not face_region and not sword_highlight:
                    patch_color = nearby_patch_color(min_x, min_y, max_x, max_y)

                    for py in range(min_y, max_y + 1):
                        for px in range(min_x, max_x + 1):
                            pr, pg, pb, pa = image_px[px, py]
                            near_white = pa and pr > 130 and pg > 130 and pb > 130 and max(pr, pg, pb) - min(pr, pg, pb) < 75
                            text_shadow = (
                                pa and
                                source[px, py] and
                                max(pr, pg, pb) < 70 and
                                max(pr, pg, pb) - min(pr, pg, pb) < 38
                            )

                            if near_white or text_shadow:
                                image_px[px, py] = (*patch_color, 255)

        return image

    def remove_stage_color_fringe(image):
        image_px = image.load()
        alpha = image.getchannel("A")
        alpha_px = alpha.load()
        image_width, image_height = image.size
        fringe_mask = Image.new("L", image.size, 0)
        fringe_px = fringe_mask.load()

        def is_stage_green(r, g, b):
            return (
                (
                    g > 42 and
                    g >= r + 10 and
                    g >= b + 10 and
                    r < 120 and
                    b < 110
                ) or (
                    g > 34 and
                    g >= r + 4 and
                    g >= b + 18 and
                    r < 95 and
                    b < 70
                ) or (
                    g > 16 and
                    g >= r + 4 and
                    g >= b + 10 and
                    r < 70 and
                    b < 50
                )
            )

        def is_stage_tan(r, g, b):
            return (
                r > 55 and
                g > 42 and
                r >= g - 8 and
                g >= b + 10 and
                r - b > 24 and
                max(r, g, b) - min(r, g, b) < 110
            )

        def is_stage_blue(r, g, b):
            return (
                b > 70 and
                g > 55 and
                b >= r + 18 and
                g >= r + 10 and
                max(r, g, b) - min(r, g, b) > 34
            ) or (
                b > 90 and
                g > 90 and
                r < 180 and
                g >= r + 18 and
                b >= r + 18
            )

        def is_stage_yellow_green(r, g, b):
            return (
                r > 70 and
                g > 80 and
                b < 165 and
                g >= r - 18 and
                g >= b + 24 and
                r >= b + 8
            )

        def is_stage_leaf(r, g, b):
            return (
                b < 95 and
                max(r, g, b) - min(r, g, b) > 26 and
                (g >= b + 16 or r >= b + 24) and
                r > 28 and
                g > 32
            )

        def is_stage_teal_shadow(r, g, b):
            return (
                r < 80 and
                g > 44 and
                b > 44 and
                g >= r + 8 and
                b >= r + 8 and
                abs(g - b) < 34
            )

        def is_stage_color(r, g, b):
            return (
                is_stage_green(r, g, b) or
                is_stage_tan(r, g, b) or
                is_stage_blue(r, g, b) or
                is_stage_yellow_green(r, g, b) or
                is_stage_leaf(r, g, b)
            )

        def near_transparent(x, y, radius=4):
            for sy in range(max(0, y - radius), min(image_height, y + radius + 1)):
                for sx in range(max(0, x - radius), min(image_width, x + radius + 1)):
                    if alpha_px[sx, sy] < 16:
                        return True
            return False

        for y in range(image_height):
            for x in range(image_width):
                r, g, b, a = image_px[x, y]

                if not a:
                    continue

                stage_color = is_stage_color(r, g, b)
                lower_half = y > image_height * 0.42
                outer_band = x < image_width * 0.12 or x > image_width * 0.88 or y > image_height * 0.72
                colored_edge = stage_color and near_transparent(x, y, 8)

                if colored_edge or ((is_stage_green(r, g, b) or is_stage_tan(r, g, b)) and (lower_half or outer_band)):
                    fringe_px[x, y] = 255

        fringe_mask = fringe_mask.filter(ImageFilter.MaxFilter(3))
        fringe_px = fringe_mask.load()

        def nearby_neutral_color(cx, cy):
            for radius in (3, 6, 10, 16):
                colors = []
                for sy in range(max(0, cy - radius), min(image_height, cy + radius + 1)):
                    for sx in range(max(0, cx - radius), min(image_width, cx + radius + 1)):
                        sr, sg, sb, sa = image_px[sx, sy]

                        if not sa or fringe_px[sx, sy]:
                            continue

                        if is_stage_color(sr, sg, sb):
                            continue

                        if max(sr, sg, sb) < 135 and max(sr, sg, sb) - min(sr, sg, sb) < 85:
                            colors.append((sr, sg, sb))

                if colors:
                    colors.sort(key=lambda color: color[0] + color[1] + color[2])
                    return colors[len(colors) // 2]

            return None

        for y in range(image_height):
            for x in range(image_width):
                if fringe_px[x, y]:
                    r, g, b, a = image_px[x, y]
                    if not a:
                        continue

                    if is_stage_color(r, g, b):
                        replacement = nearby_neutral_color(x, y)

                        if replacement and a >= 180 and not near_transparent(x, y, 2):
                            nr, ng, nb = replacement
                            image_px[x, y] = (nr, ng, nb, a)
                        else:
                            image_px[x, y] = (r, g, b, 0)

        debris_mask = Image.new("L", image.size, 0)
        debris_px = debris_mask.load()

        def is_dark_stage_debris(r, g, b):
            dark_olive = (
                g > 14 and
                r < 75 and
                b < 55 and
                g >= r - 4 and
                g >= b + 8
            )
            dark_brown = (
                r < 75 and
                g < 65 and
                b < 45 and
                r >= g + 3 and
                g >= b + 3 and
                r - b > 8
            )
            return dark_olive or dark_brown

        remove_mask = debris_mask

        if remove_mask.getbbox():
            alpha = image.getchannel("A")
            alpha = ImageChops.subtract(alpha, remove_mask)
            image.putalpha(alpha)
            alpha_px = alpha.load()

        thin_debris_mask = Image.new("L", image.size, 0)
        thin_debris_px = thin_debris_mask.load()
        lower_cleanup_top = round(image_height * 0.67)
        lower_cleanup_bottom = round(image_height * 0.90)
        lower_cleanup_left = round(image_width * 0.16)
        lower_cleanup_right = round(image_width * 0.74)

        def horizontal_opaque_count(cx, cy, radius=11):
            count = 0

            for sx in range(max(0, cx - radius), min(image_width, cx + radius + 1)):
                if alpha_px[sx, cy] > 180:
                    count += 1

            return count

        for y in range(lower_cleanup_top, lower_cleanup_bottom):
            for x in range(lower_cleanup_left, lower_cleanup_right):
                r, g, b, a = image_px[x, y]

                if not a:
                    continue

                stage_gold = (
                    a < 170 and
                    r > 85 and
                    g > 55 and
                    b < 55 and
                    r >= g - 8 and
                    r - b > 42 and
                    near_transparent(x, y, 3)
                )
                very_dark_strip = False

                if stage_gold or very_dark_strip:
                    thin_debris_px[x, y] = 255

        for y in range(round(image_height * 0.76), image_height):
            for x in range(round(image_width * 0.40), image_width):
                r, g, b, a = image_px[x, y]
                stage_yellow_green = is_stage_yellow_green(r, g, b)

                if a and near_transparent(x, y, 6) and (is_stage_color(r, g, b) or stage_yellow_green):
                    thin_debris_px[x, y] = 255

        if thin_debris_mask.getbbox():
            alpha = image.getchannel("A")
            alpha = ImageChops.subtract(alpha, thin_debris_mask)
            image.putalpha(alpha)

        for y in range(round(image_height * 0.68), image_height):
            for x in range(round(image_width * 0.12), round(image_width * 0.88)):
                r, g, b, a = image_px[x, y]

                if not a:
                    continue

                stage_yellow_green = is_stage_yellow_green(r, g, b)
                stage_gold = r > 85 and g > 55 and b < 70 and r >= g - 8 and r - b > 32

                if is_stage_color(r, g, b) or stage_yellow_green or stage_gold:
                    replacement = nearby_neutral_color(x, y)

                    if replacement:
                        nr, ng, nb = replacement
                        image_px[x, y] = (nr, ng, nb, a)

        for y in range(0, round(image_height * 0.62)):
            for x in range(round(image_width * 0.06), round(image_width * 0.55)):
                r, g, b, a = image_px[x, y]

                if not a:
                    continue

                trapped_leaf = is_stage_leaf(r, g, b) or is_stage_yellow_green(r, g, b)
                edge_teal = is_stage_teal_shadow(r, g, b)

                if trapped_leaf or edge_teal:
                    replacement = nearby_neutral_color(x, y)

                    if replacement:
                        nr, ng, nb = replacement
                        image_px[x, y] = (nr, ng, nb, a)

        return image

    def remove_tiny_isolated_artifacts(image):
        alpha = image.getchannel("A")
        source = alpha.load()
        image_width, image_height = image.size
        remove_mask = Image.new("L", image.size, 0)
        remove_px = remove_mask.load()
        seen = set()

        for y in range(image_height):
            for x in range(image_width):
                if not source[x, y] or (x, y) in seen:
                    continue

                queue = [(x, y)]
                seen.add((x, y))
                points = []
                min_x = max_x = x
                min_y = max_y = y

                for cx, cy in queue:
                    points.append((cx, cy))
                    min_x = min(min_x, cx)
                    max_x = max(max_x, cx)
                    min_y = min(min_y, cy)
                    max_y = max(max_y, cy)

                    for ny in range(cy - 1, cy + 2):
                        for nx in range(cx - 1, cx + 2):
                            if nx < 0 or ny < 0 or nx >= image_width or ny >= image_height or (nx, ny) in seen:
                                continue

                            if source[nx, ny]:
                                seen.add((nx, ny))
                                queue.append((nx, ny))

                span_x = max_x - min_x + 1
                span_y = max_y - min_y + 1

                if len(points) < 400 and span_x < 32 and span_y < 32:
                    for px, py in points:
                        remove_px[px, py] = 255

        if remove_mask.getbbox():
            alpha = ImageChops.subtract(alpha, remove_mask)
            image.putalpha(alpha)

        return image

    def trim_transparent_padding(image, pad=28):
        bbox = image.getbbox()

        if not bbox:
            return image

        image_width, image_height = image.size
        left = max(0, bbox[0] - pad)
        top = max(0, bbox[1] - pad)
        right = min(image_width, bbox[2] + pad)
        bottom = min(image_height, bbox[3] + pad)

        return image.crop((left, top, right, bottom))

    for frame in processed:
        cropped = frame.crop(bbox)
        canvas = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
        canvas.alpha_composite(cropped, offset)
        canvas = repair_transparent_holes(canvas, close_size=max(13, round(canvas_width * 0.012)))
        canvas = clean_edge_text(canvas)
        frames.append(canvas)
else:
    for path in frame_paths:
        frames.append(Image.open(path).convert("RGBA"))

if not frames:
    raise SystemExit("No frames provided")

if custom_output:
    target_width = 1440
    target_height = 2238
    target_long_side = 2300
    body_shift_x = -90
    custom_frames = []

    def body_center_x(image):
        alpha = image.getchannel("A")
        alpha_px = alpha.load()
        image_width, image_height = image.size
        top = round(image_height * 0.04)
        bottom = round(image_height * 0.74)
        scores = []

        for x in range(image_width):
            score = 0

            for y in range(top, bottom):
                if alpha_px[x, y] > 24:
                    score += 1

            scores.append(score)

        max_score = max(scores) if scores else 0

        if max_score <= 0:
            bbox = image.getbbox()
            return image_width / 2 if not bbox else (bbox[0] + bbox[2]) / 2

        threshold = max(8, max_score * 0.55)
        weighted_x = 0
        total = 0

        for x, score in enumerate(scores):
            if score >= threshold:
                weighted_x += x * score
                total += score

        return weighted_x / total if total else scores.index(max_score)

    def alpha_composite_clipped(canvas, source, dst_x, dst_y):
        src_left = max(0, -dst_x)
        src_top = max(0, -dst_y)
        paste_x = max(0, dst_x)
        paste_y = max(0, dst_y)
        paste_width = min(canvas.width - paste_x, source.width - src_left)
        paste_height = min(canvas.height - paste_y, source.height - src_top)

        if paste_width > 0 and paste_height > 0:
            canvas.alpha_composite(
                source.crop((src_left, src_top, src_left + paste_width, src_top + paste_height)),
                (paste_x, paste_y)
            )

    for frame in frames:
        frame_bbox = frame.getbbox()

        if frame_bbox:
            pad = max(18, round(max(frame.size) * 0.012))
            frame_bbox = (
                max(0, frame_bbox[0] - pad),
                max(0, frame_bbox[1] - pad),
                min(frame.width, frame_bbox[2] + pad),
                min(frame.height, frame_bbox[3] + pad)
            )
            content = frame.crop(frame_bbox)
            content = content.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            content_width, content_height = content.size
            scale = target_long_side / max(content_width, content_height)
            new_size = (
                max(1, round(content_width * scale)),
                max(1, round(content_height * scale))
            )
            resized = content.resize(new_size, Image.Resampling.LANCZOS)
            portrait = Image.new("RGBA", (target_width, target_height), (0, 0, 0, 0))
            dst_x = round((target_width / 2) - body_center_x(resized) + body_shift_x)
            dst_y = round((target_height - new_size[1]) / 2)
            alpha_composite_clipped(portrait, resized, dst_x, dst_y)
        else:
            portrait = Image.new("RGBA", (target_width, target_height), (0, 0, 0, 0))

        custom_frames.append(portrait)

    frames = custom_frames
elif profile_output:
    target_width = 720
    target_height = 1119
    portrait_frames = []

    for frame in frames:
        frame_bbox = frame.getbbox()
        portrait = Image.new("RGBA", (target_width, target_height), (0, 0, 0, 0))

        if frame_bbox:
            content = frame.crop(frame_bbox)
            content_width, content_height = content.size
            scale = min(
                (target_width * 0.94) / content_width,
                (target_height * 0.94) / content_height
            )
            new_size = (
                max(1, round(content_width * scale)),
                max(1, round(content_height * scale))
            )
            resized = content.resize(new_size, Image.Resampling.LANCZOS)
            dst_x = round((target_width - new_size[0]) / 2)
            dst_y = round((target_height - new_size[1]) / 2)

            src_left = max(0, -dst_x)
            src_top = max(0, -dst_y)
            paste_x = max(0, dst_x)
            paste_y = max(0, dst_y)
            paste_width = min(target_width - paste_x, new_size[0] - src_left)
            paste_height = min(target_height - paste_y, new_size[1] - src_top)

            if paste_width > 0 and paste_height > 0:
                portrait.alpha_composite(
                    resized.crop((src_left, src_top, src_left + paste_width, src_top + paste_height)),
                    (paste_x, paste_y)
                )

        portrait = remove_profile_background_artifacts(portrait)
        portrait = remove_stage_color_fringe(portrait)
        portrait = fill_enclosed_character_holes(portrait)
        portrait = repair_small_white_fragments(portrait)
        portrait = remove_tiny_isolated_artifacts(portrait)
        portrait = trim_transparent_padding(portrait)
        portrait_frames.append(portrait)

    frames = portrait_frames
elif template_output:
    max_width = 720
    max_height = 1119
    scale = min(max_width / frames[0].width, max_height / frames[0].height, 1)

    if scale < 1:
        resized = []
        new_size = (
            max(1, round(frames[0].width * scale)),
            max(1, round(frames[0].height * scale))
        )

        for frame in frames:
            resized.append(frame.resize(new_size, Image.Resampling.LANCZOS))

        frames = resized

if out.lower().endswith(".png"):
    frames[0].save(out, format="PNG")
else:
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=140,
        loop=0,
        disposal=2
    )
`;

  const encodeScriptPath = path.join(frameDir, "encode.py");
  await writeFile(encodeScriptPath, script);

  await runProcess(PYTHON_EXE, [
    encodeScriptPath,
    outputPath,
    backgroundPath,
    cleanOutput ? "1" : "0",
    sourceMode,
    ...framePaths
  ]);
}

await rm(frameDir, { recursive: true, force: true });
await mkdir(frameDir, { recursive: true });

const launchOptions = { headless: true };

if (CHROME_EXE) {
  launchOptions.executablePath = CHROME_EXE;
}

const browser = await chromium.launch(launchOptions);

try {
  var character = await loadCharacter();
  const missing = character.assets.files.filter((asset) =>
    !asset.available &&
    (includePet || !asset.gameFilePath.includes("/pets/")) &&
    (includeGround || !asset.gameFilePath.includes("/grounds/"))
  );
  if (missing.length > 0) {
    throw new Error(`Missing assets: ${missing.map((asset) => asset.gameFilePath).join(", ")}`);
  }

  globalThis.character = character;
  const page = await browser.newPage({
    viewport: { width: stageWidth, height: stageHeight },
    deviceScaleFactor: renderScale
  });

  const framePaths = [];
  const frameCount = outputFormat === "png" ? 1 : 10;
  for (let index = 0; index < frameCount; index += 1) {
    const framePath = path.join(frameDir, `frame-${String(index).padStart(2, "0")}.png`);
    framePaths.push(framePath);
  }

  const cleanOutput = mode !== "full";
  const backgroundPath = path.join(frameDir, "background.png");

  if (!useCustomViewer) {
    await captureFrames(page, [backgroundPath], true, cleanOutput);
  }

  await captureFrames(page, framePaths, false, cleanOutput);
  await encodeGif(framePaths, backgroundPath, cleanOutput);
} finally {
  await browser.close();
}
