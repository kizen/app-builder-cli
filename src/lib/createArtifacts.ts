/**
 * Starter artifacts `create` scaffolds (KZN-17594).
 *
 * The file contents live under `src/templates/artifacts/` as real `.json`,
 * `.js` and `.css` files, mirroring the layout they are scaffolded into, and
 * are inlined at bundle time via the `?raw` imports below (see `assets.d.ts`
 * and the `raw` esbuild plugin in `tsup.config.ts`). This module only records
 * which files belong to which artifact type.
 *
 * Two layers decide whether a scaffolded artifact survives publish, and they
 * disagree about what matters:
 *
 * - `@kizenapps/packager` reads each `config.json` and silently coerces
 *   anything malformed (a bad `field_type` becomes `phonenumber`, a bad
 *   `minimized_style` becomes `circle`). It raises no error for a missing
 *   artifact field, so a green `appbuilder build` proves very little here.
 * - webapp's `PublishPluginAppSerializer` is the real gate. It creates each
 *   artifact with `Model.objects.create(**item_data)` and no defaulting, so a
 *   field the packager never emitted is simply absent and publish 400s.
 *
 * Every template therefore carries the fields webapp requires, noted per type
 * below. `runBuild.test.ts` asserts them against the packaged bundle.
 */
import helloFrameConfig from '../templates/artifacts/floatingFrames/helloFrame/config.json?raw';
import helloFrameScript from '../templates/artifacts/floatingFrames/helloFrame/script.js?raw';
import helloFrameStyles from '../templates/artifacts/floatingFrames/helloFrame/styles.css?raw';
import helloBlockConfig from '../templates/artifacts/blocks/helloBlock/config.json?raw';
import helloBlockScript from '../templates/artifacts/blocks/helloBlock/script.js?raw';
import helloBlockStyles from '../templates/artifacts/blocks/helloBlock/styles.css?raw';
import helloAdornmentConfig from '../templates/artifacts/dataAdornments/helloAdornment/config.json?raw';
import helloAdornmentScript from '../templates/artifacts/dataAdornments/helloAdornment/script.js?raw';
import helloPageConfig from '../templates/artifacts/pages/helloPage/config.json?raw';
import helloPageScript from '../templates/artifacts/pages/helloPage/script.js?raw';
import helloPageStyles from '../templates/artifacts/pages/helloPage/styles.css?raw';
import helloPageGreet from '../templates/artifacts/pages/helloPage/eventScripts/greet.js?raw';
import helloToolbarItemConfig from '../templates/artifacts/toolbarItems/helloToolbarItem/config.json?raw';
import helloToolbarItemScript from '../templates/artifacts/toolbarItems/helloToolbarItem/script.js?raw';
import helloObjectSettingsItemConfig from '../templates/artifacts/objectSettingsItems/helloObjectSettingsItem/config.json?raw';
import helloObjectSettingsItemScript from '../templates/artifacts/objectSettingsItems/helloObjectSettingsItem/script.js?raw';
import helloActionConfig from '../templates/artifacts/actions/helloAction/config.json?raw';
import helloActionScript from '../templates/artifacts/actions/helloAction/script.js?raw';

/**
 * Artifact types `create` can scaffold. Calendar sources, route scripts and
 * automation steps are deliberately excluded: automation steps would pull in a
 * Python `script.py` path, and neither of the others is useful in a starter
 * shell.
 */
