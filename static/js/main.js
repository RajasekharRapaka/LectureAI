// ═══════════════════════════════════════════════════════════════════
// LectureAI — main.js
//
// All frontend logic for the LectureAI app.
//
// What this file does:
//   1. Fetches transcripts from the Flask backend (/api/transcript)
//   2. Routes short transcripts to sync processing, long ones to async
//   3. Polls background jobs every 3 seconds and shows a live modal
//   4. Generates notes and articles via /api/process and /api/article
//   5. Downloads content as HTML, Markdown, PDF, DOCX, or plain text
//   6. Runs the coverage audit via /api/verify
//   7. Manages progress bars, step indicators, toasts, and loaders
//
// All API calls go to Flask backend routes — no external API calls here.
// ═══════════════════════════════════════════════════════════════════

"use strict"; // Catch common JS mistakes (e.g., undeclared variables)


// ─────────────────────────────────────────────────────────────────
// SECTION 1: APPLICATION STATE
// These variables hold the current session data.
// They are reset when the user clicks "Start Over".
// ─────────────────────────────────────────────────────────────────

let transcriptContent   = "";     // Raw transcript text
let notesContent        = "";     // Generated Markdown notes
let articleContent      = "";     // Generated HTML or Markdown article
let auditReportContent  = "";     // Coverage audit Markdown report
let videoTitle          = "";     // Video title from YouTube metadata
let currentVideoId      = "";     // 11-char YouTube video ID

// User's currently selected options
let currentTone         = "comprehensive";  // Notes style (from data-tone)
let currentFmt          = "studynotes";     // Article format (from data-fmt)
let currentModel        = "gemini-2.5-flash"; // Default to flash (better free limits)
let currentAuditModel   = "gemini-2.5-flash"; // Gemini model for coverage audit

// Per-request API key (overrides server env var for paid quota users)
// Stored in localStorage so it persists across page refreshes
let currentApiKey       = localStorage.getItem("lectureai_api_key") || "";

// Transcript stats (set after fetch/paste)
let transcriptWordCount = 0;
let chunksNeeded        = 1;

// Must match ASYNC_THRESHOLD_WORDS in app.py
const ASYNC_THRESHOLD   = 12000;

// Background job tracking
let activeJobId         = null;   // Job ID from /api/process/async
let jobPollTimer        = null;   // setInterval handle for job polling
let jobStartTime        = null;   // Date.now() when job started

// Timer handles
let toastTimer          = null;   // setTimeout handle for toast hide

// Runtime config fetched from backend on page load
// Defaults match app.py constants; overwritten by /api/config on load
let serverConfig = {
  model:        "gemini-2.5-flash",
  max_input_k:  700,
  chunk_words:  20000,
  async_threshold_words: 12000,
  has_server_key: false,
  has_groq_key:   false,
};


// ─────────────────────────────────────────────────────────────────
// SECTION 2: INITIALIZATION
// Runs once when the page finishes loading.
// ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const response = await fetch("/api/config");
    if (response.ok) {
      serverConfig = await response.json();
      currentModel      = serverConfig.model;
      currentAuditModel = serverConfig.model;
      updateModelDisplay(serverConfig.model);
      // Sync Panel 2 model selector
      document.querySelectorAll(".model-opt").forEach(el => {
        el.classList.toggle("selected", el.dataset.model === currentModel);
      });
      // Sync header model bar
      document.querySelectorAll(".hm-opt").forEach(el => {
        el.classList.toggle("selected", el.dataset.hmodel === currentModel);
      });
      // Auto-select Groq if server only has Groq key
      if (!serverConfig.has_server_key && serverConfig.has_groq_key && !geminiApiKey) {
        currentModel = "groq-llama-3.3-70b";
        currentAuditModel = "groq-llama-3.3-70b";
        updateModelDisplay(currentModel);
        document.querySelectorAll(".model-opt, .hm-opt").forEach(el => {
          const key = el.dataset.model || el.dataset.hmodel;
          el.classList.toggle("selected", key === currentModel);
        });
      }
      // Warn if truly no keys anywhere
      if (!serverConfig.has_server_key && !serverConfig.has_groq_key && !geminiApiKey && !groqApiKey) {
        showToast("⚠ No API key — click 🔑 API Key to add a free key");
      }
    }
  } catch (err) {
    console.warn("Could not load server config:", err);
  }

  // Migrate legacy single-key to new separate storage
  if (currentApiKey && !geminiApiKey && !groqApiKey) {
    if (currentApiKey.startsWith("gsk_")) { saveGroqKey(currentApiKey); }
    else { saveGeminiKey(currentApiKey); }
  }

  // Restore key statuses in settings panel
  updateApiKeyStatus();

  // Manual transcript textarea
  const manualArea = document.getElementById("manualTranscript");
  if (manualArea) manualArea.addEventListener("input", updateCapacityBar);

  // URL-tab transcript textarea
  const txArea = document.getElementById("transcriptTextarea");
  if (txArea) {
    txArea.addEventListener("input", () => {
      transcriptContent   = txArea.value;
      transcriptWordCount = countWords(txArea.value);
      updateProcessingEstimate();
    });
  }
});


// ─────────────────────────────────────────────────────────────────
// SECTION 3: MODEL DISPLAY
// ─────────────────────────────────────────────────────────────────

/**
 * Update the model name shown in the header pill and panel badges.
 * Called whenever the user selects a different model.
 */
function updateModelDisplay(model) {
  // Update panel badges
  ["badge2", "badge3"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = model;
  });
  // Sync header model bar highlight
  document.querySelectorAll(".hm-opt").forEach(el => {
    el.classList.toggle("selected", el.dataset.hmodel === model);
  });
}


// ─────────────────────────────────────────────────────────────────
// SECTION 3b: API KEY MANAGEMENT
// Separate storage for Gemini and Groq keys.
// Both are kept in localStorage and sent per-request.
// The routing in app.py decides which to use based on model name.
// ─────────────────────────────────────────────────────────────────

let geminiApiKey = localStorage.getItem("lectureai_gemini_key") || "";
let groqApiKey   = localStorage.getItem("lectureai_groq_key")   || "";

// currentApiKey remains for backward compat — dynamically resolved per request
// based on which model is selected (see getActiveApiKey())

/**
 * Return the right API key for the currently selected model.
 * Groq models → groqApiKey, Gemini models → geminiApiKey.
 * Falls back to currentApiKey (legacy single-key field) if set.
 */
function getActiveApiKey() {
  if (currentModel.startsWith("groq-")) {
    return groqApiKey || currentApiKey;
  }
  return geminiApiKey || currentApiKey;
}

function saveGeminiKey(value) {
  geminiApiKey = (value || "").trim();
  if (geminiApiKey) {
    localStorage.setItem("lectureai_gemini_key", geminiApiKey);
  } else {
    localStorage.removeItem("lectureai_gemini_key");
  }
  updateApiKeyStatus();
}

function saveGroqKey(value) {
  groqApiKey = (value || "").trim();
  if (groqApiKey) {
    localStorage.setItem("lectureai_groq_key", groqApiKey);
  } else {
    localStorage.removeItem("lectureai_groq_key");
  }
  updateApiKeyStatus();
}

// Legacy single-key save (kept for backward compat with old localStorage data)
function saveApiKey(value) {
  currentApiKey = (value || "").trim();
  if (currentApiKey) {
    localStorage.setItem("lectureai_api_key", currentApiKey);
    // Migrate to new separate fields based on key prefix
    if (currentApiKey.startsWith("gsk_")) {
      saveGroqKey(currentApiKey);
    } else {
      saveGeminiKey(currentApiKey);
    }
  } else {
    localStorage.removeItem("lectureai_api_key");
  }
}

function clearGeminiKey() {
  geminiApiKey = "";
  localStorage.removeItem("lectureai_gemini_key");
  const el = document.getElementById("geminiKeyInput");
  if (el) el.value = "";
  updateApiKeyStatus();
  showToast("Gemini key cleared");
}

function clearGroqKey() {
  groqApiKey = "";
  localStorage.removeItem("lectureai_groq_key");
  const el = document.getElementById("groqKeyInput");
  if (el) el.value = "";
  updateApiKeyStatus();
  showToast("Groq key cleared");
}

function clearApiKey() {
  clearGeminiKey();
  clearGroqKey();
  currentApiKey = "";
  localStorage.removeItem("lectureai_api_key");
}

function updateApiKeyStatus() {
  // Gemini status
  const gStatusEl = document.getElementById("geminiKeyStatus");
  const gInput    = document.getElementById("geminiKeyInput");
  if (gStatusEl) {
    if (geminiApiKey) {
      gStatusEl.textContent = "✓ Gemini key saved — personal quota active";
      gStatusEl.style.color = "#4ade80";
    } else {
      gStatusEl.textContent = serverConfig.has_server_key ? "Using server key (shared free tier)" : "No key — Gemini models unavailable";
      gStatusEl.style.color = serverConfig.has_server_key ? "#9ca3af" : "#f87171";
    }
    if (gInput && geminiApiKey) gInput.value = geminiApiKey;
  }
  // Groq status
  const qStatusEl = document.getElementById("groqKeyStatus");
  const qInput    = document.getElementById("groqKeyInput");
  if (qStatusEl) {
    if (groqApiKey) {
      qStatusEl.textContent = "✓ Groq key saved — ~14,400 free req/day";
      qStatusEl.style.color = "#4ade80";
    } else {
      qStatusEl.textContent = serverConfig.has_groq_key ? "Using server Groq key (shared)" : "No key — Groq models unavailable";
      qStatusEl.style.color = serverConfig.has_groq_key ? "#9ca3af" : "#f87171";
    }
    if (qInput && groqApiKey) qInput.value = groqApiKey;
  }
  // Update the API Key button to show active state if any key is saved
  const btn = document.getElementById("apiKeyBtn");
  if (btn) {
    const hasAny = !!(geminiApiKey || groqApiKey);
    btn.classList.toggle("active", hasAny);
    btn.textContent = hasAny ? "🔑 Keys Active" : "🔑 API Key";
  }
}

