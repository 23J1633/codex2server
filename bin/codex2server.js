#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexAppServer } from '../lib/codex-app-server.js'
import { Logger } from '../lib/a2s/logger.js'
import { replaceFilePortable } from '../lib/a2s/shared-config.js'
import { createCodex2Server, loadConfig, VERSION } from '../index.js'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { command, options } = parseArgs(process.argv.slice(2))

try {
  if (command === 'doctor') await doctor()
  else if (command === 'config') await showConfig()
  else if (command === 'status') await showStatus()
  else if (command === 'start') await start()
  else usage(1)
} catch (error) {
  console.error(`[codex2server] ${error?.stack || error}`)
  process.exitCode = 1
}

async function start() {
  const app = await createCodex2Server(options)
  if (!app.config.enabled) {
    console.log('[codex2server] disabled in the shared A2S config')
    await app.adapter.close()
    return
  }
  const runtimeFile = join(dirname(app.sharedFile), 'runtime', 'codex.json')
  let writeTimer
  let writeChain = Promise.resolve()
  const queueStatus = (document) => {
    writeChain = writeChain
      .then(() => atomicJson(runtimeFile, document))
      .catch((error) => app.logger.warn(`cannot persist runtime status: ${error.message}`))
    return writeChain
  }
  const writeStatus = (status = app.client.status()) => {
    clearTimeout(writeTimer)
    const document = {
      version: 1,
      plugin: 'codex2server',
      pluginVersion: VERSION,
      installPath: PLUGIN_ROOT,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      running: true,
      ...status,
    }
    writeTimer = setTimeout(() => void queueStatus(document), 25)
  }
  app.client.on('status', writeStatus)
  app.client.start()
  writeStatus()
  const statusTimer = setInterval(() => writeStatus(), 30000)

  const shutdown = async (signal) => {
    app.logger.info(`received ${signal}, shutting down`)
    app.client.off('status', writeStatus)
    clearTimeout(writeTimer)
    clearInterval(statusTimer)
    await writeChain
    await app.client.close(signal)
    await atomicJson(runtimeFile, { version: 1, plugin: 'codex2server', pluginVersion: VERSION, installPath: PLUGIN_ROOT, pid: process.pid, running: false, connected: false, stoppedAt: new Date().toISOString() })
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGHUP', () => void shutdown('SIGHUP'))
}

async function doctor() {
  const loaded = await loadConfig(options)
  const logger = new Logger('codex2server-doctor', 'warn')
  const app = new CodexAppServer(loaded.config, logger)
  let threadCount = null
  let modelCount = null
  let error = null
  try {
    await app.start()
    const threads = await app.request('thread/list', { limit: 10, sortKey: 'updated_at', archived: false, useStateDbOnly: false })
    threadCount = Array.isArray(threads?.data) ? threads.data.length : 0
    const models = await app.request('model/list', {}).catch(() => null)
    modelCount = Array.isArray(models?.data ?? models?.models) ? (models.data ?? models.models).length : null
  } catch (cause) {
    error = cause.message
  } finally {
    await app.close()
  }
  const report = {
    ok: !error,
    plugin: 'codex2server',
    pluginVersion: VERSION,
    node: process.version,
    configFile: loaded.sharedFile,
    instanceId: loaded.config.instanceId,
    locale: loaded.config.locale,
    resolvedLocale: loaded.config.resolvedLocale,
    keyFingerprint: fingerprint(loaded.config.key),
    endpoints: loaded.config.endpoints,
    executable: loaded.config.executable,
    codexHome: loaded.config.codexHome,
    appServer: error ? { initialized: false, error } : { initialized: true, threadCount, modelCount },
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

async function showConfig() {
  const loaded = await loadConfig(options)
  console.log(JSON.stringify({ ...loaded.config, key: fingerprint(loaded.config.key), sharedConfigFile: loaded.sharedFile }, null, 2))
}

async function showStatus() {
  const loaded = await loadConfig(options)
  const file = join(dirname(loaded.sharedFile), 'runtime', 'codex.json')
  try { console.log(await readFile(file, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') console.log(JSON.stringify({ running: false, connected: false }, null, 2))
    else throw error
  }
}

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await replaceFilePortable(temporary, file)
}

function parseArgs(args) {
  let command = 'start'
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]
    if (!value.startsWith('-') && i === 0) command = value
    else if (value === '--config') options.configFile = args[++i]
    else if (value === '--shared-config') options.sharedConfigFile = args[++i]
    else if (value === '--locale') options.overrides = { ...(options.overrides || {}), locale: args[++i] }
    else if (value === '--help' || value === '-h') usage(0)
    else if (value === '--version' || value === '-v') { console.log(VERSION); process.exit(0) }
    else throw new Error(`unknown option ${value}`)
  }
  return { command, options }
}

function fingerprint(key) { return key.length > 16 ? `${key.slice(0, 10)}…${key.slice(-4)}` : '***' }

function usage(code) {
  console.log('Usage: codex2server [start|doctor|config|status] [--shared-config FILE] [--config FILE] [--locale system|zh-CN|en-US]')
  process.exit(code)
}
