import { render } from 'ink';
import type { PickAccount } from '../lib/oauthCommands.js';
import { SelectList } from './SelectList.js';

/**
 * `login`'s saved-account picker (`items` come from `accountPickerItems`), rendered until a choice
 * or cancel (Esc, or Ctrl+C, which ink exits on). Unmounting resolves `waitUntilExit`.
 */
export const pickInTerminal: PickAccount = async (title, items) => {
  let picked: string | undefined;
  const app = render(
    <SelectList
      title={title}
      items={items}
      onSelect={(item) => {
        picked = item.key;
        app.unmount();
      }}
      onCancel={() => {
        app.unmount();
      }}
    />,
  );

  await app.waitUntilExit();

  return picked;
};
