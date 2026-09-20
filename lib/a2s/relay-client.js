import { EventEmitter } from 'node:events'
import { frame, parseFrame, response, errorResponse, protocolError, ERROR_CODES } from './protocol.js'

const GLOBAL_TOPICS = new Set(['instance', 'sessions', 'jobs', 'approvals', 'goals', 'terminal'])

export class RelayClient extends EventEmitter {
  constructor({ config, adapter, logger, version = '0.1.0' }) {
    super()
    this.config = config
    this.adapter = adapter
    this.logger = logger
    this.version = version
    this.links = []
    this.seq = 0
    this.buffer = []
    this.startedAt = Date.now()
    this.closed = false
    this.requestTail = Promise.resolve()
  }

  start() {
    if (this.closed || this.links.length) return
    this.links = this.config.endpoints.map((endpoint) => new RelayLink(this, endpoint))
    for (const link of this.links) link.start()
    this.adapter.on?.('event', (event) => this.publish(event))
    this.adapter.on?.('status', (status) => this.publish({ topic: 'sessions', kind: 'session/status', sessionId: status.sessionId, data: status }))
    this.emit('status', this.status())
  }

  async close(reason = 'plugin shutting down') {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled(this.links.map((link) => link.close(reason, true)))
    await this.adapter.close?.()
    this.emit('status', this.status())
  }

  status() {
    return {
      agentType: this.config.agentType,
      instanceId: this.config.instanceId,
      displayName: this.config.displayName,
      startedAt: this.startedAt,
      connected: this.links.some((link) => link.connected),
      endpoints: this.links.map((link) => link.describe()),
      lastSeq: this.seq,
    }
  }

  hello(link) {
    return frame('hello', {
      instanceId: this.config.instanceId,
      ts: Date.now(),
      auth: { type: 'instance-key', key: this.config.key, instanceId: this.config.instanceId },
      instance: {
        displayName: this.config.displayName,
        hostname: this.adapter.hostFacts?.().hostname,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        agentType: this.config.agentType,
        locale: this.config.resolvedLocale,
        localeSetting: this.config.locale,
        agentName: this.adapter.agentName,
        icon: this.adapter.icon ?? this.config.agentType,
        pluginName: `${this.config.agentType}2server`,
        pluginVersion: this.version,
        protocolVersion: 1,
        deviceId: this.config.deviceId,
        liveSessions: this.adapter.liveSessionCount?.() ?? 0,
        connection: link.describe(),
      },
      capabilities: this.adapter.capabilities(),
      lastSeq: this.seq,
      resumeFromSeq: link.serverAckSeq,
      subscriptions: link.subscriptions(),
    })
  }

  publish(event) {
    if (!event || typeof event !== 'object') return null
    const outbound = frame('event', {
      seq: ++this.seq,
      topic: event.topic ?? 'sessions',
      kind: event.kind ?? 'agent/event',
      ts: event.ts ?? Date.now(),
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      data: event.data ?? {},
    })
    this.buffer.push(outbound)
    while (this.buffer.length > this.config.bufferSize) this.buffer.shift()
    for (const link of this.links) {
      if (link.connected && link.wants(outbound.topic, outbound.sessionId)) link.send(outbound)
    }
    return outbound
  }

  replay(link, afterSeq) {
    const first = this.buffer[0]?.seq
    if (afterSeq > 0 && first !== undefined && first > afterSeq + 1) return false
    for (const item of this.buffer) if (item.seq > afterSeq) link.send(item)
    return true
  }

  enqueueRequest(link, incoming) {
    this.requestTail = this.requestTail
      .catch(() => undefined)
      .then(async () => {
        const id = typeof incoming.id === 'string' ? incoming.id : ''
        if (!id) return
        try {
          if (typeof incoming.method !== 'string' || !incoming.method) throw protocolError(ERROR_CODES.BAD_REQUEST, 'request.method is required')
          const result = await this.adapter.handle(incoming.method, incoming.params ?? {})
          link.send(response(id, result))
        } catch (error) {
          link.send(errorResponse(id, error))
        }
      })
    return this.requestTail
  }

