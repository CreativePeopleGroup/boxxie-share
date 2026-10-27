// Only selected, non-identifying fields leave the stats collector. Never export
// raw WebRTC reports: they contain candidate IP addresses and stream identifiers.
((root) => {
  const clean = value => String(value || "unknown").replace(/[\r\n\t]/g, " ").slice(0, 160);
  const diagnostics = {
    route(report) {
      const rows = [...report.values()];
      const transport = rows.find(r => r.type === "transport" && r.selectedCandidatePairId);
      const pair = transport ? report.get(transport.selectedCandidatePairId) :
        rows.find(r => r.type === "candidate-pair" && r.state === "succeeded" && r.nominated);
      if (!pair) return "unknown";
      const local = report.get(pair.localCandidateId), remote = report.get(pair.remoteCandidateId);
      if (!local || !remote) return "unknown";
      const relay = local.candidateType === "relay" || remote.candidateType === "relay";
      const protocol = String(local.relayProtocol || local.protocol || "").toUpperCase();
      return `${relay ? "relay" : "direct"}${["UDP", "TCP", "TLS"].includes(protocol) ? " " + protocol : ""}`;
    },
    line(h) {
      return [h.width && h.height ? `${h.width}×${h.height}` : "resolution unknown",
        Number.isFinite(h.fps) ? `${h.fps} fps` : "fps unknown",
        Number.isFinite(h.mbps) ? `${h.mbps.toFixed(2)} Mbps sent` : "bitrate unknown",
        /^(direct|relay)( (UDP|TCP|TLS))?$/.test(h.route) ? h.route : "route unknown",
        h.limit === "cpu" ? "encoder busy" : h.limit === "bandwidth" ? "network limited" : ""].filter(Boolean).join(" · ");
    },
    report({ version, device, quality, viewers }) {
      return [`Boxxie Share ${clean(version)}`, `Device: ${clean(device)}`, `Host setting: ${clean(quality)}`,
        ...viewers.map((h, i) => `Viewer ${i + 1}: ${diagnostics.line(h)}\nCodec: ${clean(h.codec)}; profile: ${clean(h.profile)}; encoder: ${clean(h.encoder)}${h.targetBitrate > 0 ? `; target ${(h.targetBitrate / 1e6).toFixed(2)} Mbps` : ""}${h.startupBitrateAccepted === undefined ? "" : `; start hint ${h.startupBitrateAccepted ? "accepted" : "not accepted"}`}`),
        viewers.length ? "" : "No active viewer stats yet."].filter(Boolean).join("\n");
    },
  };
  if (typeof module !== "undefined") module.exports = diagnostics;
  else root.BoxxieDiagnostics = diagnostics;
})(globalThis);
