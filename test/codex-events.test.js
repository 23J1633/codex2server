import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAdapter, readCodexRolloutPage, threadToEvents } from '../lib/codex-adapter.js'
import { VERSION } from '../index.js'

test('runtime version matches package metadata', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, manifest.version)
})

test('Codex thread history maps into the unified DSH-compatible event model', () => {
  const events = threadToEvents({
    id: 'thread-1',
    createdAt: 1,
    updatedAt: 2,
    turns: [{
      id: 'turn-1',
      status: 'completed',
      startedAt: 1,
      completedAt: 2,
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
        { type: 'commandExecution', id: 'tool-1', command: 'node --version', cwd: '/tmp', status: 'completed', aggregatedOutput: 'v22' },
        { type: 'agentMessage', id: 'a1', text: 'done' },
      ],
    }],
  })
  assert.deepEqual(events.map((event) => event.type), ['turn/start', 'user/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end'])
  assert.equal(events[2].data.name, 'shell')
  assert.equal(events[3].data.output, 'v22')
})

test('failed Codex turns retain a stable error reason', () => {
  const events = threadToEvents({ turns: [{ id: 't', status: 'failed', error: { message: 'boom' }, items: [] }] })
  assert.deepEqual(events.at(-1).data.reason, { kind: 'error', message: 'boom' })
})

test('Codex rollout history pages from the tail and keeps local image references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex2server-rollout-'))
  const path = join(root, 'rollout.jsonl')
  const records = [
    { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'hello' }, { type: 'local_image', path: 'C:\\Temp\\shot.png' }] } } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'done' }] } } },
    { timestamp: '2026-01-01T00:00:03Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', completed_at: 1767225603 } },
  ]
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  try {
    const page = await readCodexRolloutPage({ path }, { limit: 2 })
    assert.deepEqual(page.events.map((event) => event.type), ['user/message', 'assistant/message', 'turn/end'])
    assert.deepEqual(page.events[0].data.message.content[1], { type: 'image', path: 'C:\\Temp\\shot.png', name: 'shot.png' })
    assert.ok(page.oldestSeq > page.events[0].seq, 'cursor must stay at the contiguous boundary')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a metadata-only Codex rollout is an empty final page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex2server-metadata-rollout-'))
  const path = join(root, 'rollout.jsonl')
  await writeFile(path, `${JSON.stringify({
    timestamp: '2026-01-01T00:00:00Z',
    type: 'session_meta',
    payload: { id: 'blank-thread', cwd: root },
  })}\n`)
  try {
    const page = await readCodexRolloutPage({ path }, { limit: 100 })
    assert.deepEqual(page.events, [])
    assert.equal(page.hasMore, false)
    assert.equal(page.oldestSeq, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('session.create enforces the cwd allowlist and uses thread/start sandbox enums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex2server-cwd-'))
  const allowed = join(root, 'allowed')
  const outside = join(root, 'outside')
  await mkdir(allowed)
  await mkdir(outside)
  const adapter = new CodexAdapter({
    executable: 'codex',
    defaultCwd: allowed,
    allowedCwdPrefixes: [allowed],
    permissionPreset: 'workspace-write',
    approvalPolicy: 'on-request',
  }, { logger: { debug() {}, warn() {} } })
  let startParams
  adapter.app.request = async (method, params) => {
    assert.equal(method, 'thread/start')
    startParams = params
    return { thread: { id: 'thread-1', cwd: params.cwd, createdAt: Date.now(), updatedAt: Date.now() } }
  }
  try {
    await assert.rejects(adapter.handle('session.create', { cwd: outside }), (error) => error?.code === 'forbidden')
    const created = await adapter.handle('session.create', { cwd: allowed })
    assert.equal(created.sessionId, 'thread-1')
    assert.equal(startParams.sandbox, 'workspace-write')
    assert.equal(startParams.approvalPolicy, 'on-request')
  } finally {
    await adapter.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a blank Codex thread treats unsupported list_turns as empty history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex2server-empty-thread-'))
  const adapter = new CodexAdapter({
    executable: 'codex',
    defaultCwd: root,
    allowedCwdPrefixes: [root],
    permissionPreset: 'workspace-write',
    approvalPolicy: 'on-request',
  }, { logger: { debug() {}, warn() {} }, configDir: root })
  adapter.app.request = async (method, params) => {
    if (method === 'thread/start') {
      return { thread: { id: 'blank-thread', cwd: params.cwd, createdAt: Date.now(), updatedAt: Date.now() } }
    }
    if (method === 'thread/read') {
      const error = new Error('Codex app-server -32601: list_turns is not supported yet')
      error.code = -32601
      throw error
    }
    throw new Error(`unexpected method ${method}`)
  }
  try {
    const created = await adapter.handle('session.create', { cwd: root })
    const events = await adapter.handle('session.events', { sessionId: created.sessionId, limit: 100 })
    assert.deepEqual(events, { events: [], hasMore: false, oldestSeq: null, newestSeq: null })
  } finally {
    await adapter.close()
    await rm(root, { recursive: true, force: true })
  }
})
