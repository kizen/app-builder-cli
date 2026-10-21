/** `arg` as one pasteable shell argument: bare when it's plain, else JSON-quoted (escapes newlines too). */
export const quoteArg = (arg: string): string =>
  /^[\w./:@=-]+$/.test(arg) ? arg : JSON.stringify(arg);
