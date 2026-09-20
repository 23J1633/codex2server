import { EventEmitter } from 'node:events'
import { access, mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexAppServer } from './codex-app-server.js'
import { WorkspaceStore } from './workspace-store.js'
import { ERROR_CODES, protocolError } from './a2s/protocol.js'
import { tr } from './a2s/locale.js'
import { TerminalManager } from './terminal-manager.js'

const EVENT_LIMIT = 4000
const ROLLOUT_SEQ_FACTOR = 8
const LIVE_SEQ_BASE = 1_000_000_000_000_000
const FILE_READ_LIMIT = 4 * 1024 * 1024

export class CodexAdapter extends EventEmitter {
  constructor(config, { logger, configDir }) {
    super()
    this.config = config
    this.logger = logger
    this.configDir = configDir ?? process.cwd()
    this.workspaceStore = new WorkspaceStore(join(this.configDir, 'codex-workspaces.json'), logger)
    this.registeredWorkspaces = []
    this.app = new CodexAppServer(config, logger)
    this.agentName = 'OpenAI Codex'
    this.icon = 'codex'
    this.threads = new Map()
    this.activeTurns = new Map()
    this.events = new Map()
    this.eventSeq = new Map()
    this.permission = new Map()
    this.pendingInteractions = new Map()
    this.lastThreadRefreshAt = 0
    this.threadRefreshPromise = null
    this.terminals = new TerminalManager(this.config, this.logger)
    this.terminals.on('output', (data) => this.emit('event', { topic: 'terminal', kind: 'terminal/output', data }))
    this.terminals.on('exit', (data) => this.emit('event', { topic: 'terminal', kind: 'terminal/exit', data }))
    this.app.on('notification', (message) => this.#notification(message))
    this.app.on('server-request', (request) => this.#serverRequest(request))
    this.app.on('stderr', (line) => this.logger.debug(`codex: ${line}`))
    this.app.on('exit', (info) => this.logger.warn(`Codex app-server exited: ${JSON.stringify(info)}`))
    this.app.on('error', (error) => this.logger.warn(`Codex app-server error: ${error.message}`))
  }

  async init() {
    this.registeredWorkspaces = await this.workspaceStore.load()
    await this.app.start()
    await this.#refreshThreads().catch((error) => this.logger.warn(`cannot load Codex threads: ${error.message}`))
    return this
  }

  hostFacts() { return { hostname: hostname() } }
  liveSessionCount() { return this.activeTurns.size }

  capabilities() {
    return {
      sessions: true,
      sessionList: true,
      sessionHistory: true,
      sessionCreate: true,
      sessionPrompt: true,
      sessionInterrupt: true,
      sessionFork: true,
      sessionRename: true,
      sessionArchive: true,
      sessionSearch: true,
      sessionSelectModel: true,
      queueUpdate: false,
      modelCatalog: true,
      commands: true,
      jobs: false,
      goals: true,
      approvalPolicy: true,
      approvalAnswer: true,
      questions: true,
      workspaces: true,
      workspaceRegistry: true,
      workspaceMutation: true,
      directoryMutation: true,
      projections: true,
      sessionEvents: true,
      permissionPresets: true,
      fileBrowser: true,
      attachments: false,
      pluginManagement: false,
      terminal: true,
      agentType: 'codex',
    }
  }

  async handle(method, params) {
    switch (method) {
      case 'instance.info': return this.instanceInfo()
      case 'instance.health': return { ok: true, agentType: 'codex', executable: this.config.executable, sessions: this.threads.size, initialized: this.app.initialized, locale: this.config.resolvedLocale }
      case 'instance.key': return { keyFingerprint: fingerprint(this.config.key), shared: true, note: tr(this.config.locale, '由 A2Switch 统一管理', 'Managed by A2Switch') }
      case 'session.list': return { items: await this.#list(params) }
      case 'workspace.list': return { items: await this.#workspaces() }
      case 'workspace.create': return this.#workspaceCreate(params)
      case 'workspace.rename': return this.#workspaceRename(params)
      case 'workspace.remove': return this.#workspaceRemove(params)
      case 'session.create': return this.#create(params)
      case 'session.get': return this.#get(params.sessionId)
      case 'session.prompt': return this.#prompt(params)
      case 'session.interrupt': return this.#interrupt(params.sessionId)
      case 'session.cancel': return this.#interrupt(params.sessionId)
      case 'session.history': return this.#history(params)
      case 'session.events': return this.#events(params)
      case 'session.rename': return this.#rename(params)
      case 'session.fork': return this.#fork(params)
      case 'session.archive': return this.#archive(params.sessionId)
      case 'session.search': return this.#search(params)
      case 'session.modelCatalog': return this.#modelCatalog()
      case 'session.selectModel': return this.#selectModel(params)
      case 'session.approvalPolicy': return this.#approvalPolicy(params)
      case 'session.permission': return this.#permission(params)
      case 'approval.respond': return this.#approvalRespond(params)
      case 'question.answer': return this.#questionAnswer(params)
      case 'goal.get': return this.app.request('thread/goal/get', { threadId: requiredId(params) })
      case 'goal.pause': return this.#goalStatus(params, 'paused')
      case 'goal.resume': return this.#goalStatus(params, 'active')
      case 'goal.complete': return this.#goalStatus(params, 'completed')
      case 'command.list': return this.#commandList()
      case 'command.run': return this.#command(params)
      case 'workspace.fs.list': return this.#fsList(params)
      case 'workspace.fs.read': return this.#fsRead(params)
      case 'workspace.fs.roots': return this.#fsRoots()
      case 'workspace.fs.mkdir': return this.#fsMkdir(params)
      case 'job.list': return { items: [] }
      case 'terminal.open': return this.terminals.open(params)
      case 'terminal.list': return { items: this.terminals.list() }
      case 'terminal.attach': return this.terminals.attach(params.terminalId)
      case 'terminal.keepAlive': return this.terminals.keepAlive(params.terminalId)
      case 'terminal.write': return this.terminals.write(params.terminalId, params.data)
      case 'terminal.resize': return this.terminals.resize(params.terminalId, params.cols, params.rows)
      case 'terminal.close': return this.terminals.close(params.terminalId)
      default: throw protocolError(ERROR_CODES.UNKNOWN_METHOD, `codex2server does not implement ${method}`)
    }
  }

  async snapshots(sessionIds = []) {
    const rows = await this.#list({ limit: 200 })
    const selected = sessionIds.length ? rows.filter((row) => sessionIds.includes(row.sessionId)) : rows
    const events = [
      { topic: 'instance', kind: 'instance/info', data: this.instanceInfo() },
      ...rows.map((row) => ({ topic: 'sessions', kind: 'session/added', sessionId: row.sessionId, data: row })),
    ]
    for (const row of selected) {
      events.push({ topic: 'sessions', kind: 'session/snapshot', sessionId: row.sessionId, data: await this.#get(row.sessionId) })
    }
    return events
  }

  instanceInfo() {
    return {
      instanceId: this.config.instanceId,
      deviceId: this.config.deviceId,
      displayName: this.config.displayName,
      agentType: 'codex',
      agentName: this.agentName,
      locale: this.config.resolvedLocale,
      localeSetting: this.config.locale,
      executable: this.config.executable,
      sessions: this.threads.size,
      liveSessions: this.liveSessionCount(),
      capabilities: this.capabilities(),
    }
  }

  async close() { this.terminals.closeAll(); await this.app.close() }

  async #refreshThreads(options = {}) {
    const cached = [...this.threads.values()]
    if (cached.length && !options.force) return cached
    if (this.threadRefreshPromise) return this.threadRefreshPromise
    this.threadRefreshPromise = this.#loadThreads(options)
    try { return await this.threadRefreshPromise } finally { this.threadRefreshPromise = null }
  }

  async #loadThreads(options = {}) {
    const result = await this.app.request('thread/list', {
      limit: Math.max(1, Math.min(Number(options.limit) || 200, 1000)),
      sortKey: 'updated_at',
      archived: false,
      useStateDbOnly: false,
      sourceKinds: ['cli', 'vscode', 'appServer', 'unknown', 'exec'],
    })
    for (const thread of result?.data ?? []) if (thread?.id) this.threads.set(thread.id, thread)
    this.lastThreadRefreshAt = Date.now()
    return result?.data ?? []
  }

  async #list(params = {}) {
    const threads = await this.#refreshThreads({ ...params, force: params.refresh === true })
    return threads.map((thread) => normalizeThread(thread, this.activeTurns, this.permission)).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async #workspaces() {
    const rows = await this.#list({ limit: 1000 })
    const workspaces = new Map()
    for (const entry of this.registeredWorkspaces) {
      const cwd = resolve(String(entry.path))
      workspaces.set(pathKey(cwd), {
        id: entry.id ?? cwd, path: cwd, cwd,
        name: entry.title || basename(cwd), title: entry.title || basename(cwd), sessionIds: [],
        hidden: entry.hidden === true,
      })
    }
    for (const row of rows) {
      const cwd = row.cwd || this.config.defaultCwd
      const key = pathKey(cwd)
      if (!workspaces.has(key)) workspaces.set(key, { id: cwd, path: cwd, cwd, name: basename(cwd), title: basename(cwd), sessionIds: [] })
      workspaces.get(key).sessionIds.push(row.sessionId)
    }
    return [...workspaces.values()]
  }

  async #workspaceCreate(params) {
    const path = resolve(String(params.path ?? ''))
    assertAllowedPath(path, this.#allowedWorkspaceRoots())
    const info = await stat(path).catch(() => null)
    if (!info?.isDirectory()) throw protocolError(ERROR_CODES.INVALID_PARAMS, `working directory does not exist: ${path}`)
    const key = pathKey(path)
    const title = String(params.title || basename(path) || path).slice(0, 200)
    const existing = this.registeredWorkspaces.find((entry) => pathKey(entry.path) === key)
    const workspace = existing ?? { id: path, path, createdAt: Date.now() }
    workspace.title = title
    workspace.hidden = false
    workspace.updatedAt = Date.now()
    if (!existing) this.registeredWorkspaces.push(workspace)
    await this.workspaceStore.save(this.registeredWorkspaces)
    this.#workspaceChanged('created', workspace)
    return { workspace: { ...workspace, cwd: path, name: title, sessionIds: [] } }
  }

  async #workspaceRename(params) {
    const workspace = await this.#workspaceForMutation(params, true)
    workspace.title = String(params.title ?? '').trim().slice(0, 200)
    if (!workspace.title) throw protocolError(ERROR_CODES.INVALID_PARAMS, 'title is required')
    workspace.hidden = false
    workspace.updatedAt = Date.now()
    await this.workspaceStore.save(this.registeredWorkspaces)
    this.#workspaceChanged('renamed', workspace)
    return { workspace: { ...workspace, cwd: workspace.path, name: workspace.title } }
  }

  async #workspaceRemove(params) {
    const workspace = await this.#workspaceForMutation(params, true)
    workspace.hidden = true
    await this.workspaceStore.save(this.registeredWorkspaces)
    this.#workspaceChanged('removed', workspace)
    return { removed: true }
  }

  async #workspaceForMutation(params, createIfInferred = false) {
    const id = params.id == null ? null : String(params.id)
    const key = params.path == null ? null : pathKey(resolve(String(params.path)))
    let workspace = this.registeredWorkspaces.find((entry) => (id && String(entry.id) === id) || (key && pathKey(entry.path) === key))
    if (!workspace && createIfInferred && key) {
      const inferred = (await this.#list({ limit: 1000 })).some((session) => session.cwd && pathKey(session.cwd) === key)
      if (inferred) {
        const path = resolve(String(params.path))
        workspace = { id: path, path, title: basename(path) || path, createdAt: Date.now(), updatedAt: Date.now(), hidden: false }
        this.registeredWorkspaces.push(workspace)
      }
    }
    if (!workspace) throw protocolError(ERROR_CODES.NOT_FOUND, 'workspace is not registered')
    return workspace
  }

  #workspaceChanged(action, workspace) {
    this.emit('event', { topic: 'sessions', kind: 'workspace/changed', data: { action, workspace: { ...workspace }, at: Date.now() } })
  }

