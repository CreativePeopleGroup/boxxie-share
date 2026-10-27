const assert = require('node:assert/strict');
const diag = require('../../web/diagnostics.js');
const report = new Map([
  ['t',{type:'transport',selectedCandidatePairId:'p'}],
  ['p',{type:'candidate-pair',localCandidateId:'l',remoteCandidateId:'r'}],
  ['l',{candidateType:'host',protocol:'udp',address:'192.0.2.10'}],
  ['r',{candidateType:'srflx',address:'198.51.100.7'}],
]);
assert.equal(diag.route(report),'direct UDP');
report.get('l').candidateType='relay'; report.get('l').relayProtocol='tcp';
assert.equal(diag.route(report),'relay TCP');
assert.equal(diag.route(new Map()),'unknown');
const text=diag.report({version:'1.0.test',device:'Test TV',quality:'Auto 1080p',
  roomCode:'ABCD-2345',name:'Private Person',ip:'192.0.2.10',viewers:[{
    name:'Private Person',peer:'user-secret',width:1920,height:1080,fps:30,mbps:6.2,
    targetBitrate:7_000_000,route:diag.route(report),codec:'H264',profile:'42e01f',
    encoder:'hardware-test',limit:'bandwidth',rawStats:report,startupBitrateAccepted:true,
  }]});
for(const secret of ['Private Person','ABCD-2345','192.0.2.10','198.51.100.7','user-secret'])
  assert(!text.includes(secret),`No identifying field: ${secret}`);
for(const detail of ['Viewer 1','1920×1080','30 fps','6.20 Mbps sent','relay TCP','network limited','42e01f','target 7.00 Mbps','start hint accepted'])
  assert(text.includes(detail),detail);
assert(diag.line({limit:'cpu'}).includes('encoder busy'));
assert(diag.line({route:'not an address'}).includes('route unknown'));
console.log('PASS selected route, measured quality, encoder limits and report privacy');
