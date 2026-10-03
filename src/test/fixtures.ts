import type { Block, DeployablePlugin, RoutablePage } from '@kizenapps/packager';

/** An empty script view; pass overrides for the fields a test cares about. */
export const routablePage = (overrides: Partial<RoutablePage> = {}): RoutablePage => ({
  name: 'Detail',
  api_name: 'detail_view',
  type: 'script',
  css: '',
  event_scripts: {},
  callback: '',
  is_toolbar_item: false,
  toolbar_color: '',
  toolbar_icon: '',
  script: '',
  html: '',
  iframe_url: '',
  ...overrides,
});

/** A packaged plugin carrying only custom_blocks. */
export const makePlugin = (apiName: string, blocks: Block[]): DeployablePlugin =>
  ({ api_name: apiName, artifacts: { custom_blocks: blocks } }) as unknown as DeployablePlugin;