  async #create(params) {
    const cwd = resolve(String(params.cwd || this.config.defaultCwd || process.cwd()))
    try { await access(cwd) } catch { throw protocolError(ERROR_CODES.INVALID_PARAMS, `working directory does not exist: ${cwd}`) }
    assertAllowedPath(cwd, this.#allowedWorkspaceRoots())
    const preset = permissionSettings(params.permissionPreset ?? this.config.permissionPreset)
    const result = await this.app.request('thread/start', {
      cwd,
      model: params.model ?? this.config.model,
      approvalPolicy: params.approvalPolicy ?? preset.approvalPolicy ?? this.config.approvalPolicy,
      sandbox: params.sandbox ?? preset.sandbox ?? this.config.sandbox,
      serviceName: 'a2s_codex2server',
    })
    const thread = result?.thread
    if (!thread?.id) throw protocolError(ERROR_CODES.INTERNAL, 'Codex thread/start did not return thread.id')
    this.threads.set(thread.id, { ...thread, cwd: thread.cwd ?? cwd })
    if (params.title) await this.app.request('thread/name/set', { threadId: thread.id, name: String(params.title).slice(0, 200) })
    this.emit('event', { topic: 'sessions', kind: 'session/created', sessionId: thread.id, data: { sessionId: thread.id, header: { id: thread.id, cwd, title: params.title ?? thread.name ?? null, origin: 'codex2server', createdAt: toMs(thread.createdAt) } } })
    return { sessionId: thread.id, session: normalizeThread({ ...thread, cwd }, this.activeTurns, this.permission) }
  }

