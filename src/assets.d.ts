// Allows importing plain-text asset files (e.g. requirements.txt) as strings.
// tsup is configured with loader: { '.txt': 'text' } which makes esbuild inline
// the file content at bundle time.
declare module '*.txt' {
  const content: string;
  export default content;
}
