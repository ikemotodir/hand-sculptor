// MediaRecorder WebM files have no Duration → players show 0:00 / can't seek.
// fixWebmDuration(blob, ms) writes Segment ▸ Info ▸ Duration (patches in place, or inserts it).
// Only the first 256 KB are parsed; on anything unexpected the original blob is returned.

const ID_EBML = 0x1A45DFA3, ID_SEGMENT = 0x18538067, ID_INFO = 0x1549A966, ID_CLUSTER = 0x1F43B675;
const ID_TIMESCALE = 0x2AD7B1, ID_DURATION = 0x4489;

function readVint(b, pos, keepMarker) {
  const first = b[pos];
  if (first === undefined) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || pos + len > b.length) return null;
  let value = keepMarker ? first : (first & (mask - 1));
  let allOnes = (first & (mask - 1)) === (mask - 1);
  for (let i = 1; i < len; i++) { value = value * 256 + b[pos + i]; if (b[pos + i] !== 0xff) allOnes = false; }
  return { value, len, unknown: !keepMarker && allOnes };
}

function encodeSize(value, len) {
  if (value >= 2 ** (7 * len) - 1) return null;   // all-ones is reserved for "unknown"
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function readUint(b, pos, len) { let v = 0; for (let i = 0; i < len; i++) v = v * 256 + b[pos + i]; return v; }

/** Locate Info inside the head bytes. Returns null if the layout is not understood. */
export function parseWebmHead(b) {
  let p = 0;
  const ebml = readVint(b, p, true); if (!ebml || ebml.value !== ID_EBML) return null;
  const ebmlSize = readVint(b, p + ebml.len); if (!ebmlSize) return null;
  p += ebml.len + ebmlSize.len + ebmlSize.value;
  const seg = readVint(b, p, true); if (!seg || seg.value !== ID_SEGMENT) return null;
  const segSize = readVint(b, p + seg.len); if (!segSize) return null;
  const segSizePos = p + seg.len;
  p = segSizePos + segSize.len;
  while (p < b.length) {
    const id = readVint(b, p, true); if (!id) return null;
    const sz = readVint(b, p + id.len); if (!sz) return null;
    const dataStart = p + id.len + sz.len;
    if (id.value === ID_INFO) {
      if (sz.unknown || dataStart + sz.value > b.length) return null;
      let q = dataStart, timescale = 1e6, duration = null;
      while (q < dataStart + sz.value) {
        const cid = readVint(b, q, true); if (!cid) return null;
        const csz = readVint(b, q + cid.len); if (!csz) return null;
        const cdata = q + cid.len + csz.len;
        if (cid.value === ID_TIMESCALE) timescale = readUint(b, cdata, csz.value) || 1e6;
        if (cid.value === ID_DURATION) duration = { pos: cdata, len: csz.value };
        q = cdata + csz.value;
      }
      return { segSizePos, segSize, infoStart: p, infoIdLen: id.len, infoSize: sz, infoDataStart: dataStart, infoEnd: dataStart + sz.value, timescale, duration };
    }
    if (id.value === ID_CLUSTER || sz.unknown) return null;
    p = dataStart + sz.value;
  }
  return null;
}

/** Returns the head bytes with Duration set (new Uint8Array), or null. */
export function patchWebmHead(b, durationMs) {
  const info = parseWebmHead(b);
  if (!info) return null;
  const value = durationMs * 1e6 / info.timescale;
  if (info.duration) {
    const out = b.slice();
    const dv = new DataView(out.buffer, out.byteOffset + info.duration.pos, info.duration.len);
    if (info.duration.len === 8) dv.setFloat64(0, value); else if (info.duration.len === 4) dv.setFloat32(0, value); else return null;
    return out;
  }
  const durEl = new Uint8Array(11);
  durEl[0] = 0x44; durEl[1] = 0x89; durEl[2] = 0x88;
  new DataView(durEl.buffer).setFloat64(3, value);
  const newInfoSize = info.infoSize.value + durEl.length;
  const sizeBytes = encodeSize(newInfoSize, info.infoSize.len) || encodeSize(newInfoSize, 8);
  const delta = durEl.length + (sizeBytes.length - info.infoSize.len);
  const head = b.slice(0, info.infoStart + info.infoIdLen);
  if (!info.segSize.unknown) {
    const s = encodeSize(info.segSize.value + delta, info.segSize.len);
    if (!s) return null;
    head.set(s, info.segSizePos);
  }
  const out = new Uint8Array(b.length + delta);
  let o = 0;
  out.set(head, o); o += head.length;
  out.set(sizeBytes, o); o += sizeBytes.length;
  out.set(b.subarray(info.infoDataStart, info.infoEnd), o); o += info.infoEnd - info.infoDataStart;
  out.set(durEl, o); o += durEl.length;
  out.set(b.subarray(info.infoEnd), o);
  return out;
}

/** blob (video/webm from MediaRecorder) → Blob with a Duration. Never throws. */
export async function fixWebmDuration(blob, durationMs) {
  try {
    const HEAD = Math.min(blob.size, 256 * 1024);
    const head = new Uint8Array(await blob.slice(0, HEAD).arrayBuffer());
    const patched = patchWebmHead(head, durationMs);
    if (!patched) return blob;
    return new Blob([patched, blob.slice(HEAD)], { type: blob.type });
  } catch (e) {
    console.warn('[webm-duration]', e);
    return blob;
  }
}

/** Reads the Duration back in ms (tests). */
export function readWebmDurationMs(b) {
  const info = parseWebmHead(b);
  if (!info?.duration) return null;
  const dv = new DataView(b.buffer, b.byteOffset + info.duration.pos, info.duration.len);
  const v = info.duration.len === 8 ? dv.getFloat64(0) : dv.getFloat32(0);
  return v * info.timescale / 1e6;
}