function toggleSettings() {
  const panel = document.getElementById("settingsPanel");
  if (!panel) return;
  const isOpen = panel.style.display !== "none";
  panel.style.display = isOpen ? "none" : "block";
  if (!isOpen) updateApiKeyStatus();
}

function closeSettings() {
  const panel = document.getElementById("settingsPanel");
  if (panel) panel.style.display = "none";
  showToast("API keys saved ✓");
}

/**
 * Select a model from the header model bar.
 * Syncs with the Panel 2 model selector so both stay in sync.
 */
function selectHeaderModel(el) {
  // Update header bar selection
  document.querySelectorAll(".hm-opt").forEach(e => e.classList.remove("selected"));
  el.classList.add("selected");

  currentModel = el.dataset.hmodel;

  // Sync Panel 2 model selector
  document.querySelectorAll(".model-opt").forEach(e => {
    e.classList.toggle("selected", e.dataset.model === currentModel);
  });

  // Update model badge in panels
  updateModelDisplay(currentModel);
  updateProcessingEstimate();
}


// ─────────────────────────────────────────────────────────────────
// SECTION 4: INPUT TAB SWITCHER
// ─────────────────────────────────────────────────────────────────

/**
 * Switch between "YouTube URL", "Playlist", and "Paste Transcript" tabs.
 * @param {string} mode - "url" | "playlist" | "manual"
 */
function switchInputTab(mode) {
  // All three tabs: url, playlist, manual
  ["url", "playlist", "manual"].forEach(m => {
    document.getElementById(`tabBtn-${m}`)?.classList.toggle("active", m === mode);
    document.getElementById(`tab-${m}`)?.classList.toggle("active", m === mode);
  });
}


// ─────────────────────────────────────────────────────────────────
// SECTION 5: URL VALIDATION (client-side, instant)
// ─────────────────────────────────────────────────────────────────

/**
 * Extract an 11-character YouTube video ID from any YouTube URL format.
 * Handles: watch, youtu.be, embed, shorts, or raw ID.
 * Returns null if no valid ID found.
 */
function extractVideoId(rawUrl) {
  const url = rawUrl.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/,  // standard watch URL
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,                        // shortened youtu.be
    /(?:youtube\.com\/(?:embed|shorts|v)\/)([a-zA-Z0-9_-]{11})/, // embed / shorts
    /^([a-zA-Z0-9_-]{11})$/,                                      // raw 11-char ID
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Called on every keystroke in the URL input field.
 * Validates the URL client-side and shows ✓/✗ status instantly
 * without making any network request.
 */
function onUrlInput() {
  const inputEl  = document.getElementById("urlInput");
  const statusEl = document.getElementById("urlStatus");
  const fetchBtn = document.getElementById("fetchBtn");
  const videoCard = document.getElementById("videoCard");
  const errBox   = document.getElementById("fetchError");
  const val      = inputEl.value;

  const videoId = extractVideoId(val);

  if (videoId) {
    // Valid YouTube URL — show green checkmark and enable Fetch button
    statusEl.textContent = "✓ Valid";
    statusEl.className   = "url-status ok";
    fetchBtn.disabled    = false;
    currentVideoId       = videoId;

    // Show video thumbnail immediately (no API call needed — YouTube CDN)
    const thumbEl = document.getElementById("videoThumb");
    thumbEl.src              = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    thumbEl.style.visibility = "visible";

    // Show placeholder metadata until we fetch real title/channel
    document.getElementById("videoTitle").textContent   = "YouTube Video";
    document.getElementById("videoChannel").textContent = "";
    document.getElementById("videoIdBadge").textContent = videoId;
    videoCard.classList.add("visible");

    // Clear any previous error
    errBox.classList.remove("visible");

  } else if (val.length > 5) {
    // Long enough to be a URL attempt but doesn't match — show error
    statusEl.textContent = "✗ Invalid";
    statusEl.className   = "url-status err";
    fetchBtn.disabled    = true;
    videoCard.classList.remove("visible");
    currentVideoId       = "";

  } else {
    // Too short to tell — show neutral state
    statusEl.textContent = "—";
    statusEl.className   = "url-status";
    fetchBtn.disabled    = true;
    videoCard.classList.remove("visible");
    currentVideoId       = "";
  }
}


// ─────────────────────────────────────────────────────────────────
// SECTION 6: TRANSCRIPT FETCH
// ─────────────────────────────────────────────────────────────────

/**
 * Set the visual state of the fetch progress steps (1, 2, 3).
 * Steps before n are marked "done" (green), step n is "active" (amber),
 * steps after n are inactive (grey).
 */
function setFetchStep(stepNumber) {
  for (let i = 1; i <= 3; i++) {
    const el = document.getElementById("ls" + i);
    if (!el) continue;
    el.classList.remove("done", "active");
    if (i < stepNumber)      el.classList.add("done");
    else if (i === stepNumber) el.classList.add("active");
  }
}

/**
 * Fetch the transcript for the current YouTube URL.
 * Calls POST /api/transcript and displays the result.
 *
 * The backend tries three methods in order:
 *   1. yt-dlp (most reliable)
 *   2. youtube-transcript-api
 *   3. Direct page scrape
 */
async function fetchTranscript() {
  const urlValue   = document.getElementById("urlInput").value.trim();
  const fetchBtn   = document.getElementById("fetchBtn");
  const proceedBtn = document.getElementById("proceedBtn");
  const loader     = document.getElementById("fetchLoader");
  const errBox     = document.getElementById("fetchError");
  const preview    = document.getElementById("transcriptPreview");
  const progBar    = document.getElementById("fetchProgressBar");

  // Reset UI state before starting
  fetchBtn.disabled  = true;
  loader.classList.add("visible");
  errBox.classList.remove("visible");
  preview.classList.remove("visible");
  proceedBtn.style.display = "none";

  // Step 1: Connecting to YouTube (instant)
  setFetchStep(1);
  setProgress(progBar, 15);

  try {
    // Step 2: Server is fetching the page and locating captions
    setFetchStep(2);
    setProgress(progBar, 40);

    const response = await fetch("/api/transcript", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: urlValue }),
    });

    // Step 3: Parsing caption data
    setFetchStep(3);
    setProgress(progBar, 80);

    const data = await response.json();

    if (!response.ok) {
      // Server returned an error — show it to the user
      throw new Error(data.error || `Server error ${response.status}`);
    }

    // ── Success ─────────────────────────────────────────────────

    // Store transcript and stats in state
    transcriptContent   = data.transcript;
    transcriptWordCount = data.word_count;
    chunksNeeded        = data.chunks_needed || 1;
    videoTitle          = data.title || "";

    // Update video card with real metadata from YouTube
    if (data.title)   document.getElementById("videoTitle").textContent   = data.title;
    if (data.channel) document.getElementById("videoChannel").textContent = data.channel;

    // Populate the editable textarea with the fetched transcript
    document.getElementById("transcriptTextarea").value = transcriptContent;
    document.getElementById("transcriptStatus").textContent =
      `✓ ${data.word_count.toLocaleString()} words`;

    // Show duration and chunk estimate chips
    const durationChip = document.getElementById("durationChip");
    const chunksChip   = document.getElementById("chunksChip");

    if (data.estimated_hours) {
      durationChip.textContent     = `~${data.estimated_hours}h lecture`;
      durationChip.style.display   = "inline";
    }

    if (chunksNeeded > 1) {
      chunksChip.textContent   = `${chunksNeeded} chunks`;
      chunksChip.style.display = "inline";
    } else {
      chunksChip.style.display = "none";
    }

    // Show the transcript downloads bar (txt download available immediately)
    const dlBar = document.getElementById("transcriptDownloads");
    if (dlBar) dlBar.style.display = "flex";

    // Complete the progress bar and show the transcript
    setProgress(progBar, 100);
    preview.classList.add("visible");
    proceedBtn.style.display = "inline-flex";

    // Pre-calculate and show the processing estimate on the next panel
    updateProcessingEstimate();

    // Refresh step track — step 1 turns green ✓ now that transcript is loaded
    goToPanel(1);

    showToast(`✓ ${data.word_count.toLocaleString()} words loaded`
      + (data.estimated_hours ? ` — ~${data.estimated_hours}h lecture` : ""));

  } catch (err) {
    // ── Failure ──────────────────────────────────────────────────
    setProgress(progBar, 0);
    document.getElementById("fetchErrorMsg").textContent = err.message;
    errBox.classList.add("visible");
    showToast("⚠ " + err.message.substring(0, 80));
    console.error("Transcript fetch error:", err);
  }

  // Always re-enable the fetch button and hide loader
  loader.classList.remove("visible");
  fetchBtn.disabled = false;
}

/**
 * Clear the fetched transcript and reset the input state.
 */
function clearTranscript() {
  document.getElementById("transcriptTextarea").value = "";
  document.getElementById("transcriptPreview").classList.remove("visible");
  document.getElementById("proceedBtn").style.display = "none";
  document.getElementById("durationChip").style.display = "none";
  document.getElementById("chunksChip").style.display   = "none";

  const dlBar = document.getElementById("transcriptDownloads");
  if (dlBar) dlBar.style.display = "none";

  // Reset state variables
  transcriptContent   = "";
  transcriptWordCount = 0;
  chunksNeeded        = 1;
}


