/** `arg` as one POSIX shell word: bare when it's plain (not a zsh `=cmd`), else single-quoted so nothing in it expands. */
export const quoteArg = (arg: string): string =>
  /^[\w@%+:,./-][\w@%+=:,./-]*$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
