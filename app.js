"use strict";
/* VoxTable — a fully client-side voice recorder.
   Recordings live in IndexedDB; settings in localStorage. No server, no tracking. */

const MAX_RECORDING_DURATION_MS = 4 * 60 * 60 * 1000;
const MAX_RECORDING_BYTES = 1024 * 1024 * 1024;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PEAK_BUCKETS = 240;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------------- utils ---------------- */

function uid() {
  return "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function chooseRecordingMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "";
}

function extensionForMime(mime) {
  if (/mp4/i.test(mime)) return "m4a";
  if (/ogg/i.test(mime)) return "ogg";
  return "webm";
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  return hours > 0 ? hours + ":" + clock : clock;
}

function formatRecordedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const d = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const t = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d + ", " + t;
}

function defaultRecordingName(date = new Date()) {
  return "Recording " + formatRecordedAt(date.toISOString());
}

function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim().slice(0, 120) || "recording";
}

function sanitizeTsvCell(value) {
  return String(value).replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function serializeRecordingsTsv(recordings) {
  const rows = recordings.map((r) =>
    [sanitizeTsvCell(r.name), formatRecordedAt(r.recordedAt), formatDuration(r.durationMs)].join("\t")
  );
  return ["Recording\tDate and time\tDuration", ...rows].join("\n");
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(1)) + " " + units[i];
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read audio data."));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("The backup contains invalid audio data.");
  const mime = match[1] || "audio/webm";
  const base64 = match[3];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* ---------------- toasts & dialogs ---------------- */

function toast(message, kind) {
  const el = document.createElement("div");
  el.className = "toast" + (kind === "error" ? " error" : "");
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 320);
  }, 2800);
}

function confirmDialog({ title, description, label, danger }) {
  return new Promise((resolve) => {
    const root = $("#dialog-root");
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML =
      '<div class="dialog" role="alertdialog" aria-modal="true">' +
      "<h3></h3><p></p>" +
      '<div class="actions"><button class="btn" data-act="cancel">Cancel</button>' +
      '<button class="btn" data-act="ok"></button></div></div>';
    backdrop.querySelector("h3").textContent = title;
    backdrop.querySelector("p").textContent = description;
    const ok = backdrop.querySelector('[data-act="ok"]');
    ok.textContent = label;
    if (danger) ok.classList.add("btn-danger");
    const close = (value) => { backdrop.remove(); resolve(value); };
    backdrop.querySelector('[data-act="cancel"]').onclick = () => close(false);
    ok.onclick = () => close(true);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(false); });
    root.appendChild(backdrop);
    ok.focus();
  });
}

function promptDialog({ title, label, initialValue }) {
  return new Promise((resolve) => {
    const root = $("#dialog-root");
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.innerHTML =
      '<div class="dialog" role="dialog" aria-modal="true"><h3></h3>' +
      '<input type="text" aria-label="Name" />' +
      '<div class="actions"><button class="btn" data-act="cancel">Cancel</button>' +
      '<button class="btn btn-primary" data-act="ok"></button></div></div>';
    backdrop.querySelector("h3").textContent = title;
    const input = backdrop.querySelector("input");
    input.value = initialValue || "";
    const ok = backdrop.querySelector('[data-act="ok"]');
    ok.textContent = label;
    const close = (value) => { backdrop.remove(); resolve(value); };
    backdrop.querySelector('[data-act="cancel"]').onclick = () => close(null);
    ok.onclick = () => close(input.value.trim() || null);
    input.onkeydown = (e) => { if (e.key === "Enter") ok.click(); };
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(null); });
    root.appendChild(backdrop);
    input.focus();
    input.select();
  });
}

/* ---------------- settings ---------------- */

const DEFAULT_SETTINGS = { theme: "system", tableZoom: 100, textSize: 15 };
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = localStorage.getItem("voxtable:settings.v1");
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* keep defaults */ }
}

function saveSettings() {
  try { localStorage.setItem("voxtable:settings.v1", JSON.stringify(settings)); } catch { /* ignore */ }
}

