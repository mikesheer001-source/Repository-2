# VoxTable

A fully client-side voice recorder — record, organize, play back, and back up voice recordings. Runs entirely in the browser; nothing is uploaded anywhere.

**Live:** https://mikesheer001-source.github.io/Repository-2/

## Features

- **Recorder** — one-click recording with live waveform, pause/resume, elapsed timer, and `Space` shortcut
- **Library** — searchable, sortable table (name / date / duration) with inline audio player featuring seekable waveforms
- **Trash** — deleted recordings are kept 30 days, restorable, then auto-purged
- **Settings** — light/dark/system theme, table zoom, text size
- **Portable backups** — export/import everything as one JSON file (compatible with the original VoxTable backup format); copy the recording list as TSV
- **Import** — paste or drop audio files to add them to the library

## How it works

No build step, no server, no dependencies. Three files:

- `index.html` — markup
- `styles.css` — theming
- `app.js` — recorder, IndexedDB storage, player, backup logic

Recordings are stored in the browser's IndexedDB; settings in `localStorage`. Serve over HTTPS (microphone access requires a secure context) — GitHub Pages qualifies.

## Deploy

Any static host works. For GitHub Pages: push to `main`, then enable Pages in the repo settings (deploy from the `main` branch, root folder).