// ─────────────────────────────────────────────────────────────────
// SECTION 7: CAPACITY BAR (manual input)
// Shows how much of the Gemini context window the pasted text uses.
// ─────────────────────────────────────────────────────────────────

/**
 * Update the capacity bar shown below the manual transcript textarea.
 * Called on every keystroke while typing in the manual input.
 */
function updateCapacityBar() {
  const text   = document.getElementById("manualTranscript")?.value || "";
  const wc     = countWords(text);
  const maxWc  = serverConfig.max_input_k * 1000;  // e.g. 700,000
  const pct    = Math.min((wc / maxWc) * 100, 100);

  const barWrap = document.getElementById("capacityBarWrap");
  const fill    = document.getElementById("capacityFill");
  const label   = document.getElementById("capacityLabel");

  if (!barWrap) return;

  if (wc > 500) {
    // Show the capacity bar once there's meaningful content
    barWrap.style.display = "block";

    // Color code: green → amber → red based on usage
    if (pct < 60)       fill.style.background = "#4ade80"; // green: plenty of room
    else if (pct < 85)  fill.style.background = "#f59e0b"; // amber: getting full
    else                fill.style.background = "#ef4444"; // red: nearly full

    fill.style.width = pct + "%";

    // Show word count and estimated duration
    const estHours = Math.round(wc / 130 / 60 * 10) / 10;
    label.textContent =
      `${(wc / 1000).toFixed(0)}k / ${serverConfig.max_input_k}k words`
      + (estHours > 0 ? ` — ~${estHours}h lecture` : "");

  } else {
    barWrap.style.display = "none";
  }
}


// ─────────────────────────────────────────────────────────────────
// SECTION 8: NAVIGATION
// ─────────────────────────────────────────────────────────────────

/**
 * Validate the URL tab transcript and navigate to the Notes panel.
 * Reads from the editable textarea (user may have edited the transcript).
 */
function goToNotes() {
  const ta = document.getElementById("transcriptTextarea");
  const t  = (ta?.value || "").trim();

  if (!t) {
    showToast("Please fetch a transcript first.");
    return;
  }

  // Sync textarea back to state (user may have edited)
  transcriptContent   = t;
  transcriptWordCount = countWords(t);
  videoTitle          = document.getElementById("videoTitle")?.textContent || "";

  updateProcessingEstimate();
  goToPanel(2);
}

/**
 * Validate the manual paste tab and navigate to the Notes panel.
 */
function goToNotesManual() {
  const t = (document.getElementById("manualTranscript")?.value || "").trim();

  if (!t) {
    showToast("Please paste a transcript first.");
    return;
  }

  transcriptContent   = t;
  transcriptWordCount = countWords(t);
  videoTitle          = "";  // No video title for manual input

  updateProcessingEstimate();
  goToPanel(2);
}

// Track the highest panel the user has reached — enables forward navigation on step track
let maxPanelReached = 1;

/**
 * Determine the visual state of each step based on content and navigation.
 *
 * Rules (what a real app does):
 *   - Current step  → active (filled purple circle)
 *   - Step has real content generated → done (green ✓), clickable
 *   - Step visited but no content yet → visited (dim purple), clickable
 *   - Step never visited → default (grey), NOT clickable
 *
 * This means steps stay green ✓ when you navigate away, because the
 * content still exists. They only go grey if you Start Over.
 */
function getStepState(stepNum, currentPanel) {
  // Article (Step 3) is OPTIONAL — users can go notes → export directly
  const hasContent = {
    1: !!(transcriptContent || notesContent),  // transcript OR playlist notes
    2: !!notesContent,         // notes generated
    3: !!articleContent,       // article generated (optional)
    4: false,                  // export panel — always just "visited"
    5: false,                  // audit panel — always just "visited"
  };

  if (stepNum === currentPanel)   return "active";
  if (hasContent[stepNum])        return "done";      // green ✓
  if (stepNum <= maxPanelReached) return "visited";   // purple — been here
  return "default";                                   // grey — never visited
}

/**
 * Navigate to a numbered panel and update the step track.
 * @param {number} n - Panel number (1-5)
 */
