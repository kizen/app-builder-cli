import type { FC } from 'react';
import { createElement } from 'react';
import { render, useApp } from 'ink';
import type { PickAccount, PickerItem } from '../lib/oauthCommands.js';
import { SelectList } from './SelectList.js';

export interface AccountPickerProps {
  title: string;
  items: readonly PickerItem[];
  /** The chosen item's key, or undefined if the picker was cancelled. Called once. */
  onDone: (key: string | undefined) => void;
}

/** `login`'s saved-account picker: `items` come from `accountPickerItems`. */
export const AccountPicker: FC<AccountPickerProps> = ({ title, items, onDone }) => {
  const app = useApp();

  return (
    <SelectList
      title={title}
      items={items}
      onSelect={(item) => {
        onDone(item.key);
        app.exit();
      }}
      onCancel={() => {
        onDone(undefined);
        app.exit();
      }}
    />
  );
};

/** Renders the picker until a choice or cancel (Esc, or Ctrl+C, which ink exits on). */
export const pickInTerminal: PickAccount = async (title, items) => {
  let picked: string | undefined;
  const { waitUntilExit } = render(
    createElement(AccountPicker, {
      title,
      items,
      onDone: (key) => {
        picked = key;
      },
    }),
  );

  await waitUntilExit();

  return picked;
};