  async #get(sessionId) {
    const id = String(sessionId ?? '')
    if (!id) throw protocolError(ERROR_CODES.INVALID_PARAMS, 'sessionId is required')
    let thread = this.threads.get(id)
    if (!thread) {
      await this.#refreshThreads({ limit: 1000, force: true })
      thread = this.threads.get(id)
    }
    if (!thread) throw protocolError(ERROR_CODES.SESSION_NOT_FOUND, `unknown Codex thread ${id}`)
    const row = normalizeThread(thread, this.activeTurns, this.permission)
    const seq = await rolloutEndSeq(thread).catch(() => 0)
    return {
      ...row,
      header: { id, cwd: row.cwd, title: row.title, origin: 'codex2server', createdAt: row.createdAt },
      seq,
      approvalPolicy: this.permission.get(id)?.approvalPolicy ?? this.config.approvalPolicy,
      projections: { asOfSeq: seq, values: { title: row.title, tokenUsage: thread.tokenUsage ?? null } },
    }
  }

  async #prompt(params) {
    const threadId = requiredId(params)
    const text = promptText(params)
    if (!text.trim()) throw protocolError(ERROR_CODES.INVALID_PARAMS, 'prompt text is empty')
    const active = this.activeTurns.get(threadId)
    if (params.mode === 'steer' && active) {
      const result = await this.app.request('turn/steer', { threadId, expectedTurnId: active, input: [{ type: 'text', text }] })
      this.#record(threadId, 'user/message', {
        turn: active,
        turnId: active,
        clientMessageId: params.clientMessageId ?? null,
        message: { id: params.clientMessageId ?? `user-${Date.now()}`, role: 'user', content: normalizePromptContent(params.content, text) },
      })
      return { accepted: true, steered: true, turnId: result?.turnId ?? active }
    }
    await this.app.request('thread/resume', { threadId, cwd: params.cwd ?? this.threads.get(threadId)?.cwd ?? this.config.defaultCwd })
    const settings = this.permission.get(threadId) ?? permissionSettings(this.config.permissionPreset)
    const result = await this.app.request('turn/start', {
      threadId,
      cwd: params.cwd ?? this.threads.get(threadId)?.cwd ?? this.config.defaultCwd,
      input: [{ type: 'text', text }],
      model: settings.model ?? this.config.model,
      approvalPolicy: settings.approvalPolicy ?? this.config.approvalPolicy,
      sandboxPolicy: settings.sandboxPolicy,
      effort: settings.effort ?? this.config.effort,
    })
    const turnId = result?.turn?.id ?? result?.turnId ?? null
    if (turnId) this.activeTurns.set(threadId, turnId)
    this.#record(threadId, 'user/message', {
      turn: turnId,
      turnId,
      clientMessageId: params.clientMessageId ?? null,
      message: {
        id: params.clientMessageId ?? `user-${Date.now()}`,
        role: 'user',
        content: normalizePromptContent(params.content, text),
      },
    })
    return { accepted: true, turnId, sessionId: threadId }
  }

  async #interrupt(sessionId) {
    const threadId = String(sessionId ?? '')
    const turnId = this.activeTurns.get(threadId)
    if (!turnId) return { interrupted: false, sessionId: threadId }
    await this.app.request('turn/interrupt', { threadId, turnId })
    this.activeTurns.delete(threadId)
    return { interrupted: true, sessionId: threadId, turnId }
  }

  async #history(params) {
    const out = await this.#events({ ...params, limit: params.maxMessages })
    return {
      records: out.events.map((event) => ({ type: 'event', event })),
      hasMore: out.hasMore,
      oldestSeq: out.oldestSeq,
      newestSeq: out.newestSeq,
    }
  }

  async #events(params) {
    const threadId = requiredId(params)
    let thread = this.threads.get(threadId)
    if (!thread) {
      await this.#refreshThreads({ limit: 1000, force: true })
      thread = this.threads.get(threadId)
    }
    if (!thread) throw protocolError(ERROR_CODES.SESSION_NOT_FOUND, `unknown Codex thread ${threadId}`)
    const limit = Math.max(1, Math.min(Number(params.limit) || 200, 1000))
    const live = this.events.get(threadId) ?? []
    let page
    try {
      page = await readCodexRolloutPage(thread, { beforeSeq: params.beforeSeq, limit })
    } catch (error) {
      this.logger.debug(`rollout paging unavailable for ${threadId}: ${error.message}`)
      try {
        const result = await this.app.request('thread/read', { threadId, includeTurns: true })
        let fallback = threadToEvents(result?.thread ?? {})
        if (Number.isFinite(params.beforeSeq)) fallback = fallback.filter((event) => event.seq < params.beforeSeq)
        const selected = fallback.slice(-limit)
        page = { events: selected, hasMore: selected.length < fallback.length }
      } catch (fallbackError) {
        // A newly-created thread has no rollout file yet. Current Codex builds
        // also reject thread/read(includeTurns) with -32601. That is an empty
        // history, not a failed session, so retain any live bridge events and
        // let the first prompt create the rollout normally.
        if (!isTurnsUnavailable(fallbackError)) throw fallbackError
        this.logger.debug(`thread/read turns unavailable for ${threadId}: ${fallbackError.message}`)
        page = { events: [], hasMore: false, oldestSeq: null, newestSeq: null }
      }
    }
    const before = Number(params.beforeSeq)
    const persisted = new Set(page.events.map(eventIdentity))
    const eligibleLive = live.filter((event) => {
      if (Number.isFinite(before) && event.seq >= before) return false
      return !persisted.has(eventIdentity(event))
    })
    const combined = [...page.events, ...eligibleLive]
      .filter((event, index, all) => all.findIndex((candidate) => candidate.seq === event.seq && candidate.type === event.type) === index)
      .sort((a, b) => a.seq - b.seq)
    const selected = combined.length <= limit + 8 ? combined : combined.slice(-limit)
    return {
      events: selected,
      hasMore: page.hasMore || selected.length < combined.length,
      oldestSeq: page.oldestSeq ?? selected[0]?.seq ?? null,
      newestSeq: selected.at(-1)?.seq ?? null,
    }
  }

  async #rename(params) {
    const threadId = requiredId(params)
    const name = String(params.title ?? params.name ?? '').trim()
    if (!name) throw protocolError(ERROR_CODES.INVALID_PARAMS, 'title is required')
    await this.app.request('thread/name/set', { threadId, name: name.slice(0, 200) })
    const thread = this.threads.get(threadId)
    if (thread) thread.name = name.slice(0, 200)
    return { sessionId: threadId, title: name.slice(0, 200) }
  }

  async #fork(params) {
    const result = await this.app.request('thread/fork', { threadId: requiredId(params), lastTurnId: params.lastTurnId })
    const thread = result?.thread
    if (!thread?.id) throw protocolError(ERROR_CODES.INTERNAL, 'Codex thread/fork did not return a thread')
    this.threads.set(thread.id, thread)
    return { sessionId: thread.id, sourceSessionId: params.sessionId }
  }

  async #archive(sessionId) {
    const threadId = String(sessionId ?? '')
    await this.app.request('thread/archive', { threadId })
    this.threads.delete(threadId)
    this.emit('event', { topic: 'sessions', kind: 'session/removed', sessionId: threadId, data: { sessionId: threadId } })
    return { archived: true, sessionId: threadId }
  }

  async #search(params) {
    const query = String(params.query ?? '').trim().toLowerCase()
    const rows = await this.#list({ limit: params.limit ?? 200 })
    return { items: rows.filter((row) => !query || `${row.title ?? ''} ${row.cwd ?? ''}`.toLowerCase().includes(query)) }
  }

  async #modelCatalog() {
    try {
      const result = await this.app.request('model/list', {})
      const models = result?.data ?? result?.models ?? []
      if (models.length) {
        const entries = models.map(normalizeModelEntry)
        return { default: { provider: 'openai', model: this.config.model ?? entries[0]?.id }, groups: [{ provider: 'openai', label: 'OpenAI', models: entries }] }
      }
    } catch (error) { this.logger.debug(`model/list unavailable: ${error.message}`) }
    const model = this.config.model || 'default'
    return { default: { provider: 'openai', model }, groups: [{ provider: 'openai', label: 'OpenAI', models: [{ id: model, model, label: model }] }] }
  }

  #selectModel(params) {
    const threadId = requiredId(params)
    const current = this.permission.get(threadId) ?? {}
    const thread = this.threads.get(threadId)
    const model = params.model ?? current.model ?? thread?.model ?? this.config.model
    if (!model) throw protocolError(ERROR_CODES.INVALID_PARAMS, 'model is required')
    const effort = params.reasoningEffort ?? current.effort ?? thread?.reasoningEffort ?? undefined
    this.permission.set(threadId, { ...current, model, effort })
    const selected = { provider: 'openai', model, ...(effort ? { reasoningEffort: effort } : {}) }
    return { sessionId: threadId, selected, model: selected }
  }

  #approvalPolicy(params) {
    const threadId = requiredId(params)
    const current = this.permission.get(threadId) ?? {}
    this.permission.set(threadId, { ...current, approvalPolicy: params.policy })
    return { sessionId: threadId, policy: params.policy }
  }

  #permission(params) {
    const threadId = requiredId(params)
    const current = this.permission.get(threadId) ?? permissionSettings(this.config.permissionPreset)
    if (!params.preset) return { sessionId: threadId, preset: current.preset ?? 'workspace-write', available: ['read-only', 'workspace-write', 'full-access'] }
    const next = { ...current, ...permissionSettings(params.preset), preset: params.preset }
    this.permission.set(threadId, next)
    this.emit('event', { topic: 'sessions', kind: 'session/permission', sessionId: threadId, data: { sessionId: threadId, preset: params.preset } })
    return { sessionId: threadId, preset: params.preset, available: ['read-only', 'workspace-write', 'full-access'] }
  }

  #approvalRespond(params) {
    const requestId = String(params.requestId ?? '')
    const pending = this.pendingInteractions.get(requestId)
    if (!pending || pending.kind !== 'approval') throw protocolError(ERROR_CODES.NOT_FOUND, `unknown approval ${requestId}`)
    const requestedDecision = params.decision ?? params.action ?? params.outcome
    let decision
    if (['allow', 'approve', 'accept', 'allowed-once'].includes(requestedDecision)) decision = params.scope === 'session' ? 'acceptForSession' : 'accept'
    else if (['cancel'].includes(requestedDecision)) decision = 'cancel'
    else decision = 'decline'
    const result = this.app.respond(pending.appRequestId, { decision })
    this.pendingInteractions.delete(requestId)
    return { ...result, decision }
  }

  #questionAnswer(params) {
    const requestId = String(params.requestId ?? '')
    const pending = this.pendingInteractions.get(requestId)
    if (!pending || pending.kind !== 'question') throw protocolError(ERROR_CODES.NOT_FOUND, `unknown question ${requestId}`)
    const supplied = params.answers ?? params.answer ?? ''
    const structured = Array.isArray(supplied)
      ? new Map(supplied.filter((entry) => entry && typeof entry === 'object').map((entry) => [
        String(entry.id ?? ''),
        [...(Array.isArray(entry.selected) ? entry.selected.map(String) : []), ...(entry.custom ? [String(entry.custom)] : [])],
      ]))
      : null
    if (pending.method === 'mcpServer/elicitation/request') {
      const content = supplied && typeof supplied === 'object' && !Array.isArray(supplied)
        ? supplied
        : { value: structured ? [...structured.values()].flat().join('\n') : String(supplied ?? '') }
      const result = this.app.respond(pending.appRequestId, { action: params.action ?? 'accept', content })
      this.pendingInteractions.delete(requestId)
      return result
    }
    const questions = pending.params.questions ?? []
    const answers = {}
    for (const question of questions) {
      const value = structured?.get(String(question.id))
        ?? (typeof supplied === 'object' && !Array.isArray(supplied) ? supplied[question.id] : supplied)
      answers[question.id] = { answers: Array.isArray(value) ? value.map(String) : [String(value ?? '')] }
    }
    const result = this.app.respond(pending.appRequestId, { answers })
    this.pendingInteractions.delete(requestId)
    return result
  }

  async #goalStatus(params, status) {
    return this.app.request('thread/goal/set', { threadId: requiredId(params), status })
  }

  #commandList() {
    return {
      items: [
        { name: 'compact', description: '压缩当前会话上下文，保留重点后继续对话' },
      ],
    }
  }

  async #command(params) {
    const threadId = requiredId(params)
    const command = String(params.line ?? params.command ?? params.name ?? '').trim()
    if (!command) throw protocolError(ERROR_CODES.INVALID_PARAMS, 'command is required')
    if (command === '/compact' || command === 'compact') {
      await this.app.request('thread/compact/start', { threadId })
      return { accepted: true, command: '/compact' }
    }
    return this.#prompt({ sessionId: threadId, prompt: command.startsWith('/') ? command : `/${command}`, mode: 'steer' })
  }

  async #fsList(params) {
    const requested = resolve(String(params.path || this.threads.get(params.sessionId)?.cwd || this.config.defaultCwd))
    const root = await realpath(requested)
    assertAllowedPath(root, this.#allowedRoots())
    const entries = await readdir(root, { withFileTypes: true })
    const selected = entries.slice(0, 1000)
    return { path: root, entries: await Promise.all(selected.map(async (entry) => {
      const fullPath = resolve(root, entry.name)
      const info = await stat(fullPath).catch(() => null)
      return { name: entry.name, path: fullPath, type: entry.isDirectory() ? 'dir' : 'file', size: info?.size ?? null, modifiedAt: info?.mtimeMs ?? null }
    })), truncated: entries.length > selected.length }
  }

  async #fsRead(params) {
    const requested = resolve(String(params.path ?? ''))
    const path = await realpath(requested)
    assertAllowedPath(path, this.#allowedRoots())
    const info = await stat(path)
    if (!info.isFile()) throw protocolError(ERROR_CODES.INVALID_PARAMS, `path is not a file: ${path}`)
    const maxBytes = Math.min(Math.max(Number(params.maxBytes) || 262144, 1), FILE_READ_LIMIT)
    if (info.size > maxBytes) throw protocolError(ERROR_CODES.PAYLOAD_TOO_LARGE, `file exceeds ${maxBytes} bytes`)
    return filePayload(path, await readFile(path), info)
  }

  async #fsRoots() {
    const roots = []
    for (const candidate of this.#allowedWorkspaceRoots()) {
      const path = await realpath(candidate).catch(() => null)
      if (path && !roots.some((entry) => pathKey(entry.path) === pathKey(path))) {
        roots.push({ path, name: basename(path) || path })
      }
    }
    return { roots }
  }

  async #fsMkdir(params) {
    const parent = await realpath(resolve(String(params.path ?? params.parent ?? '')))
    assertAllowedPath(parent, this.#allowedRoots())
    const name = String(params.name ?? '').trim()
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw protocolError(ERROR_CODES.INVALID_PARAMS, 'folder name must be one path segment')
    }
    const path = resolve(parent, name)
    assertAllowedPath(path, [parent])
    await mkdir(path)
    return { path, name }
  }

  #allowedRoots() {
    return [...new Set([
      ...this.#allowedWorkspaceRoots(),
      homedir(),
    ].filter(Boolean).map((value) => resolve(String(value))))]
  }

  #allowedWorkspaceRoots() {
    return [...new Set([
      ...(this.config.allowedCwdPrefixes ?? []),
      this.config.defaultCwd,
      ...this.registeredWorkspaces.map((workspace) => workspace.path),
      ...[...this.threads.values()].map((thread) => thread?.cwd),
    ].filter(Boolean).map((value) => resolve(String(value))))]
  }

  #notification({ method, params, receivedAt }) {
    if (method === 'serverRequest/resolved') {
      for (const [requestId, interaction] of this.pendingInteractions) {
        if (String(interaction.appRequestId) === String(params.requestId)) this.pendingInteractions.delete(requestId)
      }
      return
    }
    const threadId = params.threadId ?? params.thread?.id ?? null
    const turnId = params.turnId ?? params.turn?.id ?? null
    if (method === 'thread/started' && params.thread?.id) {
      this.threads.set(params.thread.id, params.thread)
      this.emit('event', { topic: 'sessions', kind: 'session/added', sessionId: params.thread.id, data: normalizeThread(params.thread, this.activeTurns, this.permission) })
      return
    }
    if (!threadId) return
    if (method === 'turn/started') {
      if (turnId) this.activeTurns.set(threadId, turnId)
      this.#record(threadId, 'turn/start', { turn: turnId, turnId })
      this.emit('status', { sessionId: threadId, running: true, status: 'working', updatedAt: receivedAt })
      return
    }
    if (method === 'item/agentMessage/delta') {
      const index = (this.#streamState(threadId, turnId).index += 1)
      this.emit('event', { topic: 'assistant', kind: 'session/assistant-stream', sessionId: threadId, data: { sessionId: threadId, frame: { type: 'chunk', revision: this.#streamState(threadId, turnId).revision, attemptId: turnId, index, chunk: { delta: { text: params.delta ?? '' } } } } })
      return
    }
    if (method === 'item/commandExecution/outputDelta') {
      this.#record(threadId, 'tool/progress', {
        turn: turnId,
        callId: params.itemId,
        delta: params.delta ?? '',
        stream: params.stream ?? 'stdout',
      })
      return
    }
    if (method === 'item/mcpToolCall/progress') {
      this.#record(threadId, 'tool/progress', {
        turn: turnId,
        callId: params.itemId,
        delta: params.message ?? params.delta ?? '',
        stream: 'progress',
      })
      return
    }
    if (method === 'item/reasoning/summaryTextDelta'
      || method === 'item/reasoning/textDelta'
      || method === 'item/plan/delta') {
      this.#record(threadId, 'assistant/reasoning-delta', {
        turn: turnId,
        itemId: params.itemId,
        delta: params.delta ?? '',
      })
      return
    }
    if (method === 'item/started') {
      const item = params.item ?? {}
      if (toolLike(item)) this.#record(threadId, 'tool/call', { turn: turnId, callId: item.id, name: toolName(item), arguments: toolArguments(item), description: item.reason ?? null })
      return
    }
    if (method === 'item/completed') {
      const item = params.item ?? {}
      if (item.type === 'agentMessage') this.#record(threadId, 'assistant/message', { turn: turnId, message: { id: item.id, role: 'assistant', content: [{ type: 'text', text: item.text ?? '' }] } })
      else if (item.type === 'reasoning' || item.type === 'plan') this.#record(threadId, 'assistant/message', { turn: turnId, message: { id: item.id, role: 'assistant', content: [{ type: 'reasoning', text: item.text ?? joinText(item.summary) }] } })
      else if (toolLike(item)) this.#record(threadId, 'tool/result', { turn: turnId, callId: item.id, output: item.aggregatedOutput ?? item.result ?? item.diff ?? '', error: item.status === 'failed' ? { message: item.error?.message ?? 'tool failed' } : null, meta: { exitCode: item.exitCode, durationMs: item.durationMs } })
      return
    }
    if (method === 'turn/completed') {
      this.activeTurns.delete(threadId)
      const status = params.turn?.status ?? 'completed'
      this.#record(threadId, 'turn/end', { turn: turnId, reason: status === 'failed' ? { kind: 'error', message: params.turn?.error?.message ?? 'Codex turn failed' } : status === 'interrupted' ? { kind: 'interrupted' } : { kind: 'completed' } })
      const stream = this.#streamState(threadId, turnId)
      this.emit('event', { topic: 'assistant', kind: 'session/assistant-stream', sessionId: threadId, data: { sessionId: threadId, frame: { type: 'end', revision: stream.revision, attemptId: turnId, index: stream.index, outcome: status } } })
      this.emit('status', { sessionId: threadId, running: false, status: status === 'failed' ? 'errored' : 'idle', updatedAt: receivedAt })
      return
    }
    if (method === 'thread/archived' || method === 'thread/deleted') {
      this.threads.delete(threadId)
      this.emit('event', { topic: 'sessions', kind: 'session/removed', sessionId: threadId, data: { sessionId: threadId } })
      return
    }
  }

  #serverRequest(request) {
    const method = request.method
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'item/permissions/requestApproval') {
      const requestId = `codex-${request.requestId}`
      const interaction = { kind: 'approval', appRequestId: request.requestId, method, params: request.params }
      this.pendingInteractions.set(requestId, interaction)
      this.emit('event', { topic: 'approvals', kind: 'approval/request', sessionId: request.params.threadId, data: { requestId, sessionId: request.params.threadId, turnId: request.params.turnId, type: method, toolName: method.includes('commandExecution') ? 'command' : method.includes('fileChange') ? 'fileChange' : 'permissions', command: request.params.command, cwd: request.params.cwd, reason: request.params.reason, details: request.params } })
      return
    }
    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      const requestId = `codex-${request.requestId}`
      this.pendingInteractions.set(requestId, { kind: 'question', appRequestId: request.requestId, method, params: request.params })
      this.emit('event', { topic: 'approvals', kind: 'question/request', sessionId: request.params.threadId, data: { requestId, sessionId: request.params.threadId, turnId: request.params.turnId, questions: request.params.questions ?? [], message: request.params.message, details: request.params } })
      return
    }
    this.app.respondError(request.requestId, -32601, `unsupported client request ${method}`)
  }

  #record(threadId, type, data) {
    const localSeq = (this.eventSeq.get(threadId) ?? 0) + 1
    this.eventSeq.set(threadId, localSeq)
    const seq = LIVE_SEQ_BASE + localSeq
    const event = { type, seq, time: Date.now(), data }
    const list = this.events.get(threadId) ?? []
    list.push(event)
    if (list.length > EVENT_LIMIT) list.splice(0, list.length - EVENT_LIMIT)
    this.events.set(threadId, list)
    this.emit('event', { topic: 'sessions', kind: 'session/event', sessionId: threadId, data: { sessionId: threadId, ...event } })
    return event
  }

  #streamState(threadId, turnId) {
    const key = `${threadId}:${turnId ?? 'unknown'}`
    this.streams ??= new Map()
    if (!this.streams.has(key)) this.streams.set(key, { revision: Date.now(), index: -1 })
    return this.streams.get(key)
  }
}

