/**
 * Incremental JPEG frame extraction from a byte stream (idb mjpeg stdout,
 * ffmpeg -f mjpeg stdout). Frames are delimited by SOI (FF D8) / EOI (FF D9).
 * Safe here because neither producer embeds EXIF thumbnails (which would
 * contain a nested EOI) — see spec 2026-07-04-observe-live-mirror-design.
 */
export const MAX_FRAME_BYTES = 8_000_000;

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export class JpegFrameExtractor {
  private acc: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.acc = this.acc.length === 0 ? chunk : Buffer.concat([this.acc, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      const soi = this.acc.indexOf(SOI);
      if (soi === -1) {
        // No frame start in sight — nothing before SOI is ever useful.
        this.acc = Buffer.alloc(0);
        break;
      }
      if (soi > 0) this.acc = this.acc.subarray(soi);
      const eoi = this.acc.indexOf(EOI, SOI.length);
      if (eoi === -1) {
        if (this.acc.length > MAX_FRAME_BYTES) this.acc = Buffer.alloc(0);
        break;
      }
      frames.push(this.acc.subarray(0, eoi + EOI.length));
      this.acc = this.acc.subarray(eoi + EOI.length);
    }
    return frames;
  }
}
