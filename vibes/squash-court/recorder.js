// The camera's picture recorded with a session (optional): MediaRecorder on the live stream, cut
// into ~10 s segments, each a whole file of its own (a new recorder per segment). Short whole
// files can be seeked in (a MediaRecorder WebM carries no index, so a long one barely can), a lens
// switch (a new stream) just starts the next segment, and a crash loses at most the last one.
//
//   const R = new SegmentRecorder({ stream: () => MediaStream, now: () => session time (s),
//                                   meta: () => ({ cam, w, h }), save: (seg, meta, blob) => Promise })
//   R.start(); R.restart() (new stream); await R.stop()
//   SegmentRecorder.supported() -> mime type or null
const TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];

export class SegmentRecorder {
  static supported() { return typeof MediaRecorder === 'undefined' ? null : TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null; }
  constructor({ stream, now, meta, save, seconds = 10, bitrate = 1_500_000 }) {
    Object.assign(this, { stream, now, meta, save, seconds, bitrate }); this.seg = 0; this.rec = null; this.timer = 0; this.pending = Promise.resolve(); this.on = false;
  }
  start() { this.on = true; this.next(); }
  // one segment: from now until stopped (the timer, a restart or stop)
  next() {
    const st = this.stream(); if (!this.on || !st) return;
    const mime = SegmentRecorder.supported(); if (!mime) return;
    const rec = new MediaRecorder(st, { mimeType: mime, videoBitsPerSecond: this.bitrate }), parts = [], t0 = this.now(), seg = this.seg++;
    const me = { rec, t1: null };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    me.done = new Promise((ok) => { rec.onstop = () => {
      const blob = new Blob(parts, { type: mime.split(';')[0] }), t1 = me.t1 ?? this.now(), meta = me.meta ?? this.meta();
      // the camera fitted by the end of the segment (early on there may be none yet), taken when the
      // cut was asked for
      this.pending = this.pending.then(() => (blob.size ? this.save(seg, { t0, t1, mime: blob.type, ...meta }, blob) : null)).catch((e) => console.error('video segment', e));
      ok();
    }; });
    rec.start(); this.rec = me;
    clearTimeout(this.timer); this.timer = setTimeout(() => this.cut(), this.seconds * 1000);
  }
  // the end time is taken when the cut is asked for: by the time the recorder has stopped, the
  // page may have moved on (a new source has its own clock)
  async cut() { const r = this.rec; this.rec = null; if (r && r.rec.state !== 'inactive') { r.t1 = this.now(); r.meta = this.meta(); r.rec.stop(); await r.done; } this.next(); }
  restart() { return this.cut(); }
  async stop() {
    this.on = false; clearTimeout(this.timer);
    const r = this.rec; this.rec = null; if (r && r.rec.state !== 'inactive') { r.t1 = this.now(); r.meta = this.meta(); r.rec.stop(); await r.done; }
    await this.pending;
  }
}