export const ARTIFACT_TYPES = [
  'floatingFrame',
  'block',
  'dataAdornment',
  'page',
  'toolbarItem',
  'objectSettingsItem',
  'jsAction',
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Human-readable names, used by the interactive picker. */
export const ARTIFACT_LABELS: Record<ArtifactType, string> = {
  floatingFrame: 'Floating frame',
  block: 'Block',
  dataAdornment: 'Data adornment',
  page: 'Routable page',
  toolbarItem: 'Toolbar item',
  objectSettingsItem: 'Object settings item',
  jsAction: 'JS action',
};

export interface ScaffoldedFile {
  /** POSIX-style path relative to the plugin root. */
  path: string;
  content: string;
}

interface ArtifactTemplate {
  /** Component directory the packager discovers this type under. */
  directory: string;
  /** camelCase component directory name. */
  component: string;
  /**
   * File contents keyed by POSIX path relative to the component directory.
   * The packager picks these up by name and position: `config.json` and
   * `script.js` always, `styles.css` as `css` on frames and pages and `styles`
   * on blocks, and `eventScripts/<name>.js` keyed by `<name>`.
   */
  files: Readonly<Record<string, string>>;
}

const TEMPLATES: Record<ArtifactType, ArtifactTemplate> = {
  // webapp requires api_name, name, title and `type`. `type` is deliberately
  // absent from config.json: the packager hardcodes `type: 'script'` and never
  // reads one, so setting it would be inert. `minimized_style` is optional at
  // webapp (model default `bar`) and set only for clarity.
  floatingFrame: {
    directory: 'floatingFrames',
    component: 'helloFrame',
    files: {
      'config.json': helloFrameConfig,
      'script.js': helloFrameScript,
      'styles.css': helloFrameStyles,
    },
  },

  // webapp requires only api_name and name; a block's script is optional
  // (unlike toolbar and object-settings items).
  block: {
    directory: 'blocks',
    component: 'helloBlock',
    files: {
      'config.json': helloBlockConfig,
      'script.js': helloBlockScript,
      'styles.css': helloBlockStyles,
    },
  },

  // Data adornments carry no api_name at all - the packager has no such field
  // for them, by design. `field_type` is the only webapp-required field, and
  // it must be one of: phonenumber | date | datetime.
  dataAdornment: {
    directory: 'dataAdornments',
    component: 'helloAdornment',
    files: {
      'config.json': helloAdornmentConfig,
      'script.js': helloAdornmentScript,
    },
  },

  // webapp requires api_name, name and `type`. `type` is not read from
  // config.json - the packager derives it (pages default to "script").
  page: {
    directory: 'pages',
    component: 'helloPage',
    files: {
      'config.json': helloPageConfig,
      'script.js': helloPageScript,
      'styles.css': helloPageStyles,
      'eventScripts/greet.js': helloPageGreet,
    },
  },

  // webapp requires api_name, label AND a non-blank script, so script.js must
  // not be empty.
  toolbarItem: {
    directory: 'toolbarItems',
    component: 'helloToolbarItem',
    files: {
      'config.json': helloToolbarItemConfig,
      'script.js': helloToolbarItemScript,
    },
  },

  // Same non-blank script requirement as toolbar items.
  objectSettingsItem: {
    directory: 'objectSettingsItems',
    component: 'helloObjectSettingsItem',
    files: {
      'config.json': helloObjectSettingsItemConfig,
      'script.js': helloObjectSettingsItemScript,
    },
  },

  // webapp requires api_name (the serializer forces it even though the model
  // allows null), name, and a non-blank hint_object_name.
  jsAction: {
    directory: 'actions',
    component: 'helloAction',
    files: {
      'config.json': helloActionConfig,
      'script.js': helloActionScript,
    },
  },
};

/** Files for a single artifact type, as POSIX paths relative to the plugin root. */
export function artifactFiles(type: ArtifactType, entryDir = 'src'): ScaffoldedFile[] {
  const { directory, component, files } = TEMPLATES[type];

  return Object.entries(files).map(([relativePath, content]) => ({
    path: `${entryDir}/${directory}/${component}/${relativePath}`,
    content,
  }));
}

/**
 * Files for a set of artifact types. Duplicates are ignored so a caller can
 * pass a selection list without de-duping it first.
 */
export function scaffoldArtifactFiles(
  types: readonly ArtifactType[],
  entryDir = 'src',
): ScaffoldedFile[] {
  return [...new Set(types)].flatMap((type) => artifactFiles(type, entryDir));
}
