import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

export class CodexAppServer extends EventEmitter {
  constructor(config, logger) {
    super()
    this.config = config
    this.logger = logger
    this.child = null
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
    this.serverRequests = new Map()
    this.startPromise = null
    this.initialized = false
    this.closing = false
  }

  async start() {
    if (this.initialized && this.child?.stdin.writable) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.#start()
    try { await this.startPromise } catch (error) { this.startPromise = null; throw error }
  }

  async #start() {
    const executable = this.config.executable || (process.platform === 'win32' ? 'codex.exe' : 'codex')
    const args = ['app-server', '--listen', 'stdio://']
    const child = spawn(executable, args, {
      cwd: this.config.defaultCwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32' && !/\.exe$/i.test(executable),
      env: { ...process.env, ...(this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {}) },
    })
    this.child = child
    this.buffer = ''
    this.closing = false
    child.stdout.on('data', (chunk) => this.#onData(chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (text) this.emit('stderr', text)
    })
    child.on('exit', (code, signal) => this.#onExit(code, signal))
    child.on('error', (error) => this.emit('error', error))
    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('Codex app-server process did not start within 15 seconds'))
      }, 15000)
      child.once('spawn', () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } })
      child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } })
    })
    await this.#requestRaw('initialize', {
      clientInfo: { name: 'a2s_codex2server', title: 'A2S Codex Bridge', version: this.config.pluginVersion || '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.notify('initialized', {})
    this.initialized = true
    this.logger.info(`Codex app-server initialized via ${executable}`)
    this.emit('ready')
  }

  async request(method, params = {}) {
    await this.start()
    return this.#requestRaw(method, stripUndefined(params))
  }

  #requestRaw(method, params) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('Codex app-server is not writable'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, this.config.codexRequestTimeoutMs || 30000)
      this.pending.set(id, { resolve, reject, timeout, method })
      this.#send({ id, method, params })
    })
  }

  notify(method, params = {}) {
    this.#send({ method, params: stripUndefined(params) })
  }

  respond(requestId, result) {
    const key = String(requestId)
    const pending = this.serverRequests.get(key)
    if (!pending) throw Object.assign(new Error(`unknown Codex server request ${key}`), { code: 'not_found' })
    this.serverRequests.delete(key)
    this.#send({ id: pending.id, result })
    return { requestId: key, resolved: true }
  }

  respondError(requestId, code, message) {
    const key = String(requestId)
    const pending = this.serverRequests.get(key)
    if (!pending) return false
    this.serverRequests.delete(key)
    this.#send({ id: pending.id, error: { code, message } })
    return true
  }

  pendingRequest(requestId) { return this.serverRequests.get(String(requestId)) ?? null }

  async close() {
    if (this.closing) return
    this.closing = true
    this.initialized = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Codex app-server is closing'))
    }
    this.pending.clear()
    this.serverRequests.clear()
    const child = this.child
    this.child = null
    if (!child) return
    try { child.stdin.end() } catch {}
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
    if (child.exitCode === null) try { child.kill() } catch {}
  }

  #send(message) {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server is not writable')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      try { this.#onMessage(JSON.parse(line)) } catch (error) { this.logger.warn(`invalid Codex app-server JSON: ${error.message}`) }
    }
  }

  #onMessage(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(message.id)
      if (message.error) {
        const error = new Error(`Codex app-server ${message.error.code}: ${message.error.message}`)
        error.code = message.error.code
        error.details = message.error.data
        pending.reject(error)
      } else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      const request = { id: message.id, requestId: String(message.id), method: message.method, params: message.params ?? {}, receivedAt: Date.now() }
      this.serverRequests.set(request.requestId, request)
      this.emit('server-request', request)
      return
    }
    if (typeof message.method === 'string') this.emit('notification', { method: message.method, params: message.params ?? {}, receivedAt: Date.now() })
  }

  #onExit(code, signal) {
    if (this.child) this.child = null
    this.initialized = false
    this.startPromise = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`Codex app-server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    }
    this.pending.clear()
    if (!this.closing) this.emit('exit', { code, signal })
  }
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null).map(([key, entry]) => [key, stripUndefined(entry)]))
}
