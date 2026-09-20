import { randomBytes, createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { normalizeLocaleSetting, resolveLocale } from './locale.js'

export const SHARED_CONFIG_VERSION = 1

export function defaultConfigDir(env = process.env, platform = process.platform) {
  if (env.A2S_CONFIG_DIR?.trim()) return resolve(env.A2S_CONFIG_DIR.trim())
  if (platform === 'win32') return join(env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'), 'A2S')
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'A2S')
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'a2s')
}

export function defaultConfigFile(env = process.env, platform = process.platform) {
  return env.A2S_CONFIG_PATH?.trim() || join(defaultConfigDir(env, platform), 'config.json')
}

export function generateDeviceKey() {
  return `a2sk_${randomBytes(32).toString('base64url')}`
}

export function deriveDeviceId(env = process.env) {
  const seed = `${safeHost()}|${safeUser()}|${env.COMPUTERNAME ?? ''}`
  return `a2s-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`
}

export function createDefaultConfig() {
  const deviceId = deriveDeviceId()
  return {
    version: SHARED_CONFIG_VERSION,
    device: {
      id: deviceId,
      name: safeHost(),
      key: generateDeviceKey(),
      createdAt: new Date().toISOString(),
    },
    server: {
      endpoints: [],
      transport: 'auto',
    },
    agents: {
      dsh: { enabled: true, locale: 'system', instanceId: `${deviceId}:dsh` },
      claude: { enabled: true, locale: 'system', instanceId: `${deviceId}:claude`, defaultCwd: process.cwd() },
      codex: { enabled: true, locale: 'system', instanceId: `${deviceId}:codex`, defaultCwd: process.cwd() },
    },
    plugins: {
      catalogUrl: '',
      installDir: join(defaultConfigDir(), 'plugins'),
    },
  }
}