function pathKey(path) {
  const value = resolve(String(path))
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function threadToEvents(thread) {
  const events = []
  let seq = 0
  let turnNumber = 0
  for (const turn of thread?.turns ?? []) {
    turnNumber += 1
    const time = toMs(turn.startedAt ?? thread.updatedAt ?? thread.createdAt)
    events.push({ type: 'turn/start', seq: ++seq, time, data: { turn: turnNumber, turnId: turn.id } })
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') events.push({ type: 'user/message', seq: ++seq, time, data: { turn: turnNumber, message: { role: 'user', content: normalizeUserContent(item.content) } } })
      else if (item.type === 'agentMessage') events.push({ type: 'assistant/message', seq: ++seq, time, data: { turn: turnNumber, message: { id: item.id, role: 'assistant', content: [{ type: 'text', text: item.text ?? '' }] } } })
      else if (item.type === 'reasoning' || item.type === 'plan') events.push({ type: 'assistant/message', seq: ++seq, time, data: { turn: turnNumber, message: { id: item.id, role: 'assistant', content: [{ type: 'reasoning', text: item.text ?? joinText(item.summary) }] } } })
      else if (toolLike(item)) {
        events.push({ type: 'tool/call', seq: ++seq, time, data: { turn: turnNumber, callId: item.id, name: toolName(item), arguments: toolArguments(item) } })
        events.push({ type: 'tool/result', seq: ++seq, time, data: { turn: turnNumber, callId: item.id, output: item.aggregatedOutput ?? item.result ?? item.diff ?? '', error: item.status === 'failed' ? { message: item.error?.message ?? 'tool failed' } : null } })
      }
    }
    const status = turn.status ?? 'completed'
    events.push({ type: 'turn/end', seq: ++seq, time: toMs(turn.completedAt ?? turn.startedAt ?? thread.updatedAt), data: { turn: turnNumber, reason: status === 'failed' ? { kind: 'error', message: turn.error?.message ?? 'Codex turn failed' } : status === 'interrupted' ? { kind: 'interrupted' } : { kind: 'completed' } } })
  }
  return events
}

