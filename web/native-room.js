/* WebSocket-shaped adapter. Android owns networking, authentication and retries. */
(function (root) {
  class NativeRoomSocket {
    constructor(bridge, config) {
      this.native = true;
      this.readyState = 0;
      this.id = config.id;
      this.bridge = bridge;
      this.config = config;
    }
    start() {
      const config = this.config;
      this.config = null;
      if (!this.bridge.connectRoom(JSON.stringify(config))) {
        this.receive({ type: 'room-message', connectionId: this.id, message: { type: 'refused', error: 'origin_not_allowed' } });
        this.receive({ type: 'room-state', connectionId: this.id, state: 'closed', code: 4003, reason: 'origin_not_allowed' });
      }
    }
    send(json) { if (this.readyState === 1) this.bridge.sendRoom(this.id, json); }
    close() {
      this.readyState = 3;
      this.config = null;
      this.bridge.disconnectRoom(this.id);
    }
    receive(ev) {
      if (ev.connectionId !== this.id || this.readyState === 3) return;
      if (ev.type === 'room-message') this.onmessage?.({ data: JSON.stringify(ev.message) });
      else if (ev.state === 'open') { this.readyState = 1; this.onopen?.(); }
      else if (ev.state === 'retrying') this.onretry?.();
      else if (ev.state === 'closed') {
        this.readyState = 3;
        this.onclose?.({ code: ev.code, reason: ev.reason });
      }
    }
  }
  root.BoxxieNativeRoomSocket = NativeRoomSocket;
  if (typeof module !== 'undefined') module.exports = NativeRoomSocket;
})(typeof window !== 'undefined' ? window : globalThis);
