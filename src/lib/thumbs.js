// Thumbnail capture, downscale, storage and eviction.
// chrome.* is only touched inside functions, so the pure helpers import cleanly under node.

export const THUMB_WIDTH = 320;
export const THUMB_MAX_BYTES = 8 * 1024 * 1024;

const INDEX_KEY = 'thumbIndex';
const thumbKey = (tabId) => `thumb:${tabId}`;

/**
 * Pure. Picks which thumbnails to drop, least recently used first, to get under maxBytes.
 * @param {Array<{tabId:number, size:number, lastUsed:number}>} entries
 * @param {number} maxBytes
 * @returns {number[]} tab ids to evict
 */
export function selectEvictions(entries, maxBytes) {
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const evicted = [];
  const oldestFirst = [...entries].sort((a, b) => a.lastUsed - b.lastUsed);
  for (const entry of oldestFirst) {
    if (total <= maxBytes) break;
    total -= entry.size;
    evicted.push(entry.tabId);
  }
  return evicted;
}

/** Pure. Target size for a capture: never upscales, keeps the aspect ratio. */
export function scaledSize(width, height, maxWidth = THUMB_WIDTH) {
  const targetWidth = Math.min(width, maxWidth);
  return {
    width: targetWidth,
    height: Math.max(1, Math.round((height * targetWidth) / width)),
  };
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Chunked because String.fromCharCode(...bytes) overflows the stack on large arrays.
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return `data:${blob.type};base64,${btoa(chunks.join(''))}`;
}

async function downscale(dataUrl) {
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 }));
  } finally {
    bitmap.close();
  }
}

/**
 * Captures the window's visible tab and returns a downscaled data URL, or null on failure.
 * Failures are expected (rate limit, restricted pages like helium://), so they stay quiet.
 */
export async function captureThumbnail(windowId) {
  try {
    const raw = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 });
    return await downscale(raw);
  } catch {
    return null;
  }
}

async function readIndex() {
  const stored = await chrome.storage.session.get(INDEX_KEY);
  return stored[INDEX_KEY] ?? {};
}

/** Stores a thumbnail and evicts as needed. Callers must serialize this (read-modify-write). */
export async function storeThumbnail(tabId, dataUrl, now = Date.now()) {
  try {
    const index = await readIndex();
    index[tabId] = { size: dataUrl.length, lastUsed: now };

    const entries = Object.entries(index).map(([id, entry]) => ({ tabId: Number(id), ...entry }));
    const evicted = selectEvictions(entries, THUMB_MAX_BYTES);
    for (const id of evicted) delete index[id];

    // Remove first, so the 10 MB storage.session quota has room for the new write.
    if (evicted.length > 0) await chrome.storage.session.remove(evicted.map(thumbKey));
    const update = { [INDEX_KEY]: index };
    if (!evicted.includes(tabId)) update[thumbKey(tabId)] = dataUrl;
    await chrome.storage.session.set(update);
  } catch (err) {
    console.debug('hts: could not store thumbnail', err);
  }
}

/** Deletes a thumbnail. Callers must serialize this (read-modify-write). */
export async function deleteThumbnail(tabId) {
  const index = await readIndex();
  delete index[tabId];
  await chrome.storage.session.set({ [INDEX_KEY]: index });
  await chrome.storage.session.remove(thumbKey(tabId));
}

/** Returns a Map of tabId to data URL for the tabs that have a thumbnail. */
export async function getThumbnails(tabIds) {
  if (tabIds.length === 0) return new Map();
  const stored = await chrome.storage.session.get(tabIds.map(thumbKey));
  const thumbnails = new Map();
  for (const tabId of tabIds) {
    const dataUrl = stored[thumbKey(tabId)];
    if (dataUrl) thumbnails.set(tabId, dataUrl);
  }
  return thumbnails;
}