/**
 * Reads only the newest window from Codex's append-only rollout file.
 * Sequence numbers are derived from byte offsets, so they remain stable across
 * process restarts and can be used directly as `beforeSeq` cursors.
 */
export async function readCodexRolloutPage(thread, { beforeSeq, limit = 200 } = {}) {
  const path = rolloutPathOf(thread)
  if (!path) throw new Error('Codex thread has no rollout path')
  const info = await stat(path)
  const numericBefore = Number(beforeSeq)
  const end = Number.isFinite(numericBefore) && numericBefore < LIVE_SEQ_BASE
    ? Math.max(0, Math.min(info.size, Math.floor(numericBefore / ROLLOUT_SEQ_FACTOR)))
    : info.size
  const wanted = Math.max(1, Math.min(Number(limit) || 200, 1000))
  const collected = []
  let eventCount = 0
  let earliestOffset = end
  let contiguousOldestSeq = null
  let needsTurnContext = true

  await readLinesReverse(path, end, (line, offset) => {
    let record
    try { record = JSON.parse(line) } catch { return false }
    const events = rolloutRecordToEvents(record, offset)
    if (!events.length) return false
    const hasUserContext = events.some((event) => event.type === 'user/message' || event.type === 'turn/start')
    if (eventCount < wanted) {
      collected.push(...events.reverse())
      eventCount += events.length
      earliestOffset = Math.min(earliestOffset, offset)
      contiguousOldestSeq = Math.min(contiguousOldestSeq ?? Number.MAX_SAFE_INTEGER, ...events.map((event) => event.seq))
      if (hasUserContext) needsTurnContext = false
      if (eventCount < wanted) return false
      return !needsTurnContext
    }
    // A very tool-heavy active turn may exceed one page. Include its opening user
    // message as lightweight context, but keep the cursor at the contiguous page
    // boundary so the skipped middle can still be loaded on the next request.
    if (hasUserContext) {
      collected.push(...events.reverse())
      earliestOffset = Math.min(earliestOffset, offset)
      return true
    }
    return end - offset > 16 * 1024 * 1024
  })

  const events = collected.reverse()
  return {
    events,
    // A freshly-created Codex thread may already have a rollout file that only
    // contains session metadata.  No protocol event was collected in that
    // case, so reporting hasMore would make the UI offer an earlier page that
    // can never contain a message.
    hasMore: events.length > 0 && earliestOffset > 0,
    oldestSeq: contiguousOldestSeq ?? events[0]?.seq ?? null,
    newestSeq: events.at(-1)?.seq ?? null,
    source: 'codex-rollout',
  }
}

