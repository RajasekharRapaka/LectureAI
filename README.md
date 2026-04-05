# LectureAI

YouTube Lecture → Comprehensive Study Notes, Articles & PDF
Powered by **Google Gemini** and **Groq** (free-tier multi-model support)

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Project Structure](#project-structure)
3. [AI Models Supported](#ai-models-supported)
4. [Local Development](#local-development)
5. [Environment Variables](#environment-variables)
6. [UI Overview](#ui-overview)
7. [API Endpoints Reference](#api-endpoints-reference)
8. [Background Job System](#background-job-system)
9. [Transcript Fetching](#transcript-fetching)
10. [Processing & Chunking Logic](#processing--chunking-logic)
11. [Export Options](#export-options)
12. [Coverage Audit](#coverage-audit)
13. [Playlist Support](#playlist-support)
14. [Rate Limits & Free Tier Guide](#rate-limits--free-tier-guide)
15. [Deploy to AWS EC2](#deploy-to-aws-ec2)
16. [Useful Commands (EC2)](#useful-commands-ec2)
17. [Adding HTTPS](#adding-https)

---

## What It Does

LectureAI converts any YouTube lecture (or manually pasted transcript) into:

- **Comprehensive study notes** — exhaustive Markdown notes that capture every concept, formula, code example, and insight from the lecture
- **Formatted articles** — HTML, Markdown, Blog Post, Study Guide, or Newsletter
- **Playlist course documents** — process an entire YouTube playlist and merge all videos into a single structured course document
- **PDF / Word exports** — download notes or articles as `.pdf`, `.docx`, `.md`, or `.txt`
- **Coverage audit report** — verify that your notes actually cover the full transcript (25-point fact-check)

Supports lectures of any length — from 5-minute clips to 90+ hour playlists. Long content is automatically chunked, processed in parallel (Groq) or sequentially (Gemini), then intelligently merged.

---

## Project Structure

```
App/
├── app.py                 # Flask app — all routes, AI routing, background jobs
├── requirements.txt       # Python dependencies
├── gunicorn.conf.py       # Production server config (Gunicorn)
├── tubescribe.service     # systemd unit file (EC2 auto-start)
├── nginx.conf             # Nginx reverse proxy config
├── env.example copy.txt   # Environment variable template
├── templates/
│   └── index.html         # Single-page app (Jinja2 + vanilla JS)
└── static/
    ├── css/
    │   └── main.css       # All styles (dark theme, animations, responsive)
    └── js/
        └── main.js        # All frontend logic (if separated from index.html)
```

---

## AI Models Supported

LectureAI routes to either **Google Gemini** or **Groq** based on the model name prefix (`groq-` → Groq, otherwise → Gemini).

### Gemini Models (Google)
| UI Name | Model ID | Free Tier | Context |
|---------|----------|-----------|---------|
| Gemini 2.5 Flash ⭐ | `gemini-2.5-flash` | 250 req/day, 10 RPM | 1M tokens |
| Gemini 2.5 Flash Lite | `gemini-2.5-flash-lite` | 1,000 req/day, 15 RPM | 1M tokens |
| Gemini 2.5 Pro | `gemini-2.5-pro` | 100 req/day, 5 RPM | 1M tokens |

Get a free Gemini API key at: https://aistudio.google.com/apikey

### Groq Models (Groq LPU)
| UI Name | Model ID (internal) | Groq ID | Free Tier | Context |
|---------|---------------------|---------|-----------|---------|
| Llama 3.3 70B ⭐ | `groq-llama-3.3-70b` | `llama-3.3-70b-versatile` | ~14,400 req/day | 128k |
| Llama 3.1 8B | `groq-llama-3.1-8b` | `llama-3.1-8b-instant` | Very high | 128k |
| Mixtral 8x7B | `groq-mixtral` | `mixtral-8x7b-32768` | ~14,400 req/day | 32k |

Get a free Groq API key at: https://console.groq.com

> **Groq free-tier note:** The on-demand tier has a **12,000 TPM (tokens per minute)** limit.
> LectureAI automatically uses **7,000-word chunks** for Groq models (vs 20,000 for Gemini) to stay within this limit.
> If a 413 "request too large" response is returned anyway, the app waits 65 seconds and retries (the TPM window resets every minute).

---

## Local Development

### 1. Clone / enter the project

```bash
cd "App"
```

### 2. Create and activate a virtual environment

```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Set API keys

```bash
cp "env.example copy.txt" .env
nano .env
```

Minimum `.env` for Gemini-only:
```
GEMINI_API_KEY=AIzaSy...
```

Full `.env` for both providers:
```
GEMINI_API_KEY=AIzaSy...
GROQ_API_KEY=gsk_...
GEMINI_MODEL=gemini-2.5-flash
```

### 5. Run the development server

```bash
python app.py
```

Opens at http://localhost:8080

> **Note:** Users can also paste their own API keys directly in the **🔑 API Key** panel in the UI — keys are saved to `localStorage` and never sent to the server except as part of the API request.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | Recommended | — | Google Gemini API key |
| `GROQ_API_KEY` | Optional | — | Groq API key (enables Groq models) |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Default model for new sessions |
| `YOUTUBE_COOKIES_FILE` | No | — | Path to Netscape-format `cookies.txt` for bot detection bypass |

### Key Server-Side Constants (`app.py`)

| Constant | Default | Description |
|----------|---------|-------------|
| `MAX_OUTPUT_TOKENS` | 32,768 | Max tokens Gemini returns per call (saves ~50% quota vs 65k max) |
| `SAFE_INPUT_WORDS` | 700,000 | Hard cap on input to avoid runaway costs |
| `CHUNK_WORDS` | 20,000 | Words per chunk for **Gemini** (fits 1M context easily) |
| *(Groq chunk size)* | 7,000 | Words per chunk for **Groq** (keeps tokens under 12k TPM limit) |
| `CHUNK_OVERLAP_WORDS` | 200 | Overlap between consecutive chunks (preserves cross-boundary context) |
| `ASYNC_THRESHOLD_WORDS` | 12,000 | Transcripts longer than this use async background jobs |
| `GEMINI_MAX_RETRIES` | 4 | Retry attempts on rate-limited API calls |
| `GEMINI_BASE_WAIT` | 30s | Base wait before retry (doubles each attempt: 30 → 60 → 120 → 240s) |
| `GEMINI_TIMEOUT` | 300s | Gemini API timeout (Gemini 2.5 Pro can take 2–3 min on long chunks) |
| `GROQ_TIMEOUT` | 120s | Groq API timeout |
| `YT_TIMEOUT` | 25s | YouTube page / caption fetch timeout |

---

## UI Overview

LectureAI is a **5-panel sequential workflow** in a single-page app.

### Header

The sticky header contains three sections:

1. **Brand** — LectureAI logo and tagline
2. **Model bar** — Inline model switcher with animated brand labels:
   - **Gemini** label: purple gradient text + spinning 4-pointed star SVG with `geminiGlow` animation (2.5s breathing glow)
   - **Groq** label: green gradient text + G-circle SVG with `groqGlow` animation (2.5s breathing glow)
   - Selected model chip: `selectedPulse` animation (1.8s pulsing purple glow ring)
   - Models: Flash | Lite | Pro (Gemini) and 70B | 8B | Mixtral (Groq)
3. **🔑 API Key button** — opens the API key settings panel

### Panel 1 — Add Your Lecture
Three input modes (switchable tabs):
- **YouTube URL** — paste a video URL; app fetches transcript automatically (3-method fallback)
- **Playlist** — paste a playlist URL; select which videos to include; choose note style
- **Manual paste** — paste any transcript text directly

### Panel 2 — Generate Study Notes
- **Note style selector**: Comprehensive / Structured Notes / Bullet Points / Summary / Quick Summary
- **AI Model selector**: all 6 models (synced with header bar)
- **Processing estimate banner** — shows expected API calls, time, and quota cost
- Supports sync (short transcripts) and async background processing (long transcripts)

### Panel 3 — Generate Article
- **Article format selector**: Study Guide / HTML Article / Markdown / Blog Post / Newsletter
- Preview pane (rendered) + Source tab (raw code)
- Uses the generated notes as source material

### Panel 4 — Export Everything
- Download notes as: Markdown, Word (.docx), PDF, Plain Text
- Download article as: HTML, Markdown, Word (.docx), PDF
- Link to Panel 5 (Coverage Audit)

### Panel 5 — Coverage Audit
- Runs a 25-point fact-check comparing notes against the original transcript
- Produces a structured report: concept extraction → coverage check → score → verdict → recommended actions
- All 6 models available for the audit (choose speed vs thoroughness)

---

## API Endpoints Reference

### Static

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Main app UI |
| `GET` | `/health` | Health check → `{"status":"ok","model":"...","async_threshold_words":12000}` |
| `GET` | `/api/config` | Server config for frontend (model, chunk sizes, key presence) |

### Transcript

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/transcript` | Fetch transcript from YouTube URL |

**`POST /api/transcript`** — Request:
```json
{ "url": "https://www.youtube.com/watch?v=..." }
```
Response:
```json
{
  "transcript": "...",
  "title": "Video Title",
  "channel": "Channel Name",
  "word_count": 15234,
  "estimated_hours": 1.95,
  "chunks_needed": 1,
  "method": "yt-dlp"
}
```
Errors: `400` (missing/invalid URL), `422` (transcript unavailable), `500` (server error)

### Processing

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/process` | Synchronous — for short transcripts (< 12k words) |
| `POST` | `/api/process/async` | Asynchronous — starts background job |
| `GET` | `/api/job/<job_id>` | Poll background job status |
| `DELETE` | `/api/job/<job_id>` | Clean up a completed job |

**`POST /api/process`** — Request:
```json
{
  "transcript": "...",
  "mode": "notes",
  "format": "comprehensive",
  "title": "Lecture Title",
  "model": "gemini-2.5-flash",
  "api_key": "AIzaSy..."
}
```
`mode`: `"notes"` or `"article"`
`format` for notes: `comprehensive` | `notes` | `bullet` | `detailed` | `concise` | `executive`
`format` for articles: `html` | `markdown` | `blog` | `studynotes` | `newsletter`

Response:
```json
{
  "content": "## Introduction\n...",
  "chunks": 3,
  "words_in": 45000,
  "words_out": 8500,
  "model_used": "gemini-2.5-flash"
}
```

**`POST /api/process/async`** — Same request body as `/api/process`. Response:
```json
{
  "job_id": "341b3ca5-4b39-464b-b4fb-8314d8814efb",
  "words": 120000,
  "chunks_total": 6,
  "estimated_min": 3,
  "estimated_max": 6
}
```

**`GET /api/job/<job_id>`** — Response:
```json
{
  "job_id": "...",
  "status": "running",
  "percent": 55,
  "progress": ["[14:32:01] Chunk 2/6: 20,000 words → gemini-2.5-flash…", "..."],
  "chunks_total": 6,
  "chunks_done": 3,
  "model_used": "gemini-2.5-flash",
  "result": null
}
```
`status` values: `queued` | `running` | `done` | `error`
When `status = "done"`: `result` contains the full output dict.
When `status = "error"`: `error` field contains the error message.

### Legacy Compatibility

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/summarize` | Legacy summarization (single-pass, all models) |
| `POST` | `/api/article` | Generate article from summary + transcript |

**`POST /api/summarize`** — Request:
```json
{ "transcript": "...", "tone": "comprehensive", "model": "gemini-2.5-flash", "api_key": "" }
```
Response:
```json
{
  "summary": "...",
  "word_count_in": 12000,
  "word_count_out": 3500,
  "reduction_pct": 71,
  "tokens_est": 15960,
  "model_used": "gemini-2.5-flash"
}
```

### Coverage Audit

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/verify` | Run 25-point coverage audit on notes vs transcript |

**`POST /api/verify`** — Request:
```json
{
  "transcript": "...",
  "notes": "...",
  "model": "gemini-2.5-flash",
  "api_key": ""
}
```
Response:
```json
{
  "report": "## Coverage Audit\n### Concept Extraction\n...",
  "model_used": "gemini-2.5-flash",
  "transcript_words_total": 45000,
  "transcript_words_checked": 15000,
  "notes_words_total": 8500,
  "notes_words_checked": 8500
}
```
> For transcripts > 40k words, the audit samples beginning + middle + end (15k words each) to check coverage across the whole lecture, not just the start.

### Export

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/export/pdf` | Convert Markdown/HTML → PDF (binary download) |
| `POST` | `/api/export/docx` | Convert Markdown/HTML → Word DOCX (binary download) |

**`POST /api/export/pdf`** — Request:
```json
{ "content": "## Notes\n...", "title": "Lecture Title", "is_html": false }
```
Returns: binary PDF file (`application/pdf`)

**`POST /api/export/docx`** — Request:
```json
{ "content": "## Notes\n...", "title": "Lecture Title", "is_markdown": true }
```
Returns: binary DOCX file (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`)

### Playlist

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/playlist/info` | Fetch playlist metadata and video list |
| `POST` | `/api/playlist/process` | Start background job to process entire playlist |

**`POST /api/playlist/info`** — Request:
```json
{ "url": "https://www.youtube.com/playlist?list=PLxxx" }
```
Response:
```json
{
  "playlist_id": "PLxxx",
  "title": "MIT Introduction to Deep Learning",
  "channel": "Alexander Amini",
  "video_count": 8,
  "videos": [
    {"id": "ErnWZxJovaM", "title": "Introduction", "duration_seconds": 3600},
    "..."
  ]
}
```

**`POST /api/playlist/process`** — Request:
```json
{
  "playlist_id": "PLxxx",
  "video_ids": ["ErnWZxJovaM", "..."],
  "titles": {"ErnWZxJovaM": "Introduction", "...": "..."},
  "course_title": "MIT Introduction to Deep Learning",
  "model": "gemini-2.5-flash",
  "tone": "comprehensive",
  "api_key": ""
}
```
Response: same shape as `/api/process/async` (`job_id`, `video_count`, `estimated_min`, `estimated_max`).
Max 500 videos per job. Uses same `GET /api/job/<job_id>` polling endpoint.

---

## Background Job System

Long-running tasks (transcripts > 12,000 words, or any playlist) run as **background daemon threads**. The frontend polls for status every 3 seconds.

### Job Lifecycle
```
POST /api/process/async  →  job created ("queued")
                         →  daemon thread starts ("running")
                         →  progress updates added to job log
                         →  on completion → "done" (result stored) or "error"

GET /api/job/<id>        →  frontend polls this every 3 seconds
                         →  reads percent, progress log, status
                         →  on "done": displays result, hides modal

DELETE /api/job/<id>     →  frees job from memory (called after result read)
```

### Progress Percentage Mapping
- `0–85%` — chunk processing (proportional to chunks completed)
- `85–95%` — merge pass
- `95–100%` — finalizing / saving result

### Job Storage
Jobs are stored in an in-memory `dict` protected by a `threading.Lock`. Stale jobs older than 4 hours are automatically purged when a new job is created, preventing unbounded memory growth.

---

## Transcript Fetching

The app tries **three methods** in order, stopping at the first success:

### Method 1: yt-dlp (most reliable)
- Runs `yt-dlp --write-auto-sub` to download VTT subtitle files
- Handles bot detection, cookies, rate limiting
- Also fetches video title and channel via `yt-dlp --dump-json`

### Method 2: youtube-transcript-api library
- Uses the `youtube-transcript-api` Python package
- Tries English transcript first, then any available language
- Faster but fails more often on bot-protected videos

### Method 3: Direct page scrape (last resort)
- Loads the YouTube watch page HTML
- Extracts `captionTracks` JSON from page source
- Prefers: manual English → auto English → any English → anything available
- Parses both `srv3` XML and `json3` caption formats

### Bot Detection Bypass
If YouTube blocks requests, set `YOUTUBE_COOKIES_FILE` in `.env` to the path of a Netscape-format `cookies.txt` exported from your browser. The scraping session mimics a real Chrome/macOS browser with GDPR consent cookies pre-set.

---

## Processing & Chunking Logic

### Chunk Size
- **Gemini:** `CHUNK_WORDS = 20,000` words per chunk (~27k tokens; fits the 1M context window easily)
- **Groq:** 7,000 words per chunk (~9k tokens; stays under the 12k TPM free-tier limit)

### Chunk Overlap
Consecutive chunks overlap by `CHUNK_OVERLAP_WORDS = 200` words. This ensures topics that span a chunk boundary are not cut off — the model sees the tail end of the previous chunk at the start of the next one.

### Parallel vs Sequential
| Provider | Chunk processing | Why |
|----------|-----------------|-----|
| Groq | Parallel (up to 4 workers) | High RPM limits; parallel = 3–4× faster |
| Gemini | Sequential | Low free-tier RPM (5–15); parallel would hit 429 immediately |

### Merging Multi-Chunk Output
After all chunks are processed, results are merged:
- **Single chunk:** no merge needed; output used directly
- **Multiple chunks — notes mode (short formats):** single lightweight merge API call
- **Multiple chunks — notes mode (comprehensive, ≤ 80k merge input):** single detailed merge call with strict "keep everything" instructions
- **Multiple chunks — notes mode (comprehensive, > 80k merge input):** **hierarchical (binary-tree) merge** — pairs of chunks are merged first, then pairs of pairs, until a single document remains. This avoids exceeding context limits for very long lectures.
- **Multiple chunks — article mode:** unified merge preserving HTML/Markdown structure and content order

### Rate-Limit Retry Logic

**Gemini:**
- `429` with daily quota signal (`"per day"`, `"daily"`, `"quota exceeded"`) → fail immediately (retrying won't help; suggest alternatives)
- `429` RPM limit → exponential backoff: 30s → 60s → 120s → 240s (up to 4 retries)
- `500`, `503` → linear backoff: 15s, 30s, 45s, 60s

**Groq:**
- `429` (RPM limit) → exponential backoff: 30s → 60s → 120s → 240s
- `413` (TPM exceeded) → **wait 65 seconds** (TPM window resets every 60s), then retry

---

## Export Options

| Format | Engine | Notes |
|--------|--------|-------|
| Markdown (`.md`) | Client-side | Raw text download |
| Plain Text (`.txt`) | Client-side | Strips Markdown formatting |
| PDF (`.pdf`) | ReportLab (Python) | Professional dark theme; page numbers; document title header |
| Word (`.docx`) | python-docx | Proper heading styles; 1" margins; Calibri 11pt; code blocks in Courier New |
| HTML (`.html`) | Client-side | Standalone file with embedded styles; opens directly in browser |

PDF and DOCX are generated server-side via `/api/export/pdf` and `/api/export/docx`. Both accept Markdown or HTML input and auto-detect the format.

---

## Coverage Audit

The `/api/verify` endpoint runs a structured audit to verify your notes actually cover the transcript.

### Audit Report Sections
1. **Concept Extraction** — 25 specific facts, numbers, or concepts from the transcript
2. **Coverage Check** — for each concept: `COVERED` / `PARTIAL` / `MISSING`
3. **Coverage Score** — X/25 (PARTIAL counts as 0.5)
4. **Thin Sections** — topics that were mentioned but not explained properly
5. **Missing Topics** — concepts completely absent from the notes
6. **Accuracy Check** — any contradictions between notes and transcript
7. **Verdict** — `COMPREHENSIVE` / `GOOD` / `INCOMPLETE` / `INADEQUATE`
8. **Recommended Actions** — specific fixes to improve the notes

### Sampling Strategy
For very long content, the audit samples across the full lecture (not just the beginning):
- Transcripts > 40k words: samples beginning + middle + end (15k words each)
- Notes > 50k words: samples similarly

This ensures gaps in the middle or end of a lecture are caught.

---

## Playlist Support

LectureAI can process an entire YouTube playlist and merge all videos into a single **course document**.

### Playlist Job — Three Phases
1. **Fetch Transcripts (0–35%)** — fetches each video's transcript using the same 3-method fallback; skips videos without captions
2. **Generate Notes (35–85%)** — runs `process_transcript()` on each transcript independently
3. **Merge into Course Document (85–98%)** — labels each video's notes (e.g. `# Video 3: CNNs`) and merges them into a single document; the merge prompt explicitly preserves the original video order as a learning progression

### Course Document Structure
The final merged output follows this structure:
```
Overview → Table of Contents → Prerequisites →
[Part 1: Video Title Content] →
[Part 2: Video Title Content] →
... →
Master Summary → Reference Cheat Sheet
```

### Limits
- Maximum **500 videos** per playlist job
- Videos without captions are skipped (counted in `videos_failed`)
- Uses the same job polling system as single-video async processing

---

## Rate Limits & Free Tier Guide

### Choosing a Model

| Use case | Recommended model |
|----------|------------------|
| Best quality, plenty of quota | Groq Llama 3.3 70B (`groq-llama-3.3-70b`) |
| Fastest response, unlimited quota | Groq Llama 3.1 8B (`groq-llama-3.1-8b`) |
| Long context with Groq | Groq Mixtral 8x7B (`groq-mixtral`) |
| Best Gemini quality | Gemini 2.5 Flash (`gemini-2.5-flash`) |
| Most Gemini quota | Gemini 2.5 Flash Lite (`gemini-2.5-flash-lite`) |
| Deepest Gemini analysis | Gemini 2.5 Pro (`gemini-2.5-pro`) — use sparingly |

### Daily Limits (Free Tier, April 2026)
| Model | Req/day | RPM | Notes |
|-------|---------|-----|-------|
| `groq-llama-3.3-70b` | ~14,400 | High | Best free option overall |
| `groq-llama-3.1-8b` | Very high | Very high | Effectively unlimited for most uses |
| `groq-mixtral` | ~14,400 | High | 32k context window |
| `gemini-2.5-flash` | 250 | 10 | Good balance |
| `gemini-2.5-flash-lite` | 1,000 | 15 | Most generous Gemini option |
| `gemini-2.5-pro` | 100 | 5 | Use for quality-critical tasks only |

### Groq TPM Limit
Groq's free tier has a **12,000 TPM (tokens per minute)** limit. LectureAI handles this automatically:
- Uses 7,000-word chunks (≈ 9k tokens) for all Groq models
- If a 413 "Request too large" error occurs anyway, waits 65 seconds and retries

---

## Deploy to AWS EC2

### Step 1 — Launch EC2 Instance

- **AMI**: Ubuntu 22.04 LTS (free tier eligible)
- **Instance type**: t2.micro (free tier) or t3.small for better performance
- **Security Group**: Open ports **22** (SSH), **80** (HTTP), **443** (HTTPS)

### Step 2 — SSH into your instance

```bash
ssh -i your-key.pem ubuntu@<your-ec2-public-ip>
```

### Step 3 — Install system dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3 python3-pip python3-venv nginx git ffmpeg
```

### Step 4 — Upload your project

From your **local machine**:
```bash
scp -r -i your-key.pem ./App ubuntu@<ec2-ip>:/home/ubuntu/lectureai
```

Or clone from GitHub:
```bash
git clone <your-repo-url> /home/ubuntu/lectureai
```

### Step 5 — Set up Python environment on EC2

```bash
cd /home/ubuntu/lectureai
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
pip install yt-dlp   # ensure yt-dlp is installed for transcript fetching
```

### Step 6 — Configure environment variables

```bash
cp "env.example copy.txt" .env
nano .env
# Set GEMINI_API_KEY=AIzaSy...
# Set GROQ_API_KEY=gsk_...    (optional, enables Groq models)
```

### Step 7 — Test it works

```bash
python app.py
# Should print: Running on http://0.0.0.0:8080
# Press Ctrl+C to stop
```

### Step 8 — Configure Nginx

```bash
sudo cp nginx.conf /etc/nginx/sites-available/lectureai
sudo ln -s /etc/nginx/sites-available/lectureai /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### Step 9 — Set up systemd service (auto-start on reboot)

```bash
sudo cp tubescribe.service /etc/systemd/system/lectureai.service
sudo systemctl daemon-reload
sudo systemctl enable lectureai
sudo systemctl start lectureai
```

Check it's running:
```bash
sudo systemctl status lectureai
```

### Step 10 — Open your app

Go to `http://<your-ec2-public-ip>` in your browser.

---

## Useful Commands (EC2)

```bash
# Check app status
sudo systemctl status lectureai

# View live logs
sudo journalctl -u lectureai -f

# Restart after code changes
sudo systemctl restart lectureai

# Reload Nginx after config changes
sudo systemctl reload nginx

# Update yt-dlp (keeps YouTube compatibility current)
pip install -U yt-dlp
```

---

## Adding HTTPS

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com
```

Certbot auto-renews certificates. You'll need a domain pointed at your EC2 IP via an A record.

---

## Changelog

### April 2026 — Latest

**Bug Fixes:**
- **Fixed Groq 413 TPM errors** — Groq free tier has a 12,000 TPM limit; LectureAI now uses 7,000-word chunks (instead of 20,000) for all Groq models, keeping each request under ~9k tokens. If a 413 is returned anyway (e.g. due to large system prompts), the app waits 65 seconds and retries rather than failing immediately.

**New Features:**
- **Groq Mixtral 8x7B model added** — available in the header model bar, Panel 2 model selector, and Panel 5 audit model selector. Uses `mixtral-8x7b-32768` (32k context window, good for longer content).
- **Animated model selector** — the selected model chip in the header now pulses a purple glow ring (`selectedPulse` animation, 1.8s infinite) making it immediately clear which model is active.
- **Animated brand logos** — the Gemini and Groq labels in the header now display official-style brand logos:
  - **Gemini**: 4-pointed star SVG with purple gradient fill, spinning and scaling (`geminiStarSpin` 6s) + purple breathing glow (`geminiGlow` 2.5s)
  - **Groq**: Stylized G-circle SVG with green gradient fill + green breathing glow (`groqGlow` 2.5s)
- **Groq models added to Coverage Audit panel** — Panel 5 now lists all 3 Groq models (was Gemini-only before).
