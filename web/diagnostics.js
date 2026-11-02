// Only selected, non-identifying fields leave the stats collector. Never export
// raw WebRTC reports: they contain candidate IP addresses and stream identifiers.
((root) => {
  const clean = value => String(value || "unknown").replace(/[\r\n\t]/g, " ").slice(0, 160);
  const diagnostics = {
    shareable(body) {
      const one=h=>{
        const row={};
        for(const key of ['at','viewer','width','height','sourceWidth','sourceHeight','fps','mbps','targetBitrate'])
          if(Number.isFinite(h[key])) row[key]=h[key];
        row.codec=['H264','VP8','VP9','AV1','H265'].includes(h.codec) ? h.codec : 'unknown';
        row.limit=['none','cpu','bandwidth','other'].includes(h.limit) ? h.limit : 'unknown';
        row.route=['direct UDP','direct TCP','relay UDP','relay TCP','relay TLS'].includes(h.route) ? h.route : 'unknown';
        row.encoder=h.encoder==='libvpx' ? 'libvpx' : /^(MediaCodec|OMX\.|c2\.)/i.test(String(h.encoder || '')) ? 'hardware/platform' : 'unknown';
        return row;
      };
      return {version:/^1\.0\.\d{1,6}$/.test(body.version) ? body.version : 'web',
        quality:['Auto 1080p','Smooth 720p','HD 1080p','4K Ultra HD'].includes(body.quality) ? body.quality : 'unknown',
        viewers:body.viewers.slice(0,8).map(one),history:body.history.slice(-120).map(one)};
    },
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
    historyLine(h) {
      return `${Number.isFinite(h.at) ? new Date(h.at).toISOString().slice(11,19) + ' UTC' : 'Time unknown'} · Viewer ${Number.isFinite(h.viewer) ? h.viewer : '?'} · ${diagnostics.line(h)} · source ${Number(h.sourceWidth) || '?'}×${Number(h.sourceHeight) || '?'} · ${clean(h.codec)} · encoder ${clean(h.encoder)}${h.targetBitrate > 0 ? ` · target ${(h.targetBitrate / 1e6).toFixed(2)} Mbps` : ''}`;
    },
    report({ version, device, quality, viewers, history = [] }) {
      return [`Boxxie Share ${clean(version)}`, `Device: ${clean(device)}`, `Host setting: ${clean(quality)}`,
        ...viewers.map((h, i) => `Viewer ${i + 1}: ${diagnostics.line(h)}\nCodec: ${clean(h.codec)}; profile: ${clean(h.profile)}; encoder: ${clean(h.encoder)}${h.targetBitrate > 0 ? `; target ${(h.targetBitrate / 1e6).toFixed(2)} Mbps` : ""}${h.startupBitrateAccepted === undefined ? "" : `; start hint ${h.startupBitrateAccepted ? "accepted" : "not accepted"}`}`),
        viewers.length ? "" : "No active viewer stats yet.",
        history.length ? "Recent picture samples (in memory; source is captured screen/track, not original film quality):" : "",
        ...history.slice(-120).map(h => diagnostics.historyLine(h))].filter(Boolean).join("\n");
    },
  };
  if (typeof module !== "undefined") module.exports = diagnostics;
  else root.BoxxieDiagnostics = diagnostics;
})(globalThis);