async function readLinesReverse(path, end, visit) {
  const handle = await open(path, 'r')
  const chunkSize = 128 * 1024
  let position = end
  let carry = Buffer.alloc(0)
  try {
    while (position > 0) {
      const start = Math.max(0, position - chunkSize)
      const chunk = Buffer.alloc(position - start)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start)
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), carry])
      const newlines = []
      for (let i = 0; i < combined.length; i += 1) if (combined[i] === 10) newlines.push(i)

      const firstComplete = start === 0 ? -1 : (newlines[0] ?? combined.length)
      let segmentEnd = combined.length
      for (let i = newlines.length - 1; i >= 0; i -= 1) {
        const newline = newlines[i]
        const segmentStart = newline + 1
        if (segmentStart < segmentEnd && newline >= firstComplete) {
          const offset = start + segmentStart
          const line = combined.subarray(segmentStart, segmentEnd).toString('utf8').replace(/\r$/, '')
          if (line && visit(line, offset)) return
        }
        segmentEnd = newline
      }

      if (start === 0) {
        const firstEnd = newlines[0] ?? combined.length
        const line = combined.subarray(0, firstEnd).toString('utf8').replace(/\r$/, '')
        if (line) visit(line, 0)
        return
      }
      carry = combined.subarray(0, newlines[0] ?? combined.length)
      position = start
    }
  } finally {
    await handle.close()
  }
}

