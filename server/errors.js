export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const toErrorBody = (e) => ({
  error: { code: e.code || 'INTERNAL', message: e instanceof AppError ? e.message : '服务器开小差了，请稍后重试' },
});