export async function ensureSharedConfig(file = defaultConfigFile()) {
  try {
    return normalizeSharedConfig(JSON.parse(await readFile(file, 'utf8')), file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`cannot read A2S config ${file}: ${error.message}`)
  }

  const created = createDefaultConfig()
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  try {
    const handle = await open(file, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(created, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    return normalizeSharedConfig(created, file)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return normalizeSharedConfig(JSON.parse(await readFile(file, 'utf8')), file)
  }
}

export async function writeSharedConfig(document, file = defaultConfigFile()) {
  const normalized = normalizeSharedConfig(document, file)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(normalized.document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await replaceFilePortable(temporary, file)
  return normalized
}

export async function replaceFilePortable(source, target) {
  try {
    await rename(source, target)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }

  const backup = `${target}.${process.pid}.${process.hrtime.bigint()}.bak`
  const lockFile = `${target}.lock`
  let hasBackup = false
  try {
    await writeFile(lockFile, `${process.pid} ${Date.now()}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      await copyFile(target, backup)
      hasBackup = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await copyFile(source, target)
      const handle = await open(target, 'r+')
      try { await handle.sync() } finally { await handle.close() }
    } catch (error) {
      if (hasBackup) await copyFile(backup, target)
      else await rm(target, { force: true }).catch(() => undefined)
      throw error
    }
  } finally {
    await rm(source, { force: true }).catch(() => undefined)
    if (hasBackup) await rm(backup, { force: true }).catch(() => undefined)
    await rm(lockFile, { force: true }).catch(() => undefined)
  }
}

export function normalizeSharedConfig(document, file = defaultConfigFile()) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new TypeError('A2S config must be an object')
  const device = document.device && typeof document.device === 'object' ? document.device : {}
  const server = document.server && typeof document.server === 'object' ? document.server : {}
  if (typeof device.id !== 'string' || !device.id.trim()) throw new TypeError('A2S config device.id is required')
  if (typeof device.key !== 'string' || device.key.length < 16) throw new TypeError('A2S config device.key must contain at least 16 characters')
  const endpoints = normalizeEndpoints(server.endpoints ?? server.endpoint ?? [])
  const transport = server.transport ?? 'auto'
  if (!['auto', 'ws', 'http'].includes(transport)) throw new TypeError('A2S config server.transport must be auto, ws, or http')
  const normalizedDocument = {
    ...document,
    version: SHARED_CONFIG_VERSION,
    device: { ...device, id: device.id.trim(), key: device.key.trim(), name: String(device.name || safeHost()) },
    server: withoutServerAdminKey(server, { endpoints, transport }),
    agents: document.agents && typeof document.agents === 'object' ? document.agents : {},
    plugins: document.plugins && typeof document.plugins === 'object' ? document.plugins : {},
  }
  return { file, document: normalizedDocument }
}

function withoutServerAdminKey(server, normalized) {
  const { adminKey: _serverOwnerCredential, ...safeServer } = server
  return { ...safeServer, ...normalized }
}

export function resolveAgentConfig(shared, agentType, overrides = {}, env = process.env) {
  const document = shared.document ?? shared
  const block = document.agents?.[agentType] ?? {}
  const upper = agentType.toUpperCase()
  const endpoints = normalizeEndpoints(
    overrides.endpoints ??
      env[`${upper}2SERVER_ENDPOINT`] ??
      env.A2S_ENDPOINTS ??
      document.server?.endpoints ??
      [],
  )
  const key = String(overrides.key ?? env[`${upper}2SERVER_KEY`] ?? env.A2S_KEY ?? document.device.key)
  if (key.length < 16) throw new TypeError('the shared device key must contain at least 16 characters')
  const instanceId = String(overrides.instanceId ?? block.instanceId ?? `${document.device.id}:${agentType}`)
  return {
    ...block,
    ...overrides,
    agentType,
    enabled: overrides.enabled ?? block.enabled ?? true,
    endpoints,
    key,
    instanceId,
    deviceId: document.device.id,
    displayName: String(overrides.displayName ?? block.displayName ?? document.device.name ?? safeHost()),
    locale: normalizeLocaleSetting(overrides.locale ?? block.locale),
    resolvedLocale: resolveLocale(overrides.locale ?? block.locale),
    transport: overrides.transport ?? document.server?.transport ?? 'auto',
    wsPath: overrides.wsPath ?? '/ws',
    eventsPath: overrides.eventsPath ?? '/events',
    inboxPath: overrides.inboxPath ?? '/inbox',
    heartbeatMs: numberValue(overrides.heartbeatMs, 30000, 1000),
    heartbeatTimeoutMs: numberValue(overrides.heartbeatTimeoutMs, 90000, 5000),
    requestTimeoutMs: numberValue(overrides.requestTimeoutMs, 30000, 1000),
    pollWaitMs: numberValue(overrides.pollWaitMs, 25000, 0),
    reconnectInitialDelayMs: numberValue(overrides.reconnectInitialDelayMs, 1000, 50),
    reconnectMaxDelayMs: numberValue(overrides.reconnectMaxDelayMs, 60000, 100),
    bufferSize: numberValue(overrides.bufferSize, 2000, 0),
    maxPayloadBytes: numberValue(overrides.maxPayloadBytes, 4 * 1024 * 1024, 1024),
    logLevel: overrides.logLevel ?? block.logLevel ?? 'info',
  }
}

export function normalizeEndpoints(value) {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',')
  const result = []
  for (const entry of entries) {
    const text = String(entry ?? '').trim().replace(/\/+$/, '')
    if (!text) continue
    const url = new URL(text)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new TypeError(`unsupported endpoint protocol: ${url.protocol}`)
    const normalized = url.toString().replace(/\/+$/, '')
    if (!result.includes(normalized)) result.push(normalized)
  }
  return result
}

function numberValue(value, fallback, min) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(number) || number < min) throw new TypeError(`expected a number >= ${min}`)
  return Math.floor(number)
}

function safeHost() {
  try { return hostname() || 'unknown-host' } catch { return 'unknown-host' }
}

function safeUser() {
  try { return userInfo().username || 'unknown-user' } catch { return 'unknown-user' }
}
