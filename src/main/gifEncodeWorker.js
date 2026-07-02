// Worker-thread half of composeMoodBoardGif. gifenc's quantize +
// applyPalette + writeFrame are pure-JS and CPU-bound — ~10 MB of RGBA
// per 1600×1600 frame — and used to run inline on the main process
// thread, freezing IPC, menus and every renderer round-trip for the
// duration of an export. The sharp compositing stays on the main
// thread (libuv pool, non-blocking); only the encode loop lives here.
//
// workerData: { frames: [{ data: ArrayBuffer, delay: number }],
//               width, height }
// Replies with the finished GIF as a transferred ArrayBuffer.

const { parentPort, workerData } = require('node:worker_threads');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

try {
  const { frames, width, height } = workerData;
  const enc = GIFEncoder();
  for (const f of frames) {
    const data = new Uint8Array(f.data);
    const palette = quantize(data, 256, { format: 'rgba4444' });
    const index = applyPalette(data, palette, 'rgba4444');
    enc.writeFrame(index, width, height, { palette, delay: f.delay });
  }
  enc.finish();
  const out = enc.bytes();
  // Copy into a standalone buffer so the transfer can't detach a slab
  // shared with the encoder's internals.
  const ab = new ArrayBuffer(out.byteLength);
  new Uint8Array(ab).set(out);
  parentPort.postMessage({ ok: true, bytes: ab }, [ab]);
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message || String(err) });
}
