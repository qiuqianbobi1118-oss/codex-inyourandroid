export class Broker {
  constructor() {
    this.webSockets = new Set();
    this.listeners = new Set();
  }

  attachWebSocket(ws) {
    this.webSockets.add(ws);
    ws.on("close", () => {
      this.webSockets.delete(ws);
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event) {
    const payload = JSON.stringify(event);

    for (const ws of this.webSockets) {
      if (ws.readyState === 1) {
        ws.send(payload);
      }
    }

    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
