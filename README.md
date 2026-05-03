# AQW Charpage PNG API

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-2f855a?style=for-the-badge">
  <img alt="Docker Ready" src="https://img.shields.io/badge/Docker-ready-2563eb?style=for-the-badge">
  <img alt="Transparent PNG" src="https://img.shields.io/badge/output-transparent%20PNG-111827?style=for-the-badge">
</p>

<p align="center">
  Render clean, transparent AQWorlds character portraits from public charpage data.
</p>

---

## Overview

AQW Charpage PNG API turns an AQWorlds character page into a centered, transparent PNG portrait. It fetches the character data, resolves equipped item SWFs, renders them through a stripped character viewer, and caches the result for faster repeat requests.

It is built for:

- transparent character PNGs
- AQW equipment rendering
- no pet and no ground item by default
- browser previews with animated loading text
- throttled SWF fetching to avoid hammering `game.aq.com`
- Docker deployment on hosts like Render

## Preview

```text
http://localhost:3000/character/Selena
http://localhost:3000/api/character/Selena/png?refresh=1
```

## API Routes

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/` | Small route index. |
| `GET` | `/character/:name` | Browser preview page for a character. |
| `GET` | `/api/character/:name` | Character JSON, FlashVars, equipment, and asset metadata. |
| `GET` | `/api/character/:name/png` | Transparent PNG portrait. |
| `GET` | `/api/character/:name/compositor` | Item SWF manifest and symbol inspection data. |
| `GET` | `/api/custom-character.swf` | Generated minimal SWF viewer used by the renderer. |

## Query Options

| Option | Example | Result |
| --- | --- | --- |
| `refresh=1` | `/api/character/Selena/png?refresh=1` | Forces a fresh render. |
| `pet=1` | `/api/character/Selena/png?pet=1` | Includes the pet. |
| `ground=1` | `/api/character/Selena/png?ground=1` | Includes the ground item. |
| `source=viewer` | `/api/character/Selena/png?source=viewer` | Uses the older full-viewer cleanup path. |
| `source=download` | `/api/character/Selena/png?source=download` | Uses `Downloads/<character>.gif` if present locally. |

## Local Setup

Requirements:

- Node.js 20+
- Python 3 with Pillow
- Chromium for Playwright

Install dependencies:

```bash
npm install
npm run install:browsers
```

Start the API:

```bash
npm start
```

Open the preview:

```text
http://localhost:3000/character/Selena
```

Request a PNG directly:

```text
http://localhost:3000/api/character/Selena/png?refresh=1
```

## Docker

Build the image:

```bash
docker build -t aqw-charpage-png-api .
```

Run it locally:

```bash
docker run --rm -p 3000:3000 aqw-charpage-png-api
```

Then open:

```text
http://localhost:3000/character/Selena
```

## Render Deployment

Render works best with the included Dockerfile because this project needs browser rendering support.

Use these settings:

| Setting | Value |
| --- | --- |
| Service type | Web Service |
| Runtime | Docker |
| Branch | `main` |
| Root directory | Leave blank |
| Dockerfile path | `Dockerfile` |
| Instance type | Free or higher |
| Health check path | `/` |

Recommended environment variables:

```text
PORT=3000
PYTHON_EXE=python3
AQW_FETCH_LIMIT=2
AQW_FETCH_WINDOW_MS=3000
NODE_ENV=production
```

After deploy, test:

```text
https://your-service-name.onrender.com/character/Selena
https://your-service-name.onrender.com/api/character/Selena/png?refresh=1
```

Render free services can sleep after inactivity, and local cache files are not permanent on free instances. First renders after wake-up may be slower.

## AQW Fetch Throttle

Uncached SWFs from `game.aq.com` are fetched through a queue. Cached files are served immediately.

Default behavior:

```text
AQW_FETCH_LIMIT=2
AQW_FETCH_WINDOW_MS=3000
```

That means only 2 AQW game-file requests begin every 3 seconds. If AQW starts returning rate limits, slow it down:

```text
AQW_FETCH_LIMIT=1
AQW_FETCH_WINDOW_MS=5000
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for the API. |
| `PYTHON_EXE` | `python3` on Linux, `python` on Windows | Python executable used for image cleanup. |
| `CHROME_EXE` | auto-detected | Optional explicit Chromium or Chrome executable path. |
| `AQW_FETCH_LIMIT` | `2` | Number of AQW SWF fetches allowed per throttle window. |
| `AQW_FETCH_WINDOW_MS` | `3000` | Throttle window duration in milliseconds. |

## Cache

Generated and downloaded files are stored under `.cache/`:

```text
.cache/aqw-gamefiles
.cache/renders
```

These files are intentionally ignored by Git. Keep the source clean and let the app rebuild cache as needed.

## Project Structure

```text
.
|-- Dockerfile
|-- README.md
|-- package.json
`-- src
    |-- compositor.js
    |-- custom-swf.js
    |-- render-gif.mjs
    `-- server.js
```

## Notes

This project does not bundle AQWorlds assets. It fetches public game files on demand and caches them locally for rendering. Use the throttle settings responsibly when deploying publicly.

## License

This project is licensed under the MIT License.

AQWorlds, AdventureQuest Worlds, and related game assets belong to Artix Entertainment.

This project does not bundle AQWorlds assets; it fetches public assets on demand.

## Disclaimer

This project is not affiliated with, endorsed by, sponsored by, or connected to Artix Entertainment, LLC.

AQWorlds, AdventureQuest Worlds, Artix Entertainment, and all related names, logos, characters, artwork, game files, and assets are the property of their respective owners. All rights belong to Artix Entertainment and the rightful copyright holders.

This project is made for entertainment and educational purposes only.
