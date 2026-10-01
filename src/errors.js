// Messages are application-owned. Never pass through remote bodies or exceptions.
export class RadarError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function safeError(error) {
  return error instanceof RadarError
    ? { code: error.code, message: error.message }
    : { code: 'internal_error', message: 'An unexpected local error occurred.' };
}