  async publishSnapshots(link, sessionIds = []) {
    const events = await this.adapter.snapshots?.(sessionIds)
    if (!Array.isArray(events)) return
    for (const event of events) {
      const outbound = frame('event', {
        seq: ++this.seq,
        topic: event.topic ?? 'sessions',
        kind: event.kind,
        ts: event.ts ?? Date.now(),
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        data: event.data ?? {},
      })
      this.buffer.push(outbound)
      while (this.buffer.length > this.config.bufferSize) this.buffer.shift()
      link.send(outbound)
    }
  }
}

class RelayLink {
  constructor(owner, endpoint) {
    this.owner = owner
    this.config = owner.config
    this.logger = owner.logger
    this.endpoint = endpoint
    this.connected = false
    this.closed = false
    this.transport = null
    this.socket = null
    this.abort = null
    this.outbox = []
    this.serverSeq = 0
    this.serverAckSeq = 0
    this.attempts = 0
    this.lastInboundAt = 0
    this.connectedAt = null
    this.lastError = null
    this.rejected = null
    this.topics = new Set(['instance', 'sessions', 'jobs', 'approvals', 'goals'])
    this.sessions = new Set()
    this.assistantStreams = new Set()
  }

  start() { void this.#run() }

  describe() {
    return {
      endpoint: this.endpoint,
      state: this.closed ? 'disposed' : this.connected ? 'connected' : 'connecting',
      transport: this.transport,
      connectedSince: this.connectedAt,
      lastInboundAt: this.lastInboundAt || null,
      attempts: this.attempts,
      serverAckSeq: this.serverAckSeq,
      rejected: this.rejected,
      lastError: this.lastError,
      insecure: /^http:|^ws:/i.test(this.endpoint),
      subscriptions: this.subscriptions(),
    }
  }

  subscriptions() {
    return { topics: [...this.topics], sessions: [...this.sessions], assistantStreams: [...this.assistantStreams] }
  }

  wants(topic, sessionId) {
    if (topic === 'assistant') return !!sessionId && this.assistantStreams.has(sessionId)
    if (sessionId && this.sessions.has(sessionId)) return true
    return GLOBAL_TOPICS.has(topic) && this.topics.has(topic)
  }

  async #run() {
    while (!this.closed && !this.owner.closed) {
      this.attempts += 1
      try {
        const order = this.config.transport === 'auto' ? ['ws', 'http'] : [this.config.transport]
        let last
        for (const kind of order) {
          try {
            await (kind === 'ws' ? this.#connectWebSocket() : this.#connectHttp())
            last = null
            break
          } catch (error) {
            last = error
            this.lastError = { code: 'connection_failed', message: error.message, at: Date.now() }
            await this.#dropTransport()
          }
        }
        if (last) throw last
        this.attempts = 0
        this.owner.emit('status', this.owner.status())
        await this.#hold()
      } catch (error) {
        if (this.closed || this.owner.closed) break
        this.logger.warn(`${this.endpoint}: ${error.message}`)
      }
      if (this.closed || this.owner.closed) break
      const exponent = Math.min(8, Math.max(0, this.attempts - 1))
      const delay = Math.min(this.config.reconnectMaxDelayMs, this.config.reconnectInitialDelayMs * 2 ** exponent)
      await wait(delay + Math.round(Math.random() * Math.min(500, delay / 4)))
    }
  }

  async #connectWebSocket() {
    const url = endpointUrl(this.endpoint, this.config.wsPath, 'ws')
    url.searchParams.set('instanceId', this.config.instanceId)
    url.searchParams.set('v', '1')
    const socket = new WebSocket(url)
    this.transport = 'websocket'
    this.socket = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket handshake timed out')), this.config.requestTimeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')) }, { once: true })
    })
    socket.addEventListener('message', (event) => {
      try { this.#receive(JSON.parse(String(event.data))) } catch { this.logger.warn(`${this.endpoint}: invalid JSON frame`) }
    })
    socket.addEventListener('close', (event) => this.#disconnect(`WebSocket closed (${event.code})`), { once: true })
    socket.addEventListener('error', () => this.#disconnect('WebSocket error'), { once: true })
    this.sendRaw(this.owner.hello(this))
    await this.#awaitHello()
  }

  async #connectHttp() {
    this.transport = 'http'
    this.abort = new AbortController()
    this.outbox.push(this.owner.hello(this))
    await this.#flushHttp()
    void this.#pollHttp()
    await this.#awaitHello()
  }

  async #awaitHello() {
    const started = Date.now()
    while (!this.connected) {
      if (this.rejected) throw new Error(this.rejected.message ?? 'server rejected the instance key')
      if (Date.now() - started > this.config.requestTimeoutMs) throw new Error('server did not acknowledge hello')
      if (this.closed) throw new Error('link closed during hello')
      await wait(20)
    }
  }

  async #hold() {
    while (this.connected && !this.closed && !this.owner.closed) {
      await wait(Math.max(1000, this.config.heartbeatMs))
      if (!this.connected) break
      if (Date.now() - this.lastInboundAt > this.config.heartbeatTimeoutMs) {
        this.#disconnect('server heartbeat timeout')
        break
      }
      this.send(frame('ping', { ts: Date.now() }))
    }
  }

  #receive(raw) {
    const parsed = parseFrame(raw)
    if (!parsed.ok) return
    const incoming = parsed.frame
    this.lastInboundAt = Date.now()
    if (Number.isFinite(incoming.seq)) this.serverSeq = Math.max(this.serverSeq, incoming.seq)
    switch (incoming.type) {
      case 'hello.ack':
        this.connected = true
        this.connectedAt = Date.now()
        this.lastError = null
        this.rejected = null
        if (Number.isFinite(incoming.serverSeq)) this.serverSeq = incoming.serverSeq
        if (Number.isFinite(incoming.resumeFromSeq)) {
          this.serverAckSeq = Math.max(this.serverAckSeq, incoming.resumeFromSeq)
          if (!this.owner.replay(this, incoming.resumeFromSeq)) {
            this.owner.publish({ topic: 'instance', kind: 'bridge/resync', data: { reason: 'resume window exceeded' } })
          }
        }
        this.logger.info(`connected to ${this.endpoint} over ${this.transport} as ${this.config.instanceId}`)
        break
      case 'pong':
        break
      case 'ack':
        if (Number.isFinite(incoming.seq)) this.serverAckSeq = Math.max(this.serverAckSeq, incoming.seq)
        break
      case 'request':
        void this.owner.enqueueRequest(this, incoming)
        break
      case 'subscribe': {
        for (const topic of incoming.topics ?? []) if (GLOBAL_TOPICS.has(topic)) this.topics.add(topic)
        for (const id of incoming.sessions ?? []) if (typeof id === 'string') this.sessions.add(id)
        if (incoming.assistantStream === true) {
          for (const id of incoming.sessions ?? []) if (typeof id === 'string') this.assistantStreams.add(id)
        }
        if (incoming.id) this.send(response(incoming.id, { subscriptions: this.subscriptions() }))
        if (incoming.snapshot !== false) void this.owner.publishSnapshots(this, incoming.sessions ?? [])
        break
      }
      case 'unsubscribe':
        for (const topic of incoming.topics ?? []) this.topics.delete(topic)
        for (const id of incoming.sessions ?? []) { this.sessions.delete(id); this.assistantStreams.delete(id) }
        if (incoming.id) this.send(response(incoming.id, { subscriptions: this.subscriptions() }))
        break
      case 'error':
        if (incoming.fatal) {
          this.rejected = { code: incoming.code ?? 'unauthorized', message: incoming.message ?? 'server rejected connection' }
          this.#disconnect(this.rejected.message)
        }
        break
      default:
        break
    }
    if (Number.isFinite(incoming.seq)) this.send(frame('ack', { seq: incoming.seq }))
    this.owner.emit('status', this.owner.status())
  }

  send(outbound) {
    if (!this.connected) return false
    return this.sendRaw(outbound)
  }

  sendRaw(outbound) {
    const encoded = JSON.stringify(outbound)
    if (Buffer.byteLength(encoded) > this.config.maxPayloadBytes) return false
    if (this.transport === 'websocket' && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encoded)
      return true
    }
    if (this.transport === 'http') {
      this.outbox.push(outbound)
      void this.#flushHttp()
      return true
    }
    return false
  }

  async #flushHttp() {
    if (this.flushing || !this.outbox.length || this.closed) return
    this.flushing = true
    const frames = this.outbox.splice(0, 50)
    try {
      const response = await fetch(endpointUrl(this.endpoint, this.config.eventsPath, 'http'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ v: 1, instanceId: this.config.instanceId, frames, lastServerCursor: this.serverSeq }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      })
      if (response.status === 401 || response.status === 403) {
        this.rejected = { code: 'unauthorized', message: `server rejected key with HTTP ${response.status}` }
        throw new Error(this.rejected.message)
      }
      if (!response.ok) throw new Error(`HTTP uplink failed with ${response.status}`)
    } catch (error) {
      this.outbox.unshift(...frames)
      throw error
    } finally {
      this.flushing = false
    }
    if (this.outbox.length) void this.#flushHttp()
  }

  async #pollHttp() {
    while (this.transport === 'http' && !this.closed) {
      try {
        const url = endpointUrl(this.endpoint, this.config.inboxPath, 'http')
        url.searchParams.set('instanceId', this.config.instanceId)
        url.searchParams.set('cursor', String(this.serverSeq))
        url.searchParams.set('waitMs', String(this.config.pollWaitMs))
        url.searchParams.set('key', this.config.key)
        const response = await fetch(url, { headers: { accept: 'application/json' }, signal: this.abort?.signal })
        if (response.status === 204) { this.lastInboundAt = Date.now(); continue }
        if (!response.ok) throw new Error(`HTTP inbox failed with ${response.status}`)
        const payload = await response.json()
        this.lastInboundAt = Date.now()
        if (Number.isFinite(payload.cursor)) this.serverSeq = Math.max(this.serverSeq, payload.cursor)
        for (const incoming of payload.frames ?? []) this.#receive(incoming)
      } catch (error) {
        if (!this.closed) this.#disconnect(error.message)
        return
      }
    }
  }

  #disconnect(reason) {
    if (!this.connected && !this.socket && !this.abort) return
    this.connected = false
    this.lastError = { code: 'connection_lost', message: reason, at: Date.now() }
    void this.#dropTransport()
    this.owner.emit('status', this.owner.status())
  }

  async #dropTransport() {
    const socket = this.socket
    this.socket = null
    this.abort?.abort()
    this.abort = null
    this.transport = null
    if (socket) try { socket.close(1000, 'reconnecting') } catch {}
  }

  async close(reason, sayGoodbye = false) {
    if (this.closed) return
    if (sayGoodbye && this.connected) this.send(frame('bye', { reason }))
    this.closed = true
    this.connected = false
    await this.#dropTransport()
  }
}

function endpointUrl(endpoint, suffix, kind) {
  const url = new URL(endpoint)
  if (kind === 'ws') url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:'
  else url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
  const base = url.pathname.replace(/\/+$/, '')
  url.pathname = `${base}/${String(suffix).replace(/^\/+/, '')}`
  return url
}

function wait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
