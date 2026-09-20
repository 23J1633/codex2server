import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureSharedConfig, resolveAgentConfig } from '../lib/a2s/shared-config.js'

test('Codex and Claude resolve the same shared key with separate instance ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a2s-codex-config-'))
  const shared = await ensureSharedConfig(join(dir, 'config.json'))
  const codex = resolveAgentConfig(shared, 'codex')
  const claude = resolveAgentConfig(shared, 'claude')
  assert.equal(codex.key, claude.key)
  assert.match(codex.instanceId, /:codex$/)
  assert.match(claude.instanceId, /:claude$/)
  assert.equal(codex.locale, 'system')
  assert.match(codex.resolvedLocale, /^(zh-CN|en-US)$/)
  assert.equal(resolveAgentConfig(shared, 'codex', { locale: 'zh-CN' }).resolvedLocale, 'zh-CN')
})
