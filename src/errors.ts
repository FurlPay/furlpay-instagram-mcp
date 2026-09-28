export class InstagramError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>, public retryable = false) {
    super(message);
    this.name = 'InstagramError';
  }
}
export function publicError(error: unknown, requestId: string) {
  if (error instanceof InstagramError) return { success: false as const, error: {
    code: error.code, message: error.message, request_id: requestId, ...error.details,
  } };
  return { success: false as const, error: { code: 'INSTAGRAM_INTERNAL_ERROR', message: 'The operation failed. Contact the operator with the request ID.', request_id: requestId } };
}
export function required(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new InstagramError(code, message);
}
