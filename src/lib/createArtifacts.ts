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
  path: string;
  content: string;
}

interface ArtifactTemplate {
  directory: string;
  component: string;
  files: Readonly<Record<string, string>>;
}

const TEMPLATES: Record<ArtifactType, ArtifactTemplate> = {
  floatingFrame: {
    directory: 'floatingFrames',
    component: 'helloFrame',
    files: {
      'config.json': helloFrameConfig,
      'script.js': helloFrameScript,
      'styles.css': helloFrameStyles,
    },
  },

  block: {
    directory: 'blocks',
    component: 'helloBlock',
    files: {
      'config.json': helloBlockConfig,
      'script.js': helloBlockScript,
      'styles.css': helloBlockStyles,
    },
  },

  dataAdornment: {
    directory: 'dataAdornments',
    component: 'helloAdornment',
    files: {
      'config.json': helloAdornmentConfig,
      'script.js': helloAdornmentScript,
    },
  },

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

  toolbarItem: {
    directory: 'toolbarItems',
    component: 'helloToolbarItem',
    files: {
      'config.json': helloToolbarItemConfig,
      'script.js': helloToolbarItemScript,
    },
  },

  objectSettingsItem: {
    directory: 'objectSettingsItems',
    component: 'helloObjectSettingsItem',
    files: {
      'config.json': helloObjectSettingsItemConfig,
      'script.js': helloObjectSettingsItemScript,
    },
  },

  jsAction: {
    directory: 'actions',
    component: 'helloAction',
    files: {
      'config.json': helloActionConfig,
      'script.js': helloActionScript,
    },
  },
};

export function artifactFiles(type: ArtifactType, entryDir = 'src'): ScaffoldedFile[] {
  const { directory, component, files } = TEMPLATES[type];

  return Object.entries(files).map(([relativePath, content]) => ({
    path: `${entryDir}/${directory}/${component}/${relativePath}`,
    content,
  }));
}

export function scaffoldArtifactFiles(
  types: readonly ArtifactType[],
  entryDir = 'src',
): ScaffoldedFile[] {
  return [...new Set(types)].flatMap((type) => artifactFiles(type, entryDir));
}
