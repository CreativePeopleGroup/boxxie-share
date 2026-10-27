// Requests are ceilings; WebRTC still owns congestion and encoder adaptation.
((root) => {
  const policy = {
    displayHeight({ width = 0, height = 0, tv = false, mode = "auto" } = {}) {
      if (mode === "tv" || tv) return 1080;
      return Math.min(width, height) >= 600 || Math.max(width, height) >= 1000 ? 1080 : 720;
    },
    limits(quality, requestedHeight) {
      if (!quality.automatic) return { ...quality };
      const height = requestedHeight === undefined || requestedHeight >= 1080 ? 1080 : 720;
      return { ...quality, height: Math.min(quality.height, height),
        maxBitrate: Math.min(quality.maxBitrate, requestedHeight >= 1080 ? 8_000_000 : 4_000_000) };
    },
  };
  if (typeof module !== "undefined") module.exports = policy;
  else root.BoxxieQuality = policy;
})(globalThis);