function resolveTheme() {
  if (settings.theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return settings.theme;
}

function applySettings() {
  document.documentElement.dataset.theme = resolveTheme();
  document.documentElement.style.setProperty("--table-scale", settings.tableZoom / 100);
  document.documentElement.style.setProperty("--text-size", settings.textSize + "px");
  $$("[data-theme-opt]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.themeOpt === settings.theme)));
  $("#set-zoom").value = settings.tableZoom;
  $("#set-zoom-val").textContent = settings.tableZoom + "%";
  $("#set-text").value = settings.textSize;
  $("#set-text-val").textContent = settings.textSize + "px";
}

/* ---------------- IndexedDB ---------------- */

let db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("voxtable", 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("recordings", { keyPath: "id" });
      store.createIndex("deletedAt", "deletedAt", { unique: false });
    };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function tx(mode) {
  return db.transaction("recordings", mode).objectStore("recordings");
}

function dbPut(record) {
  return new Promise((resolve, reject) => {
    const req = tx("readwrite").put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll() {
  return new Promise((resolve, reject) => {
    const req = tx("readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const req = tx("readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* ---------------- state ---------------- */

let recordings = []; // active (not deleted), sorted by recordedAt desc default
let sortKey = "date";
let sortDir = "desc";
let searchQuery = "";
let playingId = null;
const audioEl = new Audio();
audioEl.preload = "metadata";
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

/* ---------------- peaks (waveforms) ---------------- */

async function computePeaks(blob) {
  try {
    const ctx = getAudioCtx();
    const buf = await blob.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const data = audio.getChannelData(0);
    const peaks = new Array(PEAK_BUCKETS).fill(0);
    const per = Math.max(1, Math.floor(data.length / PEAK_BUCKETS));
    for (let b = 0; b < PEAK_BUCKETS; b++) {
      let max = 0;
      const start = b * per;
      for (let i = start; i < Math.min(start + per, data.length); i += 7) {
        const v = Math.abs(data[i]);
        if (v > max) max = v;
      }
      peaks[b] = Math.round(Math.min(1, max * 1.6) * 1000) / 1000;
    }
    return peaks;
  } catch {
    return [];
  }
}

/* ---------------- recorder ---------------- */

const rec = {
  phase: "idle", // idle | requesting | recording | paused | saving
  stream: null,
  mediaRecorder: null,
  analyser: null,
  chunks: [],
  bytes: 0,
  startedAt: 0,
  accumulated: 0,
  raf: 0,
  timerInt: 0,
  mime: "",
};

const btnRecord = $("#btn-record"), btnPause = $("#btn-pause"), btnResume = $("#btn-resume"),
      btnStop = $("#btn-stop"), btnDiscard = $("#btn-discard"),
      recTimer = $("#rec-timer"), recStatus = $("#rec-status"), recWave = $("#rec-wave");

function recElapsed() {
  if (rec.phase === "recording") return rec.accumulated + (performance.now() - rec.startedAt);
  if (rec.phase === "paused") return rec.accumulated;
  return 0;
}

function setRecUI() {
  const p = rec.phase;
  btnRecord.hidden = p !== "idle";
  btnPause.hidden = p !== "recording";
  btnResume.hidden = p !== "paused";
  btnStop.hidden = !(p === "recording" || p === "paused");
  btnDiscard.hidden = !(p === "recording" || p === "paused");
  btnRecord.disabled = p === "requesting" || p === "saving";

  if (p === "idle") { recTimer.textContent = "00:00"; recStatus.innerHTML = "Ready to record"; recStatus.classList.remove("paused"); }
  else if (p === "requesting") recStatus.textContent = "Requesting microphone access…";
  else if (p === "saving") recStatus.textContent = "Saving recording…";
  else if (p === "recording") {
    recStatus.innerHTML = '<span class="dot"></span>Recording';
    recStatus.classList.remove("paused");
  } else if (p === "paused") {
    recStatus.innerHTML = '<span class="dot"></span>Paused';
    recStatus.classList.add("paused");
  }
}

function drawRecWave() {
  const canvas = recWave;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#60a5fa";
  const dim = css.getPropertyValue("--border").trim() || "#27272a";

  const loop = () => {
    if (rec.phase !== "recording" && rec.phase !== "paused" && rec.phase !== "requesting") return;
    rec.raf = requestAnimationFrame(loop);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = rec.phase === "recording" ? accent : dim;
    const bars = 72, gap = 4, bw = (w - gap * (bars - 1)) / bars;
    let values;
    if (rec.analyser && rec.phase === "recording") {
      const data = new Uint8Array(rec.analyser.fftSize);
      rec.analyser.getByteTimeDomainData(data);
      values = new Array(bars);
      const per = Math.floor(data.length / bars);
      for (let b = 0; b < bars; b++) {
        let max = 0;
        for (let i = b * per; i < (b + 1) * per; i += 4) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > max) max = v;
        }
        values[b] = Math.min(1, max * 2.2);
      }
    } else {
      values = new Array(bars).fill(0.04);
    }
    for (let b = 0; b < bars; b++) {
      const bh = Math.max(3, values[b] * (h - 12));
      ctx.beginPath();
      ctx.roundRect(b * (bw + gap), (h - bh) / 2, bw, bh, bw / 2);
      ctx.fill();
    }
  };
  cancelAnimationFrame(rec.raf);
  loop();
}

function stopRecTracks() {
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  rec.stream = null;
  rec.analyser = null;
  cancelAnimationFrame(rec.raf);
}

async function startRecording() {
  if (rec.phase !== "idle") return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Microphone access needs a secure (https) page.", "error");
    return;
  }
  rec.phase = "requesting";
  setRecUI();
  drawRecWave();
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    rec.phase = "idle";
    setRecUI();
    drawRecWaveIdle();
    toast("Microphone permission was denied.", "error");
    return;
  }
  const mime = chooseRecordingMime();
  if (!mime) {
    stopRecTracks();
    rec.phase = "idle";
    setRecUI();
    toast("This browser cannot record audio.", "error");
    return;
  }
  rec.mime = mime;
  rec.chunks = [];
  rec.bytes = 0;
  rec.accumulated = 0;

  const ctx = getAudioCtx();
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(rec.stream);
  rec.analyser = ctx.createAnalyser();
  rec.analyser.fftSize = 2048;
  src.connect(rec.analyser);

  rec.mediaRecorder = new MediaRecorder(rec.stream, { mimeType: mime });
  rec.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      rec.chunks.push(e.data);
      rec.bytes += e.data.size;
      if (rec.bytes >= MAX_RECORDING_BYTES) {
        toast("Size limit reached — stopping.", "error");
        stopRecording();
      }
    }
  };
  rec.mediaRecorder.onstop = onRecorderStopped;
  rec.mediaRecorder.start(1000);

  rec.phase = "recording";
  rec.startedAt = performance.now();
  setRecUI();
  drawRecWave();
  rec.timerInt = setInterval(() => {
    const el = recElapsed();
    recTimer.textContent = formatDuration(el);
    if (el >= MAX_RECORDING_DURATION_MS) {
      toast("Maximum duration reached — stopping.", "error");
      stopRecording();
    }
  }, 250);
}

function pauseRecording() {
  if (rec.phase !== "recording") return;
  rec.accumulated = recElapsed();
  rec.mediaRecorder.pause();
  rec.phase = "paused";
  setRecUI();
}

function resumeRecording() {
  if (rec.phase !== "paused") return;
  rec.mediaRecorder.resume();
  rec.startedAt = performance.now();
  rec.phase = "recording";
  setRecUI();
}

function stopRecording() {
  if (rec.phase !== "recording" && rec.phase !== "paused") return;
  if (rec.phase === "recording") rec.accumulated = recElapsed();
  clearInterval(rec.timerInt);
  rec.phase = "saving";
  setRecUI();
  rec.mediaRecorder.stop(); // → onRecorderStopped
  stopRecTracks();
}

async function discardRecording() {
  if (rec.phase !== "recording" && rec.phase !== "paused") return;
  const ok = await confirmDialog({
    title: "Discard this recording?",
    description: "The audio captured so far will be lost.",
    label: "Discard",
    danger: true,
  });
  if (!ok) return;
  clearInterval(rec.timerInt);
  rec.mediaRecorder.onstop = null;
  try { rec.mediaRecorder.stop(); } catch { /* ignore */ }
  stopRecTracks();
  rec.phase = "idle";
  setRecUI();
  drawRecWaveIdle();
}

async function onRecorderStopped() {
  const blob = new Blob(rec.chunks, { type: rec.mime });
  const durationMs = Math.max(1000, Math.round(rec.accumulated));
  const recordedAt = new Date(Date.now() - durationMs).toISOString();
  rec.phase = "idle";
  setRecUI();
  drawRecWaveIdle();
  toast("Processing…");
  const peaks = await computePeaks(blob);
  const record = {
    id: uid(),
    name: defaultRecordingName(new Date(recordedAt)),
    recordedAt,
    durationMs,
    mimeType: rec.mime,
    byteSize: blob.size,
    blob,
    peaks,
    deletedAt: null,
  };
  try {
    await dbPut(record);
    toast("Recording saved.");
    await refreshRecordings();
  } catch {
    toast("Could not save the recording.", "error");
  }
}

function drawRecWaveIdle() {
  const canvas = recWave;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const dim = getComputedStyle(document.documentElement).getPropertyValue("--border").trim() || "#27272a";
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = dim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

/* ---------------- library ---------------- */

function visibleRecordings() {
  const q = searchQuery.trim().toLowerCase();
  let list = recordings.filter((r) => !q || r.name.toLowerCase().includes(q));
  const mult = sortDir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    let d = 0;
    if (sortKey === "name") d = a.name.localeCompare(b.name);
    else if (sortKey === "date") d = Date.parse(a.recordedAt) - Date.parse(b.recordedAt);
    else d = a.durationMs - b.durationMs;
    return d * mult;
  });
}

function icon(name, attrs) {
  const paths = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  };
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
    (attrs ? " " + attrs : "") + ">" + (paths[name] || "") + "</svg>";
}

function renderLibrary() {
  const tbody = $("#rec-tbody");
  const list = visibleRecordings();
  tbody.innerHTML = "";
  $("#rec-empty").hidden = list.length > 0;

  $$("th.sortable").forEach((th) => {
    const key = th.dataset.sort;
    const base = th.textContent.replace(/ [▲▼]$/, "");
    th.innerHTML = "";
    th.textContent = base;
    if (key === sortKey) {
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.textContent = sortDir === "asc" ? " ▲" : " ▼";
      th.appendChild(arrow);
    }
  });

  for (const r of list) {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;

    const tdName = document.createElement("td");
    const nameDiv = document.createElement("div");
    nameDiv.className = "rec-name";
    nameDiv.textContent = r.name;
    const metaDiv = document.createElement("div");
    metaDiv.className = "rec-meta";
    metaDiv.textContent = formatBytes(r.byteSize);
    tdName.append(nameDiv, metaDiv);

    const tdDate = document.createElement("td");
    tdDate.className = "rec-meta";
    tdDate.textContent = formatRecordedAt(r.recordedAt);

    const tdDur = document.createElement("td");
    tdDur.className = "rec-meta";
    tdDur.textContent = formatDuration(r.durationMs);

    const tdAct = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "row-actions";

    const bPlay = document.createElement("button");
    bPlay.className = "icon-btn";
    bPlay.title = playingId === r.id ? "Pause" : "Play";
    bPlay.setAttribute("aria-label", (playingId === r.id ? "Pause " : "Play ") + r.name);
    bPlay.innerHTML = icon(playingId === r.id ? "pause" : "play");
    bPlay.onclick = () => togglePlay(r.id);

    const bRename = document.createElement("button");
    bRename.className = "icon-btn";
    bRename.title = "Rename";
    bRename.setAttribute("aria-label", "Rename " + r.name);
    bRename.innerHTML = icon("pencil");
    bRename.onclick = () => renameRecording(r.id);

    const bDl = document.createElement("button");
    bDl.className = "icon-btn";
    bDl.title = "Download audio";
    bDl.setAttribute("aria-label", "Download " + r.name);
    bDl.innerHTML = icon("download");
    bDl.onclick = () => downloadRecording(r.id);

    const bDel = document.createElement("button");
    bDel.className = "icon-btn danger";
    bDel.title = "Move to trash";
    bDel.setAttribute("aria-label", "Delete " + r.name);
    bDel.innerHTML = icon("trash");
    bDel.onclick = () => deleteRecording(r.id);

    actions.append(bPlay, bRename, bDl, bDel);
    tdAct.appendChild(actions);
    tr.append(tdName, tdDate, tdDur, tdAct);
    tbody.appendChild(tr);

    if (playingId === r.id) insertPlayerRow(tr, r);
  }
}

async function refreshRecordings() {
  const all = await dbGetAll();
  recordings = all.filter((r) => !r.deletedAt);
  renderLibrary();
  renderTrash(all.filter((r) => r.deletedAt));
  updateStorageMeter();
}

/* ---------------- playback ---------------- */

function insertPlayerRow(tr, r) {
  const prow = document.createElement("tr");
  prow.className = "player-row";
  prow.id = "player-row";
  const td = document.createElement("td");
  td.colSpan = 4;
  td.innerHTML =
    '<div class="player">' +
    '<canvas class="seek" aria-label="Seek"></canvas>' +
    '<span class="time">0:00 / ' + formatDuration(r.durationMs) + "</span></div>";
  prow.appendChild(td);
  tr.after(prow);

  const canvas = td.querySelector("canvas");
  const timeEl = td.querySelector(".time");
  const draw = () => drawPlayerWave(canvas, r, audioEl.currentTime, audioEl.duration || r.durationMs / 1000);
  sizeCanvas(canvas);
  draw();

  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const dur = audioEl.duration || r.durationMs / 1000;
    audioEl.currentTime = ratio * dur;
    draw();
  };

  const tick = () => {
    if (playingId !== r.id) return;
    draw();
    timeEl.textContent = formatDuration(audioEl.currentTime * 1000) + " / " + formatDuration(r.durationMs);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function sizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.round(44 * dpr);
  canvas.style.height = "44px";
}

function drawPlayerWave(canvas, r, current, duration) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim() || "#60a5fa";
  const dim = css.getPropertyValue("--border").trim() || "#27272a";
  const peaks = r.peaks && r.peaks.length ? r.peaks : new Array(PEAK_BUCKETS).fill(0.35);
  const bars = peaks.length, gap = Math.max(1, w / bars * 0.25), bw = w / bars - gap;
  const progress = duration > 0 ? current / duration : 0;
  for (let b = 0; b < bars; b++) {
    const bh = Math.max(2, peaks[b] * (h - 8));
    ctx.fillStyle = b / bars <= progress ? accent : dim;
    ctx.fillRect(b * (w / bars), (h - bh) / 2, Math.max(1, bw), bh);
  }
}