function rolloutRecordToEvents(record, offset) {
  if (record?.type !== 'event_msg') return []
  const payload = record.payload ?? {}
  const time = toMs(record.timestamp)
  const turn = stableTurn(payload.turn_id)
  const seq = (part = 0) => offset * ROLLOUT_SEQ_FACTOR + part

  if (payload.type === 'task_started') {
    return [{ type: 'turn/start', seq: seq(), time, data: { turn, turnId: payload.turn_id } }]
  }
  if (payload.type === 'task_complete') {
    return [{
      type: 'turn/end', seq: seq(), time: toMs(payload.completed_at ?? record.timestamp),
      data: { turn, turnId: payload.turn_id, reason: { kind: 'completed' } },
    }]
  }
  if (payload.type !== 'item_completed' || !payload.item) return []

  const item = payload.item
  const kind = String(item.type ?? '').toLowerCase()
  if (kind === 'usermessage') {
    return [{
      type: 'user/message', seq: seq(), time,
      data: {
        turn,
        turnId: payload.turn_id,
        clientMessageId: item.client_id ?? null,
        message: { id: item.id, role: 'user', content: normalizeRolloutContent(item.content) },
      },
    }]
  }
  if (kind === 'agentmessage') {
    const text = joinText(item.content)
    if (!text) return []
    return [{
      type: 'assistant/message', seq: seq(), time,
      data: { turn, turnId: payload.turn_id, message: { id: item.id, role: 'assistant', content: [{ type: 'text', text }] } },
    }]
  }
  if (kind === 'reasoning' || kind === 'plan') {
    const text = joinText(item.summary_text ?? item.summary ?? item.raw_content)
    if (!text) return []
    return [{
      type: 'assistant/message', seq: seq(), time,
      data: { turn, turnId: payload.turn_id, message: { id: item.id, role: 'assistant', content: [{ type: 'reasoning', text }] } },
    }]
  }
  if (!rolloutToolLike(kind)) return []

  const callId = item.call_id ?? item.id ?? `tool-${offset}`
  const output = truncateToolOutput(item.aggregated_output ?? item.formatted_output ?? item.stdout ?? item.result ?? item.diff ?? '')
  return [
    {
      type: 'tool/call', seq: seq(), time,
      data: { turn, turnId: payload.turn_id, callId, name: rolloutToolName(kind, item), arguments: rolloutToolArguments(kind, item) },
    },
    {
      type: 'tool/result', seq: seq(1), time: toMs(payload.completed_at_ms ?? record.timestamp),
      data: {
        turn,
        turnId: payload.turn_id,
        callId,
        output,
        error: item.status === 'failed' ? { message: item.error?.message ?? item.stderr ?? 'tool failed' } : null,
        meta: { exitCode: item.exit_code ?? item.exitCode, durationMs: durationMs(item.duration) },
      },
    },
  ]
}

function normalizeRolloutContent(content) {
  const blocks = []
  for (const part of Array.isArray(content) ? content : []) {
    const type = String(part?.type ?? '').toLowerCase()
    if (type === 'text' || type === 'input_text') blocks.push({ type: 'text', text: String(part.text ?? '') })
    else if (type === 'local_image' && part.path) blocks.push({ type: 'image', path: String(part.path), name: basename(String(part.path)) })
    else if ((type === 'image' || type === 'input_image') && part.path) blocks.push({ type: 'image', path: String(part.path), name: basename(String(part.path)) })
  }
  return blocks
}

function normalizePromptContent(content, fallbackText) {
  if (!Array.isArray(content)) return [{ type: 'text', text: fallbackText }]
  return content.map((part) => {
    if (part?.type === 'text') return { type: 'text', text: String(part.text ?? '') }
    if ((part?.type === 'image' || part?.type === 'file') && part.path) return { type: part.type, path: String(part.path), name: part.name }
    return null
  }).filter(Boolean)
}

function eventIdentity(event) {
  const data = event?.data ?? {}
  const turn = data.turnId ?? data.turn ?? ''
  if (event?.type === 'turn/start' || event?.type === 'turn/end') return `${event.type}:${turn}`
  if (event?.type === 'tool/call' || event?.type === 'tool/result') return `${event.type}:${data.callId ?? data.id ?? ''}`
  if (event?.type === 'assistant/message') {
    const id = data.message?.id
    return id ? `${event.type}:${id}` : `${event.type}:${turn}:${contentText(data.message?.content)}`
  }
  if (event?.type === 'user/message') return `${event.type}:${turn}:${contentText(data.message?.content)}`
  return `${event?.type}:${event?.seq}`
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => typeof part === 'string' ? part : part?.text ?? part?.path ?? '').join('\n')
}

function rolloutToolLike(kind) {
  return ['commandexecution', 'filechange', 'mcptoolcall', 'dynamictoolcall', 'collabtoolcall', 'websearch', 'imageview'].includes(kind)
}

