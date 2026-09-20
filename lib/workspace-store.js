import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { replaceFilePortable } from './a2s/shared-config.js'

export class WorkspaceStore {
  constructor(file, logger) {
    this.file = file
    this.logger = logger
    this.items = []
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'))
      this.items = Array.isArray(value?.items) ? value.items.filter((item) => item?.path) : []
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger.warn(`cannot read workspace store ${this.file}: ${error.message}`)
      this.items = []
    }
    return this.items
  }

  list() { return this.items.map((item) => ({ ...item })) }

  async save(items = this.items) {
    this.items = items.map((item) => ({ ...item }))
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.${process.hrtime.bigint()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: this.items }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await replaceFilePortable(temporary, this.file)
  }
}
