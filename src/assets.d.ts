// Allows importing plain-text asset files (e.g. requirements.txt) as strings.
// tsup is configured with loader: { '.txt': 'text' } which makes esbuild inline
// the file content at bundle time.
declare module '*.txt' {
  const content: string;
  export default content;
}

// Allows importing any file's contents verbatim with a `?raw` suffix, so that
// scaffold templates can live as real `.js` / `.css` / `.json` / `.md` files
// under src/templates/. Vite (and therefore vitest) supports `?raw` natively;
// the `raw` esbuild plugin in tsup.config.ts inlines them at bundle time.
declare module '*?raw' {
  const content: string;
  export default content;
}
