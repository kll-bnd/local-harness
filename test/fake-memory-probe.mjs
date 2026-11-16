// Fake macOS memory probe bound to a fake Ollama: runner RSS = the fake's resident footprint per loaded model,
// and a simple memory model of the Mac — when the loaded models exceed `freeBytes`, the excess goes to swap and
// the compressor, and (like the real thing) the runner's RSS under-reports by that amount.
export function createFakeMemoryProbe(fake, { freeBytes = Infinity, baseSwapBytes = 0, baseCompressedBytes = 0 } = {}) {
  const probe = {
    platform: 'darwin',
    freeBytes,
    baseSwapBytes,
    baseCompressedBytes,
    calls: { runners: 0, pressure: 0 },
    hideRunners: false,
    // Seen on the real 7 GB Mac right after a load: RSS below the model file (mmap'd pages not yet touched) while
    // the compressor grew a little — without swap. rssDeficitBytes is taken off every runner's RSS;
    // compressedPerLoadedBytes is added to the compressor while any model is loaded.
    rssDeficitBytes: 0,
    compressedPerLoadedBytes: 0,
    excess() {
      const total = fake.runners().reduce((a, r) => a + r.rssBytes, 0);
      return Math.max(0, total - this.freeBytes);
    },
    async runners() {
      probe.calls.runners++;
      if (probe.hideRunners) return [];
      const list = fake.runners();
      const total = list.reduce((a, r) => a + r.rssBytes, 0);
      const ex = probe.excess();
      return list.map((r) => ({ pid: r.pid, args: r.args, modelBlob: (r.args.match(/sha256-([0-9a-f]{64})/) || [])[1] || null, rssBytes: Math.round(r.rssBytes - (total ? (ex * r.rssBytes) / total : 0) - probe.rssDeficitBytes) }));
    },
    async pressure() {
      probe.calls.pressure++;
      const ex = probe.excess();
      // the pressure level stays "normal" (1) even while swapping, as observed on a real Mac
      const loaded = fake.runners().length ? probe.compressedPerLoadedBytes : 0;
      return { swapUsedBytes: probe.baseSwapBytes + Math.round(ex * 0.4), compressedBytes: probe.baseCompressedBytes + Math.round(ex * 0.6) + loaded, level: 1, at: Date.now() };
    },
  };
  return probe;
}