async function togglePlay(id) {
  if (playingId === id) {
    audioEl.pause();
    playingId = null;
    const prow = $("#player-row");
    if (prow) prow.remove();
    renderLibrary();
    return;
  }
  const r = recordings.find((x) => x.id === id);
  if (!r) return;
  if (!r.peaks || !r.peaks.length) {
    r.peaks = await computePeaks(r.blob);
    await dbPut(r).catch(() => {});
  }
  playingId = id;
  audioEl.src = URL.createObjectURL(r.blob);
  try {
    await audioEl.play();
  } catch {
    toast("Could not play this recording.", "error");
    playingId = null;
  }
  renderLibrary();
}

audioEl.addEventListener("ended", () => {
  playingId = null;
  const prow = $("#player-row");
  if (prow) prow.remove();
  renderLibrary();
});

/* ---------------- row actions ---------------- */

async function renameRecording(id) {
  const r = recordings.find((x) => x.id === id);
  if (!r) return;
  const name = await promptDialog({ title: "Rename recording", label: "Rename", initialValue: r.name });
  if (name === null || name === r.name) return;
  r.name = name;
  await dbPut(r);
  toast("Recording renamed.");
  renderLibrary();
}

function downloadRecording(id) {
  const r = recordings.find((x) => x.id === id);
  if (!r) return;
  const url = URL.createObjectURL(r.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sanitizeFileName(r.name) + "." + extensionForMime(r.mimeType);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast("Download started.");
}

async function deleteRecording(id) {
  const r = recordings.find((x) => x.id === id);
  if (!r) return;
  if (playingId === id) { audioEl.pause(); playingId = null; }
  r.deletedAt = new Date().toISOString();
  await dbPut(r);
  toast("Moved to trash. Restore it from Settings.");
  await refreshRecordings();
}

/* ---------------- trash ---------------- */

function renderTrash(trashed) {
  const list = $("#trash-list");
  list.innerHTML = "";
  $("#trash-actions").hidden = trashed.length === 0;
  if (trashed.length === 0) {
    list.innerHTML = '<p class="sub" style="margin:0">Trash is empty.</p>';
    return;
  }
  const sorted = [...trashed].sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
  for (const r of sorted) {
    const div = document.createElement("div");
    div.className = "trash-item";
    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = r.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = formatRecordedAt(r.recordedAt) + " · " + formatDuration(r.durationMs) +
      " · deleted " + formatRecordedAt(r.deletedAt);
    info.append(name, meta);
    const bRestore = document.createElement("button");
    bRestore.className = "btn btn-sm";
    bRestore.textContent = "Restore";
    bRestore.onclick = async () => {
      r.deletedAt = null;
      await dbPut(r);
      toast("Recording restored.");
      await refreshRecordings();
    };
    const bPurge = document.createElement("button");
    bPurge.className = "icon-btn danger";
    bPurge.title = "Delete permanently";
    bPurge.setAttribute("aria-label", "Delete permanently " + r.name);
    bPurge.innerHTML = icon("trash");
    bPurge.onclick = async () => {
      const ok = await confirmDialog({
        title: "Delete permanently?",
        description: "“" + r.name + "” cannot be recovered.",
        label: "Delete forever",
        danger: true,
      });
      if (!ok) return;
      await dbDelete(r.id);
      toast("Recording permanently deleted.");
      await refreshRecordings();
    };
    div.append(info, bRestore, bPurge);
    list.appendChild(div);
  }
}

async function purgeOldTrash(all) {
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  const stale = all.filter((r) => r.deletedAt && Date.parse(r.deletedAt) < cutoff);
  for (const r of stale) await dbDelete(r.id).catch(() => {});
  if (stale.length) toast(stale.length + " old trashed recording(s) removed.");
}

/* ---------------- backup / import / export ---------------- */

function parseBackup(value) {
  if (!value || typeof value !== "object") throw new Error("Choose a valid VoxTable backup file.");
  const backup = value;
  if (backup.schema !== "voxtable-backup" || backup.version !== 1) {
    throw new Error("This file is not a supported VoxTable backup.");
  }
  if (!backup.settings || typeof backup.settings !== "object" || !Array.isArray(backup.recordings)) {
    throw new Error("This VoxTable backup is incomplete.");
  }
  if (backup.recordings.length > 10000) throw new Error("This backup exceeds the supported import limits.");
  for (const rec of backup.recordings) {
    if (!rec || typeof rec.name !== "string" || typeof rec.recordedAt !== "string" ||
        typeof rec.durationMs !== "number" || typeof rec.audioDataUrl !== "string") {
      throw new Error("This backup contains an invalid recording.");
    }
  }
  return backup;
}

async function exportBackup() {
  toast("Preparing backup…");
  try {
    const all = await dbGetAll();
    const recordingsOut = [];
    for (const r of all) {
      recordingsOut.push({
        id: r.id,
        name: r.name,
        recordedAt: r.recordedAt,
        durationMs: r.durationMs,
        mimeType: r.mimeType,
        byteSize: r.byteSize,
        deletedAt: r.deletedAt || null,
        audioDataUrl: await blobToDataUrl(r.blob),
      });
    }
    const backup = {
      schema: "voxtable-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      recordings: recordingsOut,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "voxtable-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("Backup downloaded.");
  } catch (e) {
    toast("Backup failed: " + (e.message || e), "error");
  }
}

async function importBackup(backup) {
  let imported = 0;
  for (const rec of backup.recordings) {
    try {
      const blob = dataUrlToBlob(rec.audioDataUrl);
      const record = {
        id: uid(),
        name: rec.name,
        recordedAt: rec.recordedAt,
        durationMs: rec.durationMs,
        mimeType: rec.mimeType || blob.type || "audio/webm",
        byteSize: blob.size,
        blob,
        peaks: [],
        deletedAt: rec.deletedAt || null,
      };
      await dbPut(record);
      imported++;
    } catch { /* skip bad entries */ }
  }
  if (backup.settings && typeof backup.settings === "object") {
    settings = { ...DEFAULT_SETTINGS, ...settings, ...backup.settings };
    saveSettings();
    applySettings();
  }
  await refreshRecordings();
  toast("Imported " + imported + " recording" + (imported === 1 ? "" : "s") + " and backup settings.");
}

async function stageImport(file) {
  try {
    const backup = parseBackup(JSON.parse(await file.text()));
    const ok = await confirmDialog({
      title: "Import this VoxTable backup?",
      description: "This will add " + backup.recordings.length + " recording(s) and apply the backup's display settings. Existing data will remain.",
      label: "Import backup",
    });
    if (ok) await importBackup(backup);
  } catch (e) {
    toast(e.message || "Could not read that backup.", "error");
  }
}

async function importAudioFile(file) {
  try {
    const peaks = await computePeaks(file);
    const record = {
      id: uid(),
      name: file.name.replace(/\.[^.]+$/, "") || defaultRecordingName(),
      recordedAt: new Date(file.lastModified || Date.now()).toISOString(),
      durationMs: 1000,
      mimeType: file.type || "audio/webm",
      byteSize: file.size,
      blob: file,
      peaks,
      deletedAt: null,
    };
    // refine duration from decoded audio when possible
    try {
      const ctx = getAudioCtx();
      const audio = await ctx.decodeAudioData(await file.arrayBuffer().then((b) => b.slice(0)));
      record.durationMs = Math.max(1000, Math.round(audio.duration * 1000));
    } catch { /* keep estimate */ }
    await dbPut(record);
    toast("Imported “" + record.name + "”.");
    await refreshRecordings();
  } catch {
    toast("Could not import that file.", "error");
  }
}

/* ---------------- storage meter ---------------- */

async function updateStorageMeter() {
  const detail = $("#storage-detail");
  try {
    const all = await dbGetAll();
    const bytes = all.reduce((n, r) => n + (r.byteSize || 0), 0);
    let quotaText = "";
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est.quota) {
        const pct = Math.min(100, Math.round((est.usage / est.quota) * 100));
        $("#storage-fill").style.width = Math.max(2, pct) + "%";
        quotaText = " · " + pct + "% of browser quota";
      }
    }
    detail.textContent = all.length + " recording(s), " + formatBytes(bytes) + " used" + quotaText + ".";
  } catch {
    detail.textContent = "Could not measure storage.";
  }
}

