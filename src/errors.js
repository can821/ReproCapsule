export class ReproError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ReproError';
    this.code = code;
  }
}
