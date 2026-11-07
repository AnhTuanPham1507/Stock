function serializeEvent(id, type, data) {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function audienceMatches(client, audience) {
  return !audience?.expiry || audience.expiry === client.expiry;
}

export class SseHub {
  constructor(config) {
    this.config = config;
    this.clients = new Set();
    this.sequence = 0;
    this.replay = [];
    this.changeHandler = null;
    this.heartbeat = setInterval(() => this.sendHeartbeats(), config.sseHeartbeatMs);
    this.heartbeat.unref?.();
  }

  onSubscriptionsChanged(handler) {
    this.changeHandler = handler;
  }

  getSubscriptions() {
    return [...this.clients].map(({ user, expiry, range }) => ({ userId: user.sub, expiry, range }));
  }

  countForUser(userId) {
    let count = 0;
    for (const client of this.clients) if (client.user.sub === userId) count++;
    return count;
  }

  assertCapacity(user) {
    if (this.clients.size >= this.config.maxSseClients) throw Object.assign(new Error("Stream capacity reached"), { status: 503 });
    if (this.countForUser(user.sub) >= this.config.maxSseClientsPerUser) throw Object.assign(new Error("Too many open streams"), { status: 429 });
  }

  add(request, response, user, subscription) {
    this.assertCapacity(user);

    const client = {
      request,
      response,
      user,
      expiry: subscription.expiry,
      range: subscription.range,
      blocked: false,
      queue: [],
      closed: false,
      timer: null
    };
    this.clients.add(client);

    response.on("drain", () => this.flush(client));
    const close = () => this.remove(client);
    request.on("close", close);
    response.on("close", close);
    client.timer = setTimeout(close, this.config.sseMaxConnectionMs);
    client.timer.unref?.();

    response.write(`retry: 3000\n: connected\n\n`);
    const lastId = Number(request.headers["last-event-id"] || 0);
    if (Number.isSafeInteger(lastId) && lastId > 0) this.replayFrom(client, lastId);
    this.sendDirect(client, "ready", {
      connectedAt: Date.now(),
      expiry: client.expiry,
      range: client.range
    });
    this.changeHandler?.();
    return client;
  }

  remove(client) {
    if (!client || client.closed) return;
    client.closed = true;
    clearTimeout(client.timer);
    this.clients.delete(client);
    try { client.response.end(); } catch {}
    this.changeHandler?.();
  }

  publish(type, data, audience = null) {
    const entry = { id: ++this.sequence, type, data, audience };
    this.replay.push(entry);
    if (this.replay.length > this.config.sseReplaySize) this.replay.shift();
    for (const client of this.clients) {
      if (audienceMatches(client, audience)) this.enqueue(client, serializeEvent(entry.id, type, data));
    }
  }

  sendDirect(client, type, data) {
    this.enqueue(client, serializeEvent(++this.sequence, type, data));
  }

  replayFrom(client, lastId) {
    const oldest = this.replay[0]?.id;
    if (oldest && lastId < oldest - 1) {
      this.sendDirect(client, "resync", { reason: "replay-window-expired" });
      return;
    }
    for (const entry of this.replay) {
      if (entry.id > lastId && audienceMatches(client, entry.audience)) {
        this.enqueue(client, serializeEvent(entry.id, entry.type, entry.data));
      }
    }
  }

  enqueue(client, chunk) {
    if (client.closed) return;
    if (client.blocked) {
      if (client.queue.length >= this.config.maxSseQueue) {
        this.remove(client);
        return;
      }
      client.queue.push(chunk);
      return;
    }
    try {
      client.blocked = !client.response.write(chunk);
    } catch {
      this.remove(client);
    }
  }

  flush(client) {
    if (client.closed) return;
    client.blocked = false;
    while (client.queue.length && !client.blocked) {
      const chunk = client.queue.shift();
      try { client.blocked = !client.response.write(chunk); }
      catch { this.remove(client); return; }
    }
  }

  sendHeartbeats() {
    for (const client of this.clients) this.enqueue(client, `: heartbeat ${Date.now()}\n\n`);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of [...this.clients]) this.remove(client);
  }
}
