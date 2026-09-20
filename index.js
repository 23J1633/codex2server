import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { CodexAdapter } from './lib/codex-adapter.js'
import { Logger } from './lib/a2s/logger.js'
import { RelayClient } from './lib/a2s/relay-client.js'
import { defaultConfigFile, ensureSharedConfig, resolveAgentConfig } from './lib/a2s/shared-config.js'

export const VERSION = '0.1.6'

export async function loadConfig(options = {}) {
  const sharedFile = options.sharedConfigFile ?? defaultConfigFile()
  const shared = await ensureSharedConfig(sharedFile)
  let local = {}
  if (options.configFile) {
    try { local = JSON.parse(await readFile(resolve(options.configFile), 'utf8')) } catch (error) { throw new Error(`cannot read codex2server config: ${error.message}`) }
  }
  const defaultCwd = local.defaultCwd ?? options.overrides?.defaultCwd ?? shared.document.agents?.codex?.defaultCwd ?? process.cwd()
  const configuredExecutable = process.env.CODEX_EXE || shared.document.agents?.codex?.executable || (process.platform === 'win32' ? 'codex.exe' : 'codex')
  const config = resolveAgentConfig(shared, 'codex', {
    executable: process.platform === 'win32' && configuredExecutable === 'codex.cmd' ? 'codex.exe' : configuredExecutable,
    defaultCwd,
    codexHome: process.env.CODEX_HOME || null,
    model: null,
    effort: null,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    permissionPreset: 'workspace-write',
    codexRequestTimeoutMs: 60000,
    allowedCwdPrefixes: [defaultCwd],
    pluginVersion: VERSION,
    ...local,
    ...options.overrides,
  })
  return { shared, sharedFile, config }
}

export async function createCodex2Server(options = {}) {
  const loaded = await loadConfig(options)
  const logger = options.logger ?? new Logger('codex2server', loaded.config.logLevel)
  const adapter = await new CodexAdapter(loaded.config, { logger, configDir: dirname(loaded.sharedFile) }).init()
  const client = new RelayClient({ config: loaded.config, adapter, logger, version: VERSION })
  return { ...loaded, logger, adapter, client }
}

export { CodexAdapter, RelayClient }
