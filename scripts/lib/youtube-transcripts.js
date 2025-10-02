// scripts/lib/youtube-transcripts.js
// Shared helpers for extracting YouTube video IDs and managing transcript files.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

import { ensureDir } from "./utils.js";
import { pushUpdate } from "./kb-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const TRANSCRIPTS_DIR = path.join(ROOT, "data", "transcripts");

export function extractYouTubeVideoId(input) {
  if (!input) return null;

  if (typeof input === "string") {
    if (input.startsWith("youtube:video:")) {
      return input.split(":").pop();
    }
    try {
      const url = new URL(input);
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      if (url.hostname.includes("youtu.be")) {
        const id = url.pathname.replace("/", "").trim();
        return id || null;
      }
    } catch {
      return null;
    }
    return null;
  }

  if (typeof input === "object") {
    if (typeof input.id === "string") {
      const fromId = extractYouTubeVideoId(input.id);
      if (fromId) return fromId;
    }
    if (typeof input.url === "string") {
      return extractYouTubeVideoId(input.url);
    }
  }

  return null;
}

function transcriptFilePath(videoId) {
  return path.join(TRANSCRIPTS_DIR, `${videoId}.txt`);
}

export async function readCachedTranscript(videoId) {
  const p = transcriptFilePath(videoId);
  try {
    await ensureDir(TRANSCRIPTS_DIR);
    const st = await fs.stat(p);
    if (st.size === 0) {
      return { path: p, text: null, exists: true, emptyMarker: true };
    }
    const raw = await fs.readFile(p, "utf8");
    const text = raw.trim();
    if (text.length > 0) {
      return { path: p, text, exists: true, emptyMarker: false };
    }
    return { path: p, text: null, exists: true, emptyMarker: true };
  } catch {
    return { path: p, text: null, exists: false, emptyMarker: false };
  }
}

function safeJoinText(arr) {
  return arr.join(" ").replace(/\s+/g, " ").trim();
}

function parseTimedTextTracks(xml) {
  const tracks = [];
  const trackTagRegex = /<track\s+([^>]+?)\s*\/>/g;
  const attrRegex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = trackTagRegex.exec(xml)) !== null) {
    const attrs = {};
    let attr;
    while ((attr = attrRegex.exec(match[1])) !== null) attrs[attr[1]] = attr[2];
    if (attrs.lang_code) tracks.push({ lang_code: attrs.lang_code, kind: attrs.kind || "" });
  }
  return tracks;
}

function pickBestTrack(tracks) {
  if (!tracks.length) return null;
  const en = tracks.filter((t) => t.lang_code.toLowerCase().startsWith("en"));
  return en.find((t) => t.kind !== "asr") || en.find((t) => t.kind === "asr") || tracks[0];
}

async function fetchTranscriptTimedText(videoId) {
  const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`;
  const listRes = await fetch(listUrl);
  if (!listRes.ok) return null;
  const listXml = await listRes.text();
  const chosen = pickBestTrack(parseTimedTextTracks(listXml));
  if (!chosen) return null;

  try {
    const jsonUrl = `https://www.youtube.com/api/timedtext?fmt=json3&v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(chosen.lang_code)}`;
    const jsonRes = await fetch(jsonUrl);
    if (jsonRes.ok) {
      const payload = await jsonRes.json();
      const parts = [];
      for (const ev of payload.events || []) {
        if (Array.isArray(ev.segs)) {
          for (const seg of ev.segs) if (seg?.utf8) parts.push(seg.utf8);
        }
      }
      const text = safeJoinText(parts);
      if (text) return text;
    }
  } catch {
    // swallow JSON fetch errors and fall back to VTT
  }

  try {
    const vttUrl = `https://www.youtube.com/api/timedtext?fmt=vtt&v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(chosen.lang_code)}`;
    const vttRes = await fetch(vttUrl);
    if (!vttRes.ok) return null;
    const vtt = await vttRes.text();
    const lines = vtt
      .replace(/^WEBVTT.*$/m, "")
      .split(/\r?\n/)
      .filter((ln) => ln && !/\d{2}:\d{2}:\d{2}\.\d{3}/.test(ln));
    const text = safeJoinText(lines);
    return text || null;
  } catch {
    // ignore and try SRV fallback
  }

  try {
    const srvUrl = `https://www.youtube.com/api/timedtext?fmt=srv1&v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(chosen.lang_code)}`;
    const srvRes = await fetch(srvUrl);
    if (!srvRes.ok) return null;
    const xml = await srvRes.text();
    const lines = Array.from(xml.matchAll(/<text[^>]*>(.*?)<\/text>/g)).map((m) =>
      m[1]
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
    );
    const text = safeJoinText(lines);
    return text || null;
  } catch {
    return null;
  }

  return null;
}

async function writeTranscriptFile(filePath, text) {
  await ensureDir(path.dirname(filePath));
  const payload = text && text.trim().length > 0 ? text : "";
  await fs.writeFile(filePath, payload, "utf8");
  const repoRel = path.posix.join("transcripts", path.basename(filePath));
  try {
    await pushUpdate(filePath, repoRel, payload ? "Add transcript" : "Mark no transcript");
  } catch (err) {
    console.warn("pushUpdate transcript failed", { file: filePath, error: err?.message });
  }
}

export async function ensureTranscript(videoId, { fetchIfMissing = true } = {}) {
  const cached = await readCachedTranscript(videoId);
  if (cached.exists) {
    return { ...cached, status: cached.emptyMarker ? "empty-marker" : "cached", updated: false };
  }
  if (!fetchIfMissing) {
    return { ...cached, status: "missing", updated: false };
  }

  const fetched = await fetchTranscriptTimedText(videoId);
  const hasText = Boolean(fetched && fetched.trim().length > 0);
  await writeTranscriptFile(cached.path, hasText ? fetched : "");
  return {
    path: cached.path,
    text: hasText ? fetched.trim() : null,
    exists: true,
    emptyMarker: !hasText,
    status: hasText ? "fetched" : "empty-written",
    updated: true,
  };
}
