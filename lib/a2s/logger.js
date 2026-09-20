const LEVELS = Object.freeze({ silent: 100, error: 40, warn: 30, info: 20, debug: 10 })

export class Logger {
  constructor(scope, level = 'info', sink = console) {
    this.scope = scope
    this.level = LEVELS[level] === undefined ? 'info' : level
    this.sink = sink
  }

  setLevel(level) {
    if (LEVELS[level] !== undefined) this.level = level
  }

  debug(...args) { this.#write('debug', args) }
  info(...args) { this.#write('info', args) }
  warn(...args) { this.#write('warn', args) }
  error(...args) { this.#write('error', args) }

  #write(level, args) {
    if (LEVELS[level] < LEVELS[this.level]) return
    const method = level === 'debug' ? 'log' : level
    this.sink[method]?.(`[${new Date().toISOString()}] [${this.scope}] [${level}]`, ...args)
  }
}
