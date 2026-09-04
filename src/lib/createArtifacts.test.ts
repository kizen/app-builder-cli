import { describe, expect, it } from 'vitest';
import { ARTIFACT_TYPES, artifactFiles, scaffoldArtifactFiles } from './createArtifacts.js';

describe('artifactFiles', () => {
  it.each(ARTIFACT_TYPES)('%s ships a config.json and a script.js', (type) => {
    const names = artifactFiles(type).map((file) => file.path.split('/').at(-1));

    expect(names).toContain('config.json');
    expect(names).toContain('script.js');
  });

  it.each(ARTIFACT_TYPES)('%s config.json is valid JSON', (type) => {
    const config = artifactFiles(type).find((file) => file.path.endsWith('/config.json'));

    expect(() => {
      JSON.parse(config?.content ?? '');
    }).not.toThrow();
  });

  it.each(ARTIFACT_TYPES)('%s script.js is not blank', (type) => {
    const script = artifactFiles(type).find((file) => file.path.endsWith('/script.js'));

    expect(script?.content.trim()).not.toBe('');
  });

  it('places files under <entryDir>/<directory>/<component>/', () => {
    for (const file of artifactFiles('page', 'custom')) {
      expect(file.path).toMatch(/^custom\/pages\/helloPage\//);
    }
  });
});

describe('scaffoldArtifactFiles', () => {
  it('returns nothing for an empty selection', () => {
    expect(scaffoldArtifactFiles([])).toEqual([]);
  });

  it('ignores duplicate types', () => {
    expect(scaffoldArtifactFiles(['block', 'block'])).toEqual(scaffoldArtifactFiles(['block']));
  });

  it('never emits two files at the same path', () => {
    const paths = scaffoldArtifactFiles(ARTIFACT_TYPES).map((file) => file.path);

    expect(new Set(paths).size).toBe(paths.length);
  });
});
