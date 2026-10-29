import type { ReactElement } from 'react';
import type { CommandChoice } from '../lib/commandCore.js';
import { SelectList, type SelectItem } from './SelectList.js';

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
  choices: readonly TChoice[];
  onPick: (choice: TChoice) => void;
  onCancel: () => void;
  initial?: string;
  searchable?: boolean;
}

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
