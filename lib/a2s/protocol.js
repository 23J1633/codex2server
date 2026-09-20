export const PROTOCOL_VERSION = 1

export const ERROR_CODES = Object.freeze({
  BAD_FRAME: 'bad_frame',
  BAD_REQUEST: 'bad_request',
  INVALID_PARAMS: 'invalid_params',
  UNKNOWN_METHOD: 'unknown_method',
  NOT_FOUND: 'not_found',
  SESSION_NOT_FOUND: 'session_not_found',
  AGENT_BUSY: 'agent_busy',
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  DISABLED: 'disabled',
  FORBIDDEN: 'forbidden',
  TIMEOUT: 'timeout',
  CONFLICT: 'conflict',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  INTERNAL: 'internal',
})

export class ProtocolError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.retryable = options.retryable === true
    this.details = options.details
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryable ? { retryable: true } : {}),
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

export function protocolError(code, message, options) {
  return new ProtocolError(code, message, options)
}

export function wireError(error) {
  if (error instanceof ProtocolError) return error.toJSON()
  return {
    code: typeof error?.code === 'string' ? error.code : ERROR_CODES.INTERNAL,
    message: error instanceof Error ? error.message : String(error ?? 'unknown error'),
    ...(error?.retryable === true ? { retryable: true } : {}),
    ...(error?.details === undefined ? {} : { details: error.details }),
  }
}

export function frame(type, fields = {}) {
  return { v: PROTOCOL_VERSION, type, ...fields }
}

export function response(id, result) {
  return frame('response', { id, ok: true, result: result === undefined ? null : result })
}

export function errorResponse(id, error) {
  return frame('response', { id, ok: false, error: wireError(error) })
}

export function parseFrame(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'frame must be a JSON object' }
  }
  if (typeof value.type !== 'string' || !value.type) {
    return { ok: false, reason: 'frame.type must be a non-empty string' }
  }
  if (value.v !== undefined && value.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: `unsupported protocol version ${String(value.v)}` }
  }
  return { ok: true, frame: value }
}
