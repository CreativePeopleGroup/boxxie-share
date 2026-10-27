const assert = require('node:assert/strict');
const Socket = require('../../web/native-room.js');
const calls = [];
const bridge = {
  connectRoom: config => { calls.push(['connect', JSON.parse(config)]); return true; },
  sendRoom: (id, json) => calls.push(['send', id, JSON.parse(json)]),
  disconnectRoom: id => calls.push(['stop', id]),
};
const socket = new Socket(bridge, { id: 'room-one', code: 'ABCDEFGH', sessionToken: 'test-only', hostToken: 'test-only' });
let opens = 0, retries = 0, closes = 0, received;
socket.onopen = () => opens++;
socket.onretry = () => retries++;
socket.onclose = e => { closes++; assert.equal(e.code, 4004); };
socket.onmessage = e => { received = JSON.parse(e.data); };
socket.start();
assert.equal(socket.config, null, 'adapter does not retain its credential config');
socket.receive({ type: 'room-state', connectionId: 'retired-page', state: 'open' });
assert.equal(opens, 0, 'retired page events ignored');
socket.receive({ type: 'room-state', connectionId: 'room-one', state: 'open' });
socket.send(JSON.stringify({ type: 'ping' }));
assert.equal(calls.at(-1)[0], 'send');
socket.receive({ type: 'room-state', connectionId: 'room-one', state: 'retrying' });
assert.equal(retries, 1);
assert.equal(closes, 0, 'native retries never trigger the browser retry loop');
socket.receive({ type: 'room-message', connectionId: 'room-one', message: { type: 'roster', viewers: [] } });
assert.equal(received.type, 'roster');
socket.receive({ type: 'room-state', connectionId: 'room-one', state: 'open' });
assert.equal(opens, 2);
socket.receive({ type: 'room-state', connectionId: 'room-one', state: 'closed', code: 4004, reason: 'ended' });
assert.equal(closes, 1);
const count = calls.length;
socket.send('{}');
assert.equal(calls.length, count, 'closed adapters cannot send');
socket.receive({ type: 'room-state', connectionId: 'room-one', state: 'open' });
assert.equal(socket.readyState, 3, 'closed rooms never resurrect on delayed callbacks');
socket.close();
assert.deepEqual(calls.at(-1), ['stop', 'room-one']);
console.log('PASS native room adapter ownership, native retry, terminal close and message routing');
