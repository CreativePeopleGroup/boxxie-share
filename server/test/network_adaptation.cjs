// Linux CI only. Shape actual loopback UDP media packets, leaving HTTP,
// signalling and browser automation TCP untouched. This is not a VPN/device test.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tc = args => execFileSync('sudo', ['-n', 'tc', ...args], { encoding: 'utf8' });

async function sample(page) {
  return page.evaluate(async () => {
    const out = { bytes: 0, frames: 0, energy: 0, protocol: '', width: 0, height: 0 };
    for (const pc of window.__audioTestPeers) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      for (const r of stats.values()) {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          out.bytes += r.bytesReceived || 0; out.frames += r.framesDecoded || 0;
          out.width = r.frameWidth || out.width; out.height = r.frameHeight || out.height;
        }
        if (r.type === 'inbound-rtp' && r.kind === 'audio') out.energy += r.totalAudioEnergy || 0;
        if (r.type === 'transport' && r.selectedCandidatePairId) {
          const pair = stats.get(r.selectedCandidatePairId);
          const candidate = pair && stats.get(pair.localCandidateId);
          if (candidate) out.protocol = candidate.protocol;
        }
      }
    }
    return out;
  });
}

module.exports = async function testNetworkAdaptation(viewer) {
  assert(process.platform === 'linux' && process.env.CI === 'true', 'Packet shaping is restricted to isolated Linux CI');
  const report = { simulated: true, hardwareCaptureTested: false, scenarios: [] };
  let installed = false;
  try {
    const existing = JSON.parse(tc(['-j', 'qdisc', 'show', 'dev', 'lo']));
    assert(!existing.some(q => q.root && q.kind !== 'noqueue'), 'Do not replace an existing loopback shaper');
    tc(['qdisc', 'add', 'dev', 'lo', 'root', 'handle', '1:', 'prio', 'bands', '3']); installed = true;
    tc(['qdisc', 'add', 'dev', 'lo', 'parent', '1:3', 'handle', '30:', 'netem', 'limit', '60', 'rate', '12mbit']);
    tc(['filter', 'add', 'dev', 'lo', 'protocol', 'ip', 'parent', '1:', 'prio', '1', 'u32', 'match', 'ip', 'protocol', '17', '0xff', 'flowid', '1:3']);
    tc(['filter', 'add', 'dev', 'lo', 'protocol', 'ipv6', 'parent', '1:', 'prio', '2', 'u32', 'match', 'ip6', 'protocol', '17', '0xff', 'flowid', '1:3']);

    async function measure(name, settle) {
      await sleep(settle * 1000);
      const before = await sample(viewer), at = performance.now();
      await sleep(10000);
      const after = await sample(viewer);
      assert.equal(after.protocol, 'udp', 'The selected media path must be UDP');
      assert(after.frames > before.frames && after.energy > before.energy, `${name}: video and audio must keep progressing`);
      const result = { name, mbps: (after.bytes - before.bytes) * 8 / (performance.now() - at) / 1000,
        frames: after.frames - before.frames, width: after.width, height: after.height };
      report.scenarios.push(result);
      console.log('NETWORK', JSON.stringify(result));
      return result;
    }

    const healthy = await measure('healthy', 15);
    assert(healthy.mbps > 1.1, 'The synthetic source must exercise bandwidth adaptation, not remain a low-bitrate static picture');
    tc(['qdisc', 'change', 'dev', 'lo', 'parent', '1:3', 'handle', '30:', 'netem', 'limit', '60',
      'rate', '900kbit', 'delay', '60ms', '15ms', 'loss', '1%']);
    const limited = await measure('limited-900kbit-delay-loss', 20);
    assert(limited.mbps < healthy.mbps * 0.85 && limited.mbps < 1.2, 'Sender must reduce its rate on the constrained media path');
    const qdisc = JSON.parse(tc(['-j', '-s', 'qdisc', 'show', 'dev', 'lo'])).find(q => q.kind === 'netem');
    assert(qdisc && qdisc.bytes > 0, 'The impairment must affect actual packets');
    report.shaper = { bytes: qdisc.bytes, drops: qdisc.drops };
    tc(['qdisc', 'change', 'dev', 'lo', 'parent', '1:3', 'handle', '30:', 'netem', 'limit', '60',
      'rate', '12mbit', 'delay', '0ms', 'loss', '0%']);
    const recovered = await measure('recovered', 25);
    assert(recovered.mbps > limited.mbps * 1.3, 'Sender must raise its rate again when the network recovers');
    console.log('PASS: actual UDP bandwidth reduction/recovery retains fresh picture and audio');
  } finally {
    if (installed) tc(['qdisc', 'del', 'dev', 'lo', 'root']);
    writeFileSync('/tmp/boxxie-network-report.json', JSON.stringify(report, null, 2));
  }
};