/* ---------------- tabs ---------------- */

function showView(name) {
  const rec = name !== "settings";
  $("#view-recordings").hidden = !rec;
  $("#view-settings").hidden = rec;
  $("#tab-recordings").setAttribute("aria-selected", String(rec));
  $("#tab-settings").setAttribute("aria-selected", String(!rec));
  if (!rec) updateStorageMeter();
  history.replaceState(null, "", name === "settings" ? "#/settings" : "#/");
}

/* ---------------- init ---------------- */

function bindEvents() {
  $("#tab-recordings").onclick = () => showView("recordings");
  $("#tab-settings").onclick = () => showView("settings");

  btnRecord.onclick = startRecording;
  btnPause.onclick = pauseRecording;
  btnResume.onclick = resumeRecording;
  btnStop.onclick = stopRecording;
  btnDiscard.onclick = discardRecording;

  $("#search").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderLibrary();
  });

  $$("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortKey = key; sortDir = key === "name" ? "asc" : "desc"; }
      renderLibrary();
    });
  });

  $("#btn-copy-list").onclick = async () => {
    try {
      await navigator.clipboard.writeText(serializeRecordingsTsv(visibleRecordings()));
      toast("Recording list copied.");
    } catch {
      toast("Could not access the clipboard.", "error");
    }
  };

  // settings
  $$("[data-theme-opt]").forEach((b) => {
    b.onclick = () => {
      settings.theme = b.dataset.themeOpt;
      saveSettings();
      applySettings();
    };
  });
  $("#set-zoom").addEventListener("input", (e) => {
    settings.tableZoom = Number(e.target.value);
    saveSettings();
    applySettings();
  });
  $("#set-text").addEventListener("input", (e) => {
    settings.textSize = Number(e.target.value);
    saveSettings();
    applySettings();
  });
  $("#btn-reset-display").onclick = async () => {
    const ok = await confirmDialog({
      title: "Reset display settings?",
      description: "Theme, table zoom, and text size will return to their defaults.",
      label: "Reset defaults",
    });
    if (!ok) return;
    settings.theme = "system";
    settings.tableZoom = 100;
    settings.textSize = 15;
    saveSettings();
    applySettings();
    toast("Display settings reset.");
  };

  $("#btn-export").onclick = exportBackup;
  $("#btn-import").onclick = () => $("#import-file").click();
  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) stageImport(file);
  });

  $("#btn-empty-trash").onclick = async () => {
    const ok = await confirmDialog({
      title: "Empty the trash?",
      description: "Everything in trash will be permanently deleted.",
      label: "Empty trash",
      danger: true,
    });
    if (!ok) return;
    const all = await dbGetAll();
    for (const r of all.filter((x) => x.deletedAt)) await dbDelete(r.id).catch(() => {});
    toast("Trash emptied.");
    await refreshRecordings();
  };

  // paste-to-import on the recordings view
  $("#view-recordings").addEventListener("paste", async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      if (/\.json$/i.test(file.name) || file.type === "application/json") await stageImport(file);
      else if (/^audio\//.test(file.type)) await importAudioFile(file);
      else toast("“" + file.name + "” is not audio or a VoxTable backup.", "error");
    }
  });

  // space = pause/resume while recording
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) return;
    const t = e.target;
    if (t !== document.body && t.tagName !== "CANVAS") return;
    if (rec.phase === "recording") { e.preventDefault(); pauseRecording(); }
    else if (rec.phase === "paused") { e.preventDefault(); resumeRecording(); }
  });

  window.addEventListener("beforeunload", (e) => {
    if (rec.phase === "recording" || rec.phase === "paused") e.preventDefault();
  });

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (settings.theme === "system") applySettings();
  });

  window.addEventListener("resize", () => {
    const prow = $("#player-row");
    if (prow && playingId) {
      const r = recordings.find((x) => x.id === playingId);
      const canvas = prow.querySelector("canvas");
      if (r && canvas) {
        sizeCanvas(canvas);
        drawPlayerWave(canvas, r, audioEl.currentTime, audioEl.duration || r.durationMs / 1000);
      }
    }
  });
}

async function init() {
  loadSettings();
  applySettings();
  bindEvents();
  drawRecWaveIdle();
  try {
    await openDb();
  } catch {
    toast("Local database unavailable — recordings cannot be saved.", "error");
    return;
  }
  const all = await dbGetAll();
  await purgeOldTrash(all);
  await refreshRecordings();
  showView(location.hash === "#/settings" ? "settings" : "recordings");
  setRecUI();
}

document.addEventListener("DOMContentLoaded", init);
