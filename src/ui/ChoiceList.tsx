import type { ReactElement } from 'react';
import type { CommandChoice } from '../lib/commandCore.js';
import { SelectList, type SelectItem } from './SelectList.js';

/** A SelectList onSelect that hands the picked element of `list` to `fn`. */
export function pick<T>(
  list: readonly T[],
  fn: (value: T) => void,
): (item: SelectItem, index: number) => void {
  return (_item, index) => {
    const value = list[index];

    if (value !== undefined) {
      fn(value);
    }
  };
}

export interface ChoiceListProps<TChoice extends CommandChoice> {
  title: string;
  /** A `needs_choice` failure's choices, such as the environments signed in to. */
  choices: readonly TChoice[];
  onPick: (choice: TChoice) => void;
  onCancel: () => void;
  /** The choice (by value) the cursor starts on. */
  initial?: string;
  /** Typing filters the choices. */
  searchable?: boolean;
}

/** Picks one of a `needs_choice` failure's choices, listed by label. */
export function ChoiceList<TChoice extends CommandChoice>({
  title,
  choices,
  onPick,
  onCancel,
  initial,
  searchable = false,
}: ChoiceListProps<TChoice>): ReactElement {
  return (
    <SelectList
      title={title}
      items={choices.map((choice) => ({ key: choice.value, label: choice.label }))}
      onSelect={pick(choices, onPick)}
      onCancel={onCancel}
      {...(initial !== undefined && { initialKey: initial })}
      searchable={searchable}
    />
  );
}