function goToPanel(n) {
  // Update the furthest panel reached
  if (n > maxPanelReached) maxPanelReached = n;

  // Hide all panels
  for (let i = 1; i <= 5; i++) {
    document.getElementById("panel" + i)?.classList.remove("visible");
  }

  // Update every step's appearance and clickability
  for (let i = 1; i <= 5; i++) {
    const stepEl = document.getElementById("s" + i);
    if (!stepEl) continue;

    const state = getStepState(i, n);
    stepEl.classList.remove("active", "done", "visited");

    if (state === "active") {
      stepEl.classList.add("active");
      stepEl.style.cursor = "default";
      stepEl.onclick = null;
      stepEl.title = "";
    } else if (state === "done") {
      stepEl.classList.add("done");
      stepEl.style.cursor = "pointer";
      stepEl.onclick = (function(p) { return () => goToPanel(p); })(i);
      stepEl.title = i < n ? `Go back to Step ${i}` : `Go to Step ${i}`;
    } else if (state === "visited") {
      stepEl.classList.add("visited");
      stepEl.style.cursor = "pointer";
      stepEl.onclick = (function(p) { return () => goToPanel(p); })(i);
      stepEl.title = `Go to Step ${i}`;
    } else {
      // default — future unvisited
      stepEl.style.cursor = "";
      stepEl.onclick = null;
      stepEl.title = "";
    }
  }

  // Show the target panel with slide-in animation
  document.getElementById("panel" + n)?.classList.add("visible");

  // Special actions when entering specific panels
  if (n === 4) {
    // Article section — show/hide based on whether article was generated
    const articleExportSection = document.querySelector("#panel4 .export-section:nth-child(2)");
    const noArticleHint = document.getElementById("noArticleHint");
    if (articleContent) {
      if (articleExportSection) articleExportSection.style.opacity = "1";
      if (noArticleHint) noArticleHint.style.display = "none";
    } else {
      if (articleExportSection) articleExportSection.style.opacity = "0.5";
      if (noArticleHint) noArticleHint.style.display = "block";
    }
    // Show/hide back-to-article button
    const backToArticleBtn = document.getElementById("backToArticleBtn");
    if (backToArticleBtn) backToArticleBtn.style.display = articleContent ? "inline-flex" : "none";

    // Hide raw transcript export for playlist jobs (no raw transcript available)
    const txExportSection = document.getElementById("transcriptExportSection");
    if (txExportSection) {
      txExportSection.style.display = transcriptContent ? "block" : "none";
    }
  }

  if (n === 5) {
    // Coverage audit panel: show word counts so user knows what's being audited
    const tw = document.getElementById("auditTranscriptWords");
    const nw = document.getElementById("auditNotesWords");
    const twc = countWords(transcriptContent);
    const nwc = countWords(notesContent);
    if (tw) tw.textContent = `Transcript: ${twc.toLocaleString()} words`;
    if (nw) nw.textContent = `Notes: ${nwc.toLocaleString()} words`;
  }

  // Scroll to top so user sees the panel header
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * Reset the entire app to its initial state.
 * Clears all content, resets all state variables.
 */
function startOver() {
  // Clear all text inputs
  ["urlInput", "transcriptTextarea", "manualTranscript"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  // Hide all result areas
  ["notesResult", "articleResult", "auditResult"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });

  // Hide transcript preview and related UI
  document.getElementById("videoCard")?.classList.remove("visible");
  document.getElementById("transcriptPreview")?.classList.remove("visible");
  document.getElementById("fetchError")?.classList.remove("visible");
  document.getElementById("proceedBtn").style.display = "none";
  document.getElementById("fetchBtn").disabled        = true;

  const statusEl = document.getElementById("urlStatus");
  if (statusEl) { statusEl.textContent = "—"; statusEl.className = "url-status"; }

  // Hide processing estimate
  const est = document.getElementById("procEstimate");
  if (est) est.style.display = "none";

  // Hide capacity bar
  const capWrap = document.getElementById("capacityBarWrap");
  if (capWrap) capWrap.style.display = "none";

  // Hide chips
  document.getElementById("durationChip").style.display = "none";
  document.getElementById("chunksChip").style.display   = "none";

  // Reset all state variables
  transcriptContent  = "";
  notesContent       = "";
  articleContent     = "";
  auditReportContent = "";
  videoTitle         = "";
  currentVideoId     = "";
  transcriptWordCount = 0;
  chunksNeeded       = 1;
  activeJobId        = null;
  maxPanelReached    = 1;

  // Cancel any running job poll
  if (jobPollTimer) {
    clearInterval(jobPollTimer);
    jobPollTimer = null;
  }

  // Go back to the input panel
  goToPanel(1);
}


// ─────────────────────────────────────────────────────────────────
// SECTION 9: PROCESSING ESTIMATE
// Shows time/chunk estimates to reduce user anxiety while waiting.
// ─────────────────────────────────────────────────────────────────

/**
 * Calculate and display an estimated processing time based on
 * the transcript word count and selected model.
 * Shown in Panel 2 before the user clicks "Generate Notes".
 */
function updateProcessingEstimate() {
  const wc     = transcriptWordCount || countWords(transcriptContent);
  const estEl  = document.getElementById("procEstimate");
  if (!estEl || !wc) return;

  const CHUNK_WORDS = serverConfig.chunk_words || 20000;
  const chunks      = Math.ceil(wc / CHUNK_WORDS);

  // Speed estimates per model (minutes per chunk)
  const modelSpeeds = {
    "gemini-2.5-pro":         { min: 1.0, max: 2.5,  rpm: 5,   rpd: 100   },
    "gemini-2.5-flash":       { min: 0.4, max: 1.0,  rpm: 10,  rpd: 250   },
    "gemini-2.5-flash-lite":  { min: 0.2, max: 0.6,  rpm: 15,  rpd: 1000  },
    "groq-llama-3.3-70b":     { min: 0.1, max: 0.3,  rpm: 30,  rpd: 14400 },
    "groq-llama-3.1-8b":      { min: 0.05, max: 0.2, rpm: 60,  rpd: 99999 },
    "groq-mixtral":           { min: 0.1, max: 0.3,  rpm: 30,  rpd: 14400 },
  };
  const speed = modelSpeeds[currentModel] || { min: 0.4, max: 1.0, rpm: 10, rpd: 250 };

  const estMinMin = Math.max(1, Math.round(chunks * speed.min));
  const estMinMax = Math.max(2, Math.round(chunks * speed.max));

  function fmtTime(mins) {
    if (mins >= 120) return `~${(mins / 60).toFixed(1)} hrs`;
    if (mins >= 60)  return `~${Math.floor(mins/60)}h ${mins%60}m`;
    return `~${mins} min`;
  }

  const videoHours = (wc / 130 / 60).toFixed(1);
  const keyNote    = currentApiKey ? "✓ Custom key active" : (speed.rpd >= 14000 ? `Groq free: ${speed.rpd.toLocaleString()} req/day` : `Gemini free: ${speed.rpd} req/day`);
  let extra = "";
  if (chunks > 1) {
    extra = chunks > 10
      ? ` ⚡ Very long lecture — runs in background, all content captured.`
      : ` Each chunk processed and merged into one document.`;
  }

  let message;
  if (chunks === 1) {
    message = `${(wc / 1000).toFixed(0)}k words (≈${videoHours}hr video) · 1 API call · est. ${fmtTime(estMinMin)}–${fmtTime(estMinMax)} · ${keyNote}`;
  } else {
    message = `${(wc / 1000).toFixed(0)}k words (≈${videoHours}hr video) · ${chunks} chunks (${chunks} API calls) · est. ${fmtTime(estMinMin)}–${fmtTime(estMinMax)} · ${keyNote}${extra}`;
  }

  estEl.textContent   = message;
  estEl.style.display = "block";
}


// ─────────────────────────────────────────────────────────────────
// SECTION 10: OPTION SELECTORS
// ─────────────────────────────────────────────────────────────────

/**
 * Select a note style tone.
 * @param {HTMLElement} el - The clicked .format-opt element
 */
function selectTone(el) {
  document.querySelectorAll("[data-tone]").forEach(e => e.classList.remove("selected"));
  el.classList.add("selected");
  currentTone = el.dataset.tone;
}

/**
 * Select an article output format.
 * @param {HTMLElement} el - The clicked .format-opt element
 */
function selectFmt(el) {
  document.querySelectorAll("[data-fmt]").forEach(e => e.classList.remove("selected"));
  el.classList.add("selected");
  currentFmt = el.dataset.fmt;
}

/**
 * Select an AI model for notes/article generation.
 * Updates the header pill and processing estimate immediately.
 */
function selectModel(el) {
  document.querySelectorAll(".model-opt").forEach(e => e.classList.remove("selected"));
  el.classList.add("selected");
  currentModel = el.dataset.model;
  // Sync header model bar
  document.querySelectorAll(".hm-opt").forEach(e => {
    e.classList.toggle("selected", e.dataset.hmodel === currentModel);
  });
  updateModelDisplay(currentModel);
  updateProcessingEstimate();
}

/**
 * Select an AI model for the coverage audit.
 */
function selectAuditModel(el) {
  document.querySelectorAll("[data-amodel]").forEach(e => e.classList.remove("selected"));
  el.classList.add("selected");
  currentAuditModel = el.dataset.amodel;
}


// ─────────────────────────────────────────────────────────────────
// SECTION 11: NOTES GENERATION
// Short transcripts are processed synchronously (one HTTP request).
// Long transcripts use async background jobs (avoids browser timeout).
// ─────────────────────────────────────────────────────────────────

/**
 * Entry point for notes generation.
 * Automatically chooses sync or async mode based on word count.
 */
async function runNotes() {
  const wc = countWords(transcriptContent);
  const asyncThreshold = serverConfig.async_threshold_words || ASYNC_THRESHOLD;

  if (wc > asyncThreshold) {
    await runNotesAsync();
  } else {
    await runNotesSync();
  }
}

/**
 * Synchronous notes generation — waits for the API response.
 * Used for transcripts <= 25,000 words (~3-hour lecture).
 */
async function runNotesSync() {
  const btn        = document.getElementById("notesBtn");
  const loader     = document.getElementById("notesLoader");
  const loaderText = document.getElementById("notesLoaderText");
  const progLabel  = document.getElementById("notesProgressLabel");
  const progBar    = document.getElementById("notesProgressBar");

  // Show loader and disable button while processing
  btn.disabled    = true;
  loader.classList.add("visible");
  document.getElementById("notesResult").style.display = "none";

  const wc     = countWords(transcriptContent);
  const CHUNK_WORDS = serverConfig.chunk_words || 20000;
  const chunks = Math.ceil(wc / CHUNK_WORDS);
  const isFlash = currentModel.includes("flash");
  const minPerChunk = isFlash ? 0.5 : 1.2;
  const estMins = Math.max(1, Math.round(chunks * minPerChunk));

  const toneLabels = {
    comprehensive: "comprehensive notes",
    notes: "structured notes",
    bullet: "bullet point summary",
    detailed: "detailed summary",
    concise: "quick summary",
    executive: "executive summary",
  };
  const toneLabel = toneLabels[currentTone] || currentTone;

  // Update loader text with realistic time estimate
  loaderText.textContent = chunks > 1
    ? `Processing ${chunks} chunks — est. ~${estMins} min…`
    : `Generating ${toneLabel}…`;
  progLabel.textContent  = "Sending transcript to Gemini…";

  // Animate progress bar to show activity
  // We can't know exact progress for sync calls, so animate smoothly
  setProgress(progBar, 10);
  const progSimulator = animateIndeterminateProgress(progBar, 10, 85, 90000);

  try {
    const response = await fetch("/api/process", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        transcript: transcriptContent,
        mode:       "notes",
        format:     currentTone,
        title:      videoTitle,
        model:      currentModel,
        api_key:    getActiveApiKey(),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Server error ${response.status}`);
    }

    // Complete the progress bar
    clearInterval(progSimulator);
    setProgress(progBar, 100);
    progLabel.textContent = "Done!";

    // Display the generated notes
    displayNotesResult(data);

  } catch (err) {
    clearInterval(progSimulator);
    setProgress(progBar, 0);
    progLabel.textContent = "Failed.";
    showToast("⚠ " + err.message.substring(0, 100));
    console.error("Notes sync error:", err);
  }

  btn.disabled = false;
  loader.classList.remove("visible");
}

/**
 * Asynchronous notes generation — starts a background job and polls.
 * Used for transcripts > 25,000 words (avoids browser timeout).
 */
async function runNotesAsync() {
  const btn = document.getElementById("notesBtn");
  btn.disabled = true;

  try {
    // Start the background job — server returns a job_id immediately
    const response = await fetch("/api/process/async", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        transcript: transcriptContent,
        mode:       "notes",
        format:     currentTone,
        title:      videoTitle,
        model:      currentModel,
        api_key:    getActiveApiKey(),
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);

    // Store job ID and show the progress modal
    activeJobId  = data.job_id;
    jobStartTime = Date.now();

    showJobModal(data);

    // Start polling every 3 seconds for job progress
    startJobPolling(data.job_id);

  } catch (err) {
    showToast("⚠ " + err.message.substring(0, 100));
    console.error("Async notes error:", err);
    btn.disabled = false;
  }
}

/**
 * Display the finished notes result in Panel 2.
 * Called by both sync and async completion paths.
 * @param {Object} data - Response from /api/process or /api/job/<id>
 */
function displayNotesResult(data) {
  // Store generated notes in state
  notesContent = data.content || "";

  // For playlist jobs: transcriptContent is empty. Store notes so article/export/audit work.
  // (Article generation will use notesContent as source when transcriptContent is empty)
  if (!transcriptContent && notesContent) {
    // Don't overwrite transcriptContent for single-video jobs
    // For playlist jobs, the "source" shown in panel 5 word count will be notes
  }

  // Render Markdown to HTML for the preview
  const notesEl = document.getElementById("notesContent");
  if (notesEl) notesEl.innerHTML = markdownToHTML(notesContent);

  // Show metadata line above the notes
  const metaEl = document.getElementById("notesMeta");
  if (metaEl) {
    const parts = [
      `<span class="tag">${data.model_used || currentModel}</span>`,
      `${((data.words_in || 0) / 1000).toFixed(0)}k words in`,
      data.chunks > 1 ? `${data.chunks} chunks merged` : "single pass",
      `${((data.words_out || countWords(notesContent)) / 1000).toFixed(0)}k words output`,
    ].filter(Boolean);
    metaEl.innerHTML = parts.join(" · ");
  }

  // Build the stats row (numbers shown below the notes)
  buildStatsRow("notesStats", [
    { val: ((data.words_in || 0) / 1000).toFixed(0) + "k", label: "Words In"    },
    { val: ((data.words_out || countWords(notesContent)) / 1000).toFixed(0) + "k", label: "Notes Size" },
    { val: data.chunks || 1,                                label: "Chunks"      },
    { val: (data.model_used || currentModel).includes("pro") ? "Pro" : "Flash",   label: "Model"       },
  ]);

  // Show the result
  document.getElementById("notesResult").style.display = "block";

  // Refresh step track so step 2 turns green ✓ immediately
  goToPanel(2);

  showToast("✓ Notes generated successfully!");
}


// ─────────────────────────────────────────────────────────────────
// SECTION 12: ASYNC JOB MODAL
// Shown for long lectures. Polls /api/job/<id> every 3 seconds.
// ─────────────────────────────────────────────────────────────────

/**
 * Show the job progress modal with initial information.
 * @param {Object} jobData - Response from /api/process/async
 */
function showJobModal(jobData) {
  const modal     = document.getElementById("jobModal");
  const chunksEl  = document.getElementById("jobChunks");
  const logEl     = document.getElementById("jobLog");
  const barEl     = document.getElementById("jobBar");
  const etaEl     = document.getElementById("jobEta");

  const total     = jobData.chunks_total || 0;
  const estMin    = jobData.estimated_min || 1;
  const estMax    = jobData.estimated_max || estMin * 2;
  const isPlaylist = total > 10;  // playlist jobs typically have many "chunks" (=videos)

  // Reset modal to initial state
  if (chunksEl) {
    if (isPlaylist) {
      chunksEl.textContent = `Processing ${total} videos · Est. ${estMin}–${estMax} minutes`;
    } else {
      chunksEl.textContent = total > 1
        ? `${total} chunk${total > 1 ? "s" : ""} to process · Est. ${estMin}–${estMax} minutes`
        : `Est. ${estMin}–${estMax} minutes`;
    }
  }
  if (logEl)    logEl.textContent = "Starting…";
  if (barEl)    barEl.style.width = "2%";
  if (etaEl)    etaEl.textContent = "Preparing…";

  modal.style.display = "flex";
}

/**
 * Start polling the job status endpoint every 3 seconds.
 * Updates the progress modal with live log messages and progress bar.
 */
function startJobPolling(jobId) {
  let lastLogLength = 0;

  jobPollTimer = setInterval(async () => {
    try {
      const response = await fetch(`/api/job/${jobId}`);
      if (!response.ok) return;
      const data = await response.json();

      // ── Update log ────────────────────────────────────────────
      const logEl = document.getElementById("jobLog");
      if (logEl && data.progress.length > lastLogLength) {
        logEl.textContent  = data.progress.join("\n");
        logEl.scrollTop    = logEl.scrollHeight;
        lastLogLength      = data.progress.length;
      }

      // ── Update progress bar ───────────────────────────────────
      const barEl = document.getElementById("jobBar");
      const etaEl = document.getElementById("jobEta");

      if (barEl) {
        // Use the server-reported percent directly (it's accurate)
        const pct = data.status === "done" ? 100 : Math.max(2, data.percent || 0);
        barEl.style.width    = pct + "%";
        barEl.style.transition = "width 0.8s ease";

        // Build ETA string
        const elapsedMs  = Date.now() - (jobStartTime || Date.now());
        const elapsedMin = Math.floor(elapsedMs / 60000);
        const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
        const elapsedStr = elapsedMin > 0
          ? `${elapsedMin}m ${elapsedSec}s elapsed`
          : `${elapsedSec}s elapsed`;

        if (etaEl) {
          if (data.chunks_total > 0 && pct > 5 && pct < 100) {
            // Estimate remaining time based on actual elapsed vs percent done
            const totalEstMs  = (elapsedMs / pct) * 100;
            const remainingMs = Math.max(0, totalEstMs - elapsedMs);
            const remMin      = Math.floor(remainingMs / 60000);
            const remSec      = Math.floor((remainingMs % 60000) / 1000);
            const remStr      = remMin > 0 ? `~${remMin}m ${remSec}s left` : `~${remSec}s left`;
            etaEl.textContent = `${pct}% · ${elapsedStr} · ${remStr}`;
          } else if (data.status === "done") {
            etaEl.textContent = `✓ Complete in ${elapsedStr}`;
          } else {
            etaEl.textContent = elapsedStr;
          }
        }
      }

      // ── Handle completion ─────────────────────────────────────
      if (data.status === "done") {
        clearInterval(jobPollTimer);
        jobPollTimer = null;

        if (barEl) barEl.style.width = "100%";

        document.getElementById("jobModal").style.display = "none";
        document.getElementById("notesBtn").disabled      = false;
        document.getElementById("articleBtn").disabled    = false;

        const activePanel = document.querySelector(".panel.visible")?.id;
        if (activePanel === "panel3") {
          displayArticleResult(data.result);
          showToast("✓ Article generated!");
        } else {
          displayNotesResult(data.result);
          showToast("✓ Notes generated!");
        }

        fetch(`/api/job/${jobId}`, { method: "DELETE" }).catch(() => {});

      } else if (data.status === "error") {
        clearInterval(jobPollTimer);
        jobPollTimer = null;

        document.getElementById("jobModal").style.display = "none";
        document.getElementById("notesBtn").disabled      = false;
        document.getElementById("articleBtn").disabled    = false;

        const errMsg = data.error || "Unknown error";
        showToast("⚠ Job failed: " + errMsg.substring(0, 80));
        console.error("Background job failed:", data.error);
      }

    } catch (pollErr) {
      // Network error during poll — non-fatal, will retry next interval
      console.warn("Job poll error:", pollErr);
    }
  }, 3000);  // poll every 3 seconds
}

/**
 * Close the job modal without cancelling the background job.
 * The job continues running on the server; user can't retrieve results
 * after closing (single-session app, no persistence).
 */
function cancelJobPoll() {
  clearInterval(jobPollTimer);
  jobPollTimer = null;
  document.getElementById("jobModal").style.display = "none";
  document.getElementById("notesBtn").disabled      = false;
  document.getElementById("articleBtn").disabled    = false;
  showToast("Modal closed. Processing may still be running in the background.");
}


// ─────────────────────────────────────────────────────────────────
// SECTION 13: ARTICLE GENERATION
// ─────────────────────────────────────────────────────────────────

/**
 * Generate a formatted article from the notes and transcript.
 * Calls POST /api/article and renders the result in Panel 3.
 *
 * Uses notes as the primary source (if available) and transcript
 * for additional context. Falls back to transcript if no notes.
 */
async function runArticle() {
  const btn        = document.getElementById("articleBtn");
  const loader     = document.getElementById("artLoader");
  const loaderText = document.getElementById("artLoaderText");
  const progBar    = document.getElementById("artProgressBar");
  const progLabel  = document.getElementById("artProgressLabel");

  // For playlist mode: transcriptContent is empty, but notesContent has the merged notes.
  // Use notes as the source text if transcript is not available.
  const sourceText = transcriptContent || notesContent;
  if (!sourceText) {
    showToast("⚠ Nothing to generate article from — generate notes first.");
    return;
  }

  btn.disabled    = true;
  loader.classList.add("visible");
  document.getElementById("articleResult").style.display = "none";

  const wc = countWords(sourceText);
  const asyncThreshold = serverConfig.async_threshold_words || ASYNC_THRESHOLD;

  loaderText.textContent = "Writing article…";
  progLabel.textContent  = "Sending to Gemini…";
  setProgress(progBar, 15);

  const progSim = animateIndeterminateProgress(progBar, 15, 85, 60000);

  try {
    let data;

    if (wc > asyncThreshold) {
      clearInterval(progSim);
      loader.classList.remove("visible");
      btn.disabled = false;
      await runArticleAsync();
      return;
    }

    // Use transcript if available, otherwise use notes as the source
    const response = await fetch("/api/process", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        transcript: sourceText,
        mode:       "article",
        format:     currentFmt,
        title:      videoTitle,
        model:      currentModel,
        api_key:    getActiveApiKey(),
      }),
    });

    data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);

    clearInterval(progSim);
    setProgress(progBar, 100);
    progLabel.textContent = "Done!";

    // Store and display article
    articleContent = data.content || "";
    displayArticleResult(data);
    showToast("✓ Article generated!");

  } catch (err) {
    clearInterval(progSim);
    setProgress(progBar, 0);
    progLabel.textContent = "Failed.";
    showToast("⚠ " + err.message.substring(0, 100));
    console.error("Article error:", err);
  }

  btn.disabled = false;
  loader.classList.remove("visible");
}

/**
 * Async article generation for long transcripts.
 */
async function runArticleAsync() {
  const btn = document.getElementById("articleBtn");
  btn.disabled = true;

  const sourceText = transcriptContent || notesContent;
  if (!sourceText) {
    showToast("⚠ Nothing to generate article from.");
    btn.disabled = false;
    return;
  }

  try {
    const response = await fetch("/api/process/async", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        transcript: sourceText,
        mode:       "article",
        format:     currentFmt,
        title:      videoTitle,
        model:      currentModel,
        api_key:    getActiveApiKey(),
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);

    activeJobId  = data.job_id;
    jobStartTime = Date.now();

    showJobModal(data);
    startJobPolling(data.job_id);

  } catch (err) {
    showToast("⚠ " + err.message.substring(0, 100));
    console.error("Async article error:", err);
    btn.disabled = false;
  }
}

/**
 * Display a finished article result in Panel 3.
 */
function displayArticleResult(data) {
  articleContent = data.content || data.article || "";

  const previewEl = document.getElementById("tabPreview");
  if (previewEl) {
    if (currentFmt === "markdown") {
      previewEl.innerHTML = markdownToHTML(articleContent);
    } else {
      previewEl.innerHTML = articleContent;
    }
  }

  const sourceEl = document.getElementById("tabSource");
  if (sourceEl) sourceEl.textContent = articleContent;

  const metaEl = document.getElementById("articleMeta");
  if (metaEl) {
    const wIn  = data.words_in  ? `${((data.words_in)  / 1000).toFixed(0)}k words in`  : "";
    const wOut = data.words_out ? `${((data.words_out) / 1000).toFixed(0)}k words out` : "";
    metaEl.innerHTML =
      `<span class="tag">${data.model_used || currentModel}</span> · ${currentFmt} format` +
      (wIn ? ` · ${wIn}` : "") + (wOut ? ` · ${wOut}` : "");
  }

  document.getElementById("articleResult").style.display = "block";
  switchArticleTab("preview");

  // Refresh step track so step 3 turns green ✓ immediately
  goToPanel(3);
}

/**
 * Switch between Preview and Source tabs in the article result.
 * @param {string} tab - "preview" or "source"
 */
function switchArticleTab(tab) {
  document.querySelectorAll(".tab").forEach((el, i) =>
    el.classList.toggle("active",
      (i === 0 && tab === "preview") ||
      (i === 1 && tab === "source")
    )
  );
  document.getElementById("tabPreview").style.display = tab === "preview" ? "block" : "none";
  document.getElementById("tabSource").style.display  = tab === "source"  ? "block" : "none";
}

// Alias for the onclick handlers in HTML
const switchTab = switchArticleTab;


// ─────────────────────────────────────────────────────────────────
// SECTION 14: COVERAGE AUDIT
// ─────────────────────────────────────────────────────────────────

/**
 * Run the coverage audit — asks Gemini to verify notes against transcript.
 * Calls POST /api/verify and displays a structured Markdown report.
 */
async function runAudit() {
  // For playlist mode, transcriptContent is empty — audit notes against themselves
  // (checks internal consistency and completeness signals)
  const auditTranscript = transcriptContent || notesContent;
  if (!auditTranscript) { showToast("No content — go back to Step 1."); return; }
  if (!notesContent)     { showToast("Generate notes first (Step 2)."); return; }

  const btn     = document.getElementById("auditBtn");
  const loader  = document.getElementById("auditLoader");
  const progBar = document.getElementById("auditProgressBar");

  btn.disabled    = true;
  loader.classList.add("visible");
  document.getElementById("auditResult").style.display = "none";

  const progSim = animateIndeterminateProgress(progBar, 5, 90, 90000);

  try {
    const response = await fetch("/api/verify", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        transcript: auditTranscript,
        notes:      notesContent,
        model:      currentAuditModel,
        api_key:    getActiveApiKey(),
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);

    clearInterval(progSim);
    setProgress(progBar, 100);

    // Store audit report
    auditReportContent = data.report || "";

    // Parse the verdict from the report text to color-code the score badge
    const report  = auditReportContent;
    const scoreEl = document.getElementById("coverageScore");
    if (scoreEl) {
      let verdictText = "Audit complete";
      let verdictClass = "";

      if (/COMPREHENSIVE/i.test(report)) {
        verdictText  = "✅ COMPREHENSIVE — Notes cover >90% of the lecture";
        verdictClass = "great";
      } else if (/\bGOOD\b/i.test(report)) {
        verdictText  = "✓ GOOD — Notes cover 75-90% of the lecture";
        verdictClass = "good";
      } else if (/INCOMPLETE/i.test(report)) {
        verdictText  = "⚠ INCOMPLETE — 50-75% covered, gaps identified";
        verdictClass = "good";
      } else if (/INADEQUATE/i.test(report)) {
        verdictText  = "❌ INADEQUATE — <50% covered, regeneration needed";
        verdictClass = "poor";
      }

      // Try to extract the numeric percentage if present in the report
      const percentMatch = report.match(/(\d{1,3})\s*(?:out of 25|%)\s*(?:covered|coverage)/i);
      if (percentMatch) {
        const num = parseInt(percentMatch[1], 10);
        if (num <= 25) {
          // It's "X out of 25" — convert to percentage
          verdictText = verdictText.split("—")[0] + `— ${Math.round(num / 25 * 100)}% covered`;
        }
      }

      scoreEl.textContent = verdictText;
      scoreEl.className   = `coverage-score ${verdictClass}`;
    }

    // Render audit report as Markdown
    const auditEl = document.getElementById("auditContent");
    if (auditEl) auditEl.innerHTML = markdownToHTML(auditReportContent);

    document.getElementById("auditResult").style.display = "block";
    showToast("✓ Audit complete");

  } catch (err) {
    clearInterval(progSim);
    setProgress(progBar, 0);
    showToast("⚠ Audit failed: " + err.message.substring(0, 80));
    console.error("Audit error:", err);
  }

  btn.disabled = false;
  loader.classList.remove("visible");
}


// ─────────────────────────────────────────────────────────────────
// SECTION 15: DOWNLOAD FUNCTIONS
// ─────────────────────────────────────────────────────────────────

/**
 * Download the current transcript as a plain text file.
 * Available immediately after transcript is fetched.
 */
function downloadCurrentTranscript(format) {
  if (!transcriptContent) { showToast("No transcript loaded."); return; }
  const filename = safeFilename(videoTitle || "transcript") + ".txt";
  saveTextFile(filename, transcriptContent, "text/plain");
}

/**
 * Download the generated notes in the specified format.
 * Available after notes are generated in Panel 2.
 *
 * For PDF and DOCX, sends a request to the Flask backend which
 * uses WeasyPrint or python-docx to generate the file.
 *
 * @param {string} fmt - "md" | "txt" | "pdf" | "docx"
 */
async function downloadNotesAs(fmt) {
  if (!notesContent) { showToast("Generate notes first."); return; }

  const title    = videoTitle || "Lecture Notes";
  const filename = safeFilename(title) + "-notes";

  if (fmt === "md") {
    // Markdown: notes are already in Markdown format
    saveTextFile(filename + ".md", notesContent, "text/markdown");

  } else if (fmt === "txt") {
    // Plain text: strip all Markdown formatting
    saveTextFile(filename + ".txt", stripMarkdown(notesContent), "text/plain");

  } else if (fmt === "pdf") {
    // PDF: convert Markdown → HTML → PDF on the server
    await downloadFromServer("/api/export/pdf", {
      content:  notesContent,
      title:    title,
      is_html:  false,  // content is Markdown, server will convert
    }, filename + ".pdf", "application/pdf");

  } else if (fmt === "docx") {
    // DOCX: convert Markdown → Word document on the server
    await downloadFromServer("/api/export/docx", {
      content:     notesContent,
      title:       title,
      is_markdown: true,
    }, filename + ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  }
}

/**
 * Download the generated article in the specified format.
 * Available after the article is generated in Panel 3.
 *
 * @param {string} fmt - "html" | "md" | "pdf" | "docx"
 */
async function downloadArticleAs(fmt) {
  if (!articleContent) { showToast("Generate an article first."); return; }

  const title    = videoTitle || "Article";
  const filename = safeFilename(title) + "-article";
  const isHtml   = currentFmt !== "markdown";  // most formats produce HTML

  if (fmt === "html") {
    // Wrap in a full HTML document with proper styling
    const fullHtml = buildStandaloneHtml(
      isHtml ? articleContent : markdownToHTML(articleContent),
      title
    );
    saveTextFile(filename + ".html", fullHtml, "text/html");

  } else if (fmt === "md") {
    // Markdown: use raw article if already MD, or convert from HTML
    const md = isHtml ? htmlToMarkdown(articleContent) : articleContent;
    saveTextFile(filename + ".md", md, "text/markdown");

  } else if (fmt === "pdf") {
    // PDF: pass HTML content to the server
    const htmlBody = isHtml ? articleContent : markdownToHTML(articleContent);
    await downloadFromServer("/api/export/pdf", {
      content: htmlBody,
      title:   title,
      is_html: true,
    }, filename + ".pdf", "application/pdf");

  } else if (fmt === "docx") {
    // DOCX: pass Markdown (easier for python-docx to parse)
    const md = isHtml ? htmlToMarkdown(articleContent) : articleContent;
    await downloadFromServer("/api/export/docx", {
      content:     md,
      title:       title,
      is_markdown: true,
    }, filename + ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  }
}

/**
 * Download the coverage audit report as Markdown.
 */
function downloadAudit() {
  if (!auditReportContent) { showToast("Run an audit first."); return; }
  const filename = safeFilename(videoTitle || "audit") + "-coverage-report.md";
  saveTextFile(filename, auditReportContent, "text/markdown");
}

/**
 * Send a POST request to a Flask export endpoint and trigger a file download.
 * Used for PDF and DOCX exports which require server-side processing.
 *
 * @param {string} endpoint   - API route, e.g. "/api/export/pdf"
 * @param {Object} payload    - JSON body to send
 * @param {string} filename   - Desired download filename
 * @param {string} mimeType   - MIME type for the downloaded file
 */
async function downloadFromServer(endpoint, payload, filename, mimeType) {
  showToast("Preparing download…");

  try {
    const response = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });

    if (!response.ok) {
      // Parse error message from server if available
      let errMsg = `Server error ${response.status}`;
      try {
        const errData = await response.json();
        errMsg = errData.error || errMsg;
      } catch (_) {}
      throw new Error(errMsg);
    }

    // Get the binary data as a Blob
    const blob = await response.blob();

    // Create a temporary link and click it to trigger download
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Release the object URL to free memory
    URL.revokeObjectURL(url);

    showToast("↓ Downloaded " + filename);

  } catch (err) {
    showToast("⚠ Download failed: " + err.message.substring(0, 80));
    console.error("Download error:", err);
  }
}

/**
 * Save a text string as a file download (client-side, no server needed).
 * @param {string} filename  - Download filename
 * @param {string} content   - Text content to save
 * @param {string} mimeType  - MIME type
 */
function saveTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType + ";charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("↓ Downloaded " + filename);
}


// ─────────────────────────────────────────────────────────────────
// SECTION 16: MARKDOWN / HTML CONVERSION
// ─────────────────────────────────────────────────────────────────

/**
 * Convert a Markdown string to HTML for rendering in the browser.
 * Handles: headings, blockquotes, lists, code blocks, inline formatting.
 *
 * NOTE: This is a simple regex-based converter for display only.
 * It is NOT a full CommonMark-compliant parser. Complex Markdown
 * like nested lists may not render perfectly.
 */
function markdownToHTML(md) {
  if (!md) return "";

  // Step 1: Protect fenced code blocks first
  // (so inline rules don't corrupt code content)
  const codeBlocks = [];
  let result = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.trim());
    const idx     = codeBlocks.push(`<pre><code class="language-${lang || 'text'}">${escaped}</code></pre>`) - 1;
    return `%%CODE_BLOCK_${idx}%%`;
  });

  // Step 2: Headings (## must come before # to avoid double-matching)
  result = result
    .replace(/^#### (.+)$/gm,  "<h4>$1</h4>")
    .replace(/^### (.+)$/gm,   "<h3>$1</h3>")
    .replace(/^## (.+)$/gm,    "<h2>$1</h2>")
    .replace(/^# (.+)$/gm,     "<h1>$1</h1>")
    .replace(/^> (.+)$/gm,     "<blockquote>$1</blockquote>")
    .replace(/^[\*\-] (.+)$/gm,"<li>$1</li>")
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // Step 3: Inline formatting (bold before italic to avoid conflicts)
  result = result
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,     "<em>$1</em>")
    .replace(/`([^`]+)`/g,     "<code>$1</code>");

  // Step 4: Wrap consecutive <li> tags in <ul>
  result = result.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

  // Step 5: Wrap plain text paragraphs (blocks separated by blank lines)
  result = result.split(/\n{2,}/).map(block => {
    block = block.trim();
    if (!block) return "";
    // Don't wrap blocks that are already HTML elements
    if (/^<(h[1-6]|ul|ol|li|blockquote|pre|%%CODE)/.test(block)) return block;
    return `<p>${block}</p>`;
  }).join("\n");

  // Step 6: Restore code blocks
  codeBlocks.forEach((html, i) => {
    result = result.replace(`%%CODE_BLOCK_${i}%%`, html);
  });

  return result;
}

/**
 * Convert HTML back to Markdown (approximate conversion for export).
 * Used when the user requests a Markdown download of an HTML article.
 */
function htmlToMarkdown(htmlStr) {
  return htmlStr
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi,         "# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi,         "## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi,         "### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi,         "#### $1\n")
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, "> $1\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi,         "- $1\n")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi,         "*$1*")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi,     "`$1`")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi,           "$1\n\n")
    .replace(/<[^>]+>/g,  "")       // strip remaining tags
    .replace(/\n{3,}/g,   "\n\n")   // collapse excess blank lines
    .trim();
}

/**
 * Strip Markdown formatting to get plain text.
 * Used for .txt downloads.
 */
function stripMarkdown(md) {
  return md
    .replace(/#{1,6} /g,     "")   // headings
    .replace(/\*\*(.+?)\*\*/g, "$1")  // bold
    .replace(/\*(.+?)\*/g,   "$1")    // italic
    .replace(/`(.+?)`/g,     "$1")    // inline code
    .replace(/^> /gm,        "")      // blockquotes
    .replace(/^[-*] /gm,     "• ")    // unordered lists
    .replace(/^\d+\. /gm,    "")      // ordered lists
    .replace(/```[\s\S]*?```/g, "")   // code blocks
    .trim();
}

/**
 * Wrap an HTML fragment in a complete, styled HTML document.
 * Used for the "Download as HTML" option.
 */
function buildStandaloneHtml(bodyHtml, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    /* ── Document styles ── */
    body {
      font-family: Georgia, serif;
      max-width: 800px;
      margin: 3rem auto;
      padding: 0 1.5rem 4rem;
      line-height: 1.78;
      color: #1a1a1a;
      font-size: 16px;
    }
    h1 { font-size: 2rem; margin-bottom: 0.4rem; line-height: 1.2; }
    h2 { font-size: 1.3rem; margin: 2rem 0 0.6rem; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.3rem; }
    h3 { font-size: 1.05rem; margin: 1.25rem 0 0.4rem; }
    h4 { font-size: 0.95rem; font-weight: 700; margin: 1rem 0 0.3rem; }
    p  { margin-bottom: 0.85rem; }
    .meta { color: #888; font-size: 0.82rem; font-family: monospace; margin-bottom: 2rem;
            padding-bottom: 1rem; border-bottom: 1px solid #e5e5e5; }
    blockquote { border-left: 3px solid #6c63ff; padding: 0.4rem 1rem; margin: 1rem 0;
                 color: #555; font-style: italic; background: #f4f3ff; }
    ul, ol { padding-left: 1.5rem; margin: 0.4rem 0 0.85rem; }
    li     { margin-bottom: 0.3rem; }
    dt     { font-weight: 700; margin-top: 0.5rem; }
    dd     { margin-left: 1.25rem; color: #444; }
    code   { background: #f3f4f6; font-family: monospace; font-size: 0.85em;
             padding: 0.1em 0.35em; border-radius: 3px; }
    pre    { background: #1a1a2e; color: #e2e8f0; padding: 1rem; border-radius: 6px;
             overflow-x: auto; margin: 0.75rem 0; }
    pre code { background: none; color: inherit; font-size: 0.85em; }
    strong { font-weight: 700; }
    @media print {
      body { max-width: 100%; margin: 1rem; }
      pre  { white-space: pre-wrap; }
    }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Escape HTML special characters to prevent XSS when inserting into HTML.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


// ─────────────────────────────────────────────────────────────────
// SECTION 17: PROGRESS BAR UTILITIES
// ─────────────────────────────────────────────────────────────────

/**
 * Set a progress bar element to a specific percentage.
 * @param {HTMLElement|null} barEl - The .progress-bar element
 * @param {number} pct - Percentage (0-100)
 */
function setProgress(barEl, pct) {
  if (!barEl) return;
  barEl.style.width = Math.min(100, Math.max(0, pct)) + "%";
}

/**
 * Animate a progress bar from startPct toward endPct over durationMs.
 * This simulates progress for API calls where we don't know the real %
 * (like a single Gemini call that takes 30-120 seconds).
 *
 * The animation slows down as it approaches endPct, so it never
 * "stalls" at 100% before the real response arrives.
 *
 * Returns the setInterval handle so caller can clearInterval on completion.
 *
 * @param {HTMLElement|null} barEl     - Progress bar element
 * @param {number}           startPct  - Starting percentage
 * @param {number}           endPct    - Target percentage (never exceeds this)
 * @param {number}           durationMs - Total simulated duration
 */
function animateIndeterminateProgress(barEl, startPct, endPct, durationMs) {
  if (!barEl) return null;

  let current = startPct;
  const range = endPct - startPct;

  const timer = setInterval(() => {
    // Move faster at start, slower near the end (ease-out effect)
    const remaining  = endPct - current;
    const step       = Math.max(0.1, remaining * 0.02);  // 2% of remaining
    current          = Math.min(endPct, current + step);
    barEl.style.width = current + "%";

    // Stop if we've reached the target
    if (current >= endPct) clearInterval(timer);
  }, durationMs / 200);  // ~200 updates over the duration

  return timer;
}


// ─────────────────────────────────────────────────────────────────
// SECTION 18: UI HELPERS
// ─────────────────────────────────────────────────────────────────

/**
 * Count words in a string.
 * @returns {number} Word count, or 0 for empty strings
 */
function countWords(text) {
  if (!text || !text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * Create a safe filename from an arbitrary title string.
 * Removes special characters, replaces spaces with hyphens.
 */
function safeFilename(title) {
  return (title || "file")
    .replace(/[^a-zA-Z0-9\s\-_]/g, "")   // keep alphanumeric, space, hyphen, underscore
    .replace(/\s+/g, "-")                  // spaces → hyphens
    .substring(0, 60)                      // max 60 chars
    .toLowerCase()
    .replace(/^-+|-+$/g, "")              // trim leading/trailing hyphens
    || "file";                             // fallback if everything was stripped
}

/**
 * Build the stats row (word count, chunks, model) shown below notes.
 * @param {string}  containerId - ID of the .stats-row element
 * @param {Array}   items       - Array of { val, label } objects
 */
function buildStatsRow(containerId, items) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = items.map(({ val, label }) =>
    `<div class="stat">` +
      `<span class="stat-val">${val}</span>` +
      `<span class="stat-label">${label}</span>` +
    `</div>`
  ).join("");
}

/**
 * Copy an element's text content to the clipboard.
 * Shows a toast on success or failure.
 * @param {string} elementId - ID of the element to copy
 */
function copyEl(elementId) {
  const el   = document.getElementById(elementId);
  const text = (el?.innerText || el?.textContent || "").trim();

  if (!text) { showToast("Nothing to copy."); return; }

  navigator.clipboard.writeText(text)
    .then(() => showToast("Copied to clipboard"))
    .catch(() => showToast("Copy failed — please select text manually"));
}

/**
 * Copy the raw article source (HTML or Markdown) to the clipboard.
 */
function copyArticleSource() {
  if (!articleContent) { showToast("No article generated yet."); return; }
  navigator.clipboard.writeText(articleContent)
    .then(() => showToast("Source copied"))
    .catch(() => showToast("Copy failed"));
}

/**
 * Show a toast notification message in the bottom-right corner.
 * Automatically hides after 3 seconds.
 * If a toast is already showing, it replaces it.
 * @param {string} message - Message to display
 */
function showToast(message) {
  const el = document.getElementById("toast");
  if (!el) return;

  el.textContent = message;
  el.classList.add("show");

  // Clear any existing hide timer and set a new one
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}


// ─────────────────────────────────────────────────────────────────
// SECTION 19: SAMPLE TRANSCRIPT
// ─────────────────────────────────────────────────────────────────

/**
 * Load a sample lecture transcript into the manual paste textarea.
 * Useful for testing the app without a real YouTube URL.
 */
function loadSample() {
  const sampleText =
`Welcome everyone. Today's lecture covers the neuroscience of sleep and why it
may be the single most important biological process for human cognitive performance.

Sleep architecture: Sleep is not a monolithic state. It cycles through distinct
phases roughly every 90 minutes. Non-REM sleep includes light sleep (N1, N2)
and slow-wave deep sleep (N3). REM sleep stands for Rapid Eye Movement.

During slow-wave deep sleep (N3), the glymphatic system activates. Cerebrospinal
fluid is pumped through channels surrounding neurons, flushing out metabolic
byproducts — crucially amyloid-beta and tau proteins, both strongly implicated
in Alzheimer's disease. Dr. Maiken Nedergaard's lab at the University of
Rochester showed this glymphatic activity increases tenfold during deep sleep.

Memory consolidation: During both deep sleep and REM, the hippocampus replays
experiences from the day in a process called synaptic homeostasis. Declarative
memories transfer to the neocortex for long-term storage. Sleep-deprived subjects
retain roughly 40% less new information compared to well-rested controls.

REM sleep increases in proportion during the later part of the night. The
prefrontal cortex partially disengages, allowing distant neural associations
that support creative problem-solving and emotional regulation.

Optimal duration: Meta-analyses consistently show 7-9 hours for adults.
Chronic short sleep below 6 hours associates with elevated cortisol, impaired
glucose metabolism, suppressed immune function, and 40% elevated cardiovascular
risk in longitudinal studies. Sleep debt cannot be fully repaid on weekends.

Three practical interventions: First, maintain a consistent sleep-wake schedule
including weekends — circadian rhythm stability predicts sleep quality more
than total hours. Second, keep bedroom temperature below 18°C (64°F) — core
body temperature must drop 1-2°C for sleep onset. Third, eliminate blue-spectrum
light 90 minutes before bed to preserve melatonin onset timing.`;

  const textarea = document.getElementById("manualTranscript");
  if (textarea) {
    textarea.value = sampleText;
    updateCapacityBar();  // Update the word count display
  }
}


// ─────────────────────────────────────────────────────────────────
// SECTION 20: PLAYLIST SUPPORT
// Handles loading playlist info and starting course notes generation.
// ─────────────────────────────────────────────────────────────────

// Stores playlist info fetched from the server
let playlistData = null;
// Playlist-specific tone (separate from single-video tone)
let playlistTone = "comprehensive";

/**
 * Select the note style for playlist processing.
 * Independent from the single-video tone selector.
 */
function selectPlaylistTone(el) {
  document.querySelectorAll("[data-ptone]").forEach(e => e.classList.remove("selected"));
  el.classList.add("selected");
  playlistTone = el.dataset.ptone;
}

/**
 * Fetch playlist metadata (title, video list) from the server.
 * Populates the playlist preview with checkboxes for each video.
 */
async function fetchPlaylistInfo() {
  const urlInput = document.getElementById("playlistUrlInput");
  const url      = (urlInput?.value || "").trim();

  if (!url) {
    showToast("Paste a YouTube playlist URL first.");
    return;
  }

  const btn     = document.getElementById("playlistInfoBtn");
  const loader  = document.getElementById("playlistInfoLoader");
  const errBox  = document.getElementById("playlistError");
  const preview = document.getElementById("playlistPreview");
  const procBtn = document.getElementById("playlistProcessBtn");

  btn.disabled          = true;
  loader.style.display  = "flex";
  errBox.classList.remove("visible");
  preview.style.display = "none";
  procBtn.style.display = "none";

  try {
    const response = await fetch("/api/playlist/info", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Server error ${response.status}`);
    }

    // Store playlist data for later use when starting the job
    playlistData = data;

    // Show playlist metadata
    const metaEl = document.getElementById("playlistMeta");
    if (metaEl) {
      const totalSeconds = data.videos.reduce((s, v) => s + (v.duration_seconds || 0), 0);
      const totalHours   = (totalSeconds / 3600).toFixed(1);
      metaEl.innerHTML =
        `<strong>${escapeHtml(data.title)}</strong><br>` +
        `${data.channel ? escapeHtml(data.channel) + " · " : ""}` +
        `${data.video_count} videos · ~${totalHours}h total content`;
    }

    // Build video list with checkboxes
    const listEl = document.getElementById("playlistVideoList");
    if (listEl) {
      listEl.innerHTML = data.videos.map((v, i) => {
        const mins = v.duration_seconds ? Math.round(v.duration_seconds / 60) : "?";
        return `
          <label class="playlist-video-item">
            <input type="checkbox" class="playlist-video-cb"
                   data-id="${escapeHtml(v.id)}"
                   data-title="${escapeHtml(v.title)}"
                   checked>
            <div class="playlist-video-label">
              <div class="playlist-video-title">${i + 1}. ${escapeHtml(v.title)}</div>
              <div class="playlist-video-duration">${mins} min</div>
            </div>
          </label>`;
      }).join("");

      // Update count when any checkbox changes
      listEl.querySelectorAll(".playlist-video-cb").forEach(cb => {
        cb.addEventListener("change", updatePlaylistSelectedCount);
      });
    }

    updatePlaylistSelectedCount();

    preview.style.display = "block";
    procBtn.style.display = "inline-flex";

    // Show the note-style options panel
    const optionsPanel = document.getElementById("playlistOptions");
    if (optionsPanel) optionsPanel.style.display = "block";

    // Update the process button with video count + quota estimate
    const selectedCount = data.video_count;
    const quotaHint = selectedCount > 20
      ? ` (${selectedCount} videos — use Bullet/Concise to save quota)`
      : ` (${selectedCount} videos)`;
    procBtn.textContent = `✦ Generate Course Notes${quotaHint} →`;

    showToast(`✓ Playlist loaded: ${data.video_count} videos`);

  } catch (err) {
    document.getElementById("playlistErrorMsg").textContent = err.message;
    errBox.classList.add("visible");
    showToast("⚠ " + err.message.substring(0, 80));
    console.error("Playlist info error:", err);
  }

  btn.disabled         = false;
  loader.style.display = "none";
}

/**
 * Update the "X videos selected" count shown below the video list.
 */
function updatePlaylistSelectedCount() {
  const checkboxes = document.querySelectorAll(".playlist-video-cb");
  const checked    = Array.from(checkboxes).filter(cb => cb.checked).length;
  const countEl    = document.getElementById("playlistSelectedCount");
  if (countEl) {
    countEl.textContent = checked > 0 ? `${checked} selected` : "None selected";
    countEl.style.color = checked > 0 ? "var(--accent2)" : "var(--red)";
  }
}

/**
 * Select or deselect all videos in the playlist.
 * @param {boolean} checked - true to select all, false to deselect all
 */
function selectAllVideos(checked) {
  document.querySelectorAll(".playlist-video-cb").forEach(cb => {
    cb.checked = checked;
  });
  updatePlaylistSelectedCount();
}

/**
 * Start the background playlist processing job.
 * Collects selected video IDs and sends them to /api/playlist/process.
 * Reuses the same async job modal as single-video processing.
 */
async function startPlaylistJob() {
  if (!playlistData) {
    showToast("Load a playlist first.");
    return;
  }

  // Collect selected video IDs and their titles
  const checkboxes  = document.querySelectorAll(".playlist-video-cb:checked");
  const selectedIds = Array.from(checkboxes).map(cb => cb.dataset.id);
  const titlesMap   = {};
  document.querySelectorAll(".playlist-video-cb").forEach(cb => {
    titlesMap[cb.dataset.id] = cb.dataset.title;
  });

  if (selectedIds.length === 0) {
    showToast("Select at least one video.");
    return;
  }

  // No hard limit — allow full playlists
  if (selectedIds.length > 500) {
    showToast("Maximum 500 videos per job.");
    return;
  }

  const btn = document.getElementById("playlistProcessBtn");
  btn.disabled = true;

  try {
    const response = await fetch("/api/playlist/process", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        playlist_id:  playlistData.playlist_id,
        video_ids:    selectedIds,
        titles:       titlesMap,
        course_title: playlistData.title,
        model:        currentModel,
        tone:         playlistTone,   // uses playlist-specific tone selector
        api_key:      getActiveApiKey(),
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);

    // Set video title for file naming
    videoTitle   = playlistData.title;
    activeJobId  = data.job_id;
    jobStartTime = Date.now();

    // Show the progress modal
    showJobModal({
      chunks_total:  data.video_count,
      estimated_min: data.estimated_min,
      estimated_max: data.estimated_max || data.estimated_min * 2,
    });

    // Override the chunks label to show "videos" context
    const chunksEl = document.getElementById("jobChunks");
    if (chunksEl) {
      chunksEl.textContent =
        `Processing ${data.video_count} videos · Est. ${data.estimated_min}–${data.estimated_max || data.estimated_min * 2} min`;
    }

    // Start polling — reuses the same poll function as single-video jobs
    startJobPolling(data.job_id);

    showToast(`🎬 Playlist job started — ${data.video_count} videos queued`);

  } catch (err) {
    showToast("⚠ " + err.message.substring(0, 100));
    console.error("Playlist job error:", err);
    btn.disabled = false;
  }
}

// escapeHtml is defined in Section 16 above — no duplicate needed