function rolloutToolName(kind, item) {
  if (kind === 'commandexecution') return 'shell'
  if (kind === 'filechange') return 'apply_patch'
  return item.tool ?? item.name ?? kind
}

function rolloutToolArguments(kind, item) {
  if (item.arguments != null) return item.arguments
  if (kind === 'commandexecution') return { command: item.command, cwd: fromFileUrl(item.cwd) }
  if (kind === 'filechange') return { changes: item.changes }
  return { query: item.query, path: item.path }
}

function truncateToolOutput(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const limit = 64 * 1024
  return text.length > limit ? `${text.slice(0, limit)}\n…（输出已截断，可在本机查看完整结果）` : text
}

function durationMs(value) {
  if (Number.isFinite(value)) return Number(value)
  if (!value || typeof value !== 'object') return null
  return Number(value.secs ?? 0) * 1000 + Number(value.nanos ?? 0) / 1_000_000
}

function stableTurn(value) {
  const input = String(value ?? 'unknown')
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) hash = Math.imul(hash ^ input.charCodeAt(i), 16777619)
  return hash >>> 0
}

async function rolloutEndSeq(thread) {
  const path = rolloutPathOf(thread)
  if (!path) return 0
  return (await stat(path)).size * ROLLOUT_SEQ_FACTOR + (ROLLOUT_SEQ_FACTOR - 1)
}

function rolloutPathOf(thread) {
  const value = thread?.path ?? thread?.rolloutPath ?? null
  if (!value) return null
  return fromFileUrl(String(value))
}

function fromFileUrl(value) {
  if (!String(value ?? '').startsWith('file:')) return value
  try { return fileURLToPath(value) } catch { return value }
}

function normalizeModelEntry(item) {
  const id = item.id ?? item.model
  const efforts = Array.isArray(item.supportedReasoningEfforts)
    ? item.supportedReasoningEfforts.map((entry) => {
      const effortId = typeof entry === 'string' ? entry : entry?.reasoningEffort ?? entry?.id
      return {
        id: String(effortId ?? ''),
        name: effortName(effortId),
        ...(typeof entry === 'object' && entry?.description ? { description: entry.description } : {}),
      }
    }).filter((entry) => entry.id)
    : []
  return {
    id,
    model: id,
    label: item.displayName ?? item.name ?? id,
    ...(efforts.length ? { reasoning: { efforts, defaultEffort: item.defaultReasoningEffort } } : {}),
  }
}

function effortName(value) {
  return ({ none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高' })[value] ?? String(value ?? '')
}

function filePayload(path, buffer, info) {
  const mime = mimeType(path)
  const binary = mime.startsWith('image/') || mime === 'application/pdf' || buffer.subarray(0, 8192).includes(0)
  if (binary) return { path, name: basename(path), size: info.size, modifiedAt: info.mtimeMs, mime, binary: true, dataBase64: buffer.toString('base64') }
  const text = buffer.toString('utf8')
  return { path, name: basename(path), size: info.size, modifiedAt: info.mtimeMs, mime, binary: false, encoding: 'utf8', text, content: text }
}

function mimeType(path) {
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
    '.json': 'application/json', '.md': 'text/markdown', '.html': 'text/html', '.css': 'text/css',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
    '.txt': 'text/plain', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.xml': 'application/xml',
  })[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function normalizeThread(thread, activeTurns, permissions) {
  const id = thread.id
  const activeTurnId = activeTurns.get(id) ?? thread.status?.active?.turnId ?? null
  const permission = permissions.get(id)
  return {
    sessionId: id,
    nativeSessionId: id,
    title: thread.name ?? thread.preview ?? 'Codex',
    cwd: thread.cwd ?? null,
    model: permission?.model || thread.model
      ? { provider: 'openai', model: permission?.model ?? thread.model, reasoningEffort: permission?.effort ?? thread.reasoningEffort ?? undefined }
      : null,
    running: !!activeTurnId,
    status: activeTurnId ? 'working' : runtimeStatus(thread.status),
    blank: !(thread.preview || thread.turns?.length),
    createdAt: toMs(thread.createdAt),
    updatedAt: toMs(thread.updatedAt ?? thread.createdAt),
    activeTurnId,
    origin: thread.source ?? 'codex',
    attached: true,
  }
}

function runtimeStatus(status) {
  if (typeof status === 'string') return status
  if (status?.notLoaded !== undefined) return 'idle'
  if (status?.systemError) return 'errored'
  return 'idle'
}

function toolLike(item) { return ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'webSearch', 'imageView'].includes(item?.type) }
function toolName(item) { return item.type === 'commandExecution' ? 'shell' : item.type === 'fileChange' ? 'apply_patch' : item.tool ?? item.type ?? 'tool' }
function toolArguments(item) { return item.arguments ?? { command: item.command, cwd: item.cwd, changes: item.changes, query: item.query, path: item.path } }
function joinText(value) { return Array.isArray(value) ? value.map((part) => typeof part === 'string' ? part : part?.text ?? '').join('\n') : String(value ?? '') }
function normalizeUserContent(content) { return (Array.isArray(content) ? content : []).map((part) => typeof part === 'string' ? { type: 'text', text: part } : part?.type === 'text' ? { type: 'text', text: part.text } : part) }
function requiredId(params) { const id = String(params.sessionId ?? params.threadId ?? ''); if (!id) throw protocolError(ERROR_CODES.INVALID_PARAMS, 'sessionId is required'); return id }
function promptText(params) { if (typeof params.prompt === 'string') return params.prompt; if (typeof params.text === 'string') return params.text; return (params.content ?? []).filter((part) => part?.type === 'text').map((part) => String(part.text ?? '')).join('\n') }
function toMs(value) { if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : Date.now() }
function fingerprint(key) { return key.length > 16 ? `${key.slice(0, 10)}…${key.slice(-4)}` : '***' }

function isTurnsUnavailable(error) {
  return Number(error?.code) === -32601
    || /(?:list[_ ]turns|includeTurns|method .*not found|not supported yet)/i.test(String(error?.message ?? ''))
}

function permissionSettings(preset = 'workspace-write') {
  if (preset === 'read-only') return { preset, approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }
  if (preset === 'full-access') return { preset, approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  return { preset: 'workspace-write', approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } }
}

function assertAllowedPath(path, prefixes = []) {
  const allowed = (prefixes?.length ? prefixes : [process.cwd()]).map((value) => resolve(value).toLowerCase())
  const normalized = resolve(path).toLowerCase()
  if (!allowed.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}\\`) || normalized.startsWith(`${prefix}/`))) {
    throw protocolError(ERROR_CODES.FORBIDDEN, `path is outside allowed roots: ${path}`)
  }
}
