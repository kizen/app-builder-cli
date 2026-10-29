import type { FC } from 'react';
import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { searchItems } from '../lib/listSearch.js';
import { moveCursor, visibleWindow } from '../lib/moveCursor.js';

export interface SelectItem {
  key: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectListProps {
  title: string;
  items: readonly SelectItem[];
  onSelect: (item: SelectItem, index: number) => void;
  onCancel?: () => void;
  hint?: string;
  initialKey?: string;
  searchable?: boolean;
}

const DEFAULT_HINT = '↑/↓ to move, Enter to select, Esc to cancel';
const SEARCH_HINT = 'Type to filter, ↑/↓ to move, Enter to select, Esc to clear or cancel';
const PAGE_SIZE = 10;

const initialCursor = (items: readonly SelectItem[], initialKey?: string): number => {
  const wanted = items.findIndex((item) => item.key === initialKey && item.disabled !== true);

  if (wanted !== -1) {
    return wanted;
  }

  const clamped = moveCursor(0, items.length, 0);

  if (items[clamped]?.disabled !== true) {
    return clamped;
  }

  const firstEnabled = items.findIndex((item) => item.disabled !== true);

  return firstEnabled === -1 ? clamped : firstEnabled;
};

export const SelectList: FC<SelectListProps> = ({
  title,
  items,
  onSelect,
  onCancel,
  hint,
  initialKey,
  searchable = false,
}) => {
  const [query, setQuery] = useState('');
  const shown = useMemo(
    () => searchItems(items, searchable ? query : ''),
    [items, searchable, query],
  );
  const shownItems = useMemo(() => shown.map(({ item }) => item), [shown]);
  const [cursorState, setCursorState] = useState(() => initialCursor(items, initialKey));
  const disabled = useMemo(() => shownItems.map((item) => item.disabled === true), [shownItems]);
  const cursor = moveCursor(cursorState, shownItems.length, 0);

  useInput((input, key) => {
    const move = (delta: number): void => {
      setCursorState(moveCursor(cursor, shownItems.length, delta, { disabled }));
    };

    const search = (next: string): void => {
      setQuery(next);
      setCursorState(initialCursor(searchItems(items, next).map(({ item }) => item)));
    };

    if (key.upArrow || (!searchable && input === 'k')) {
      move(-1);
    } else if (key.downArrow || (!searchable && input === 'j')) {
      move(1);
    } else if (key.pageUp) {
      move(-PAGE_SIZE);
    } else if (key.pageDown) {
      move(PAGE_SIZE);
    } else if (key.return) {
      const entry = shown[cursor];

      if (entry !== undefined && entry.item.disabled !== true) {
        onSelect(entry.item, entry.index);
      }
    } else if (key.escape) {
      if (searchable && query !== '') {
        search('');
      } else {
        onCancel?.();
      }
    } else if (searchable && (key.backspace || key.delete)) {
      search(query.slice(0, -1));
    } else if (searchable && input !== '' && !key.ctrl && !key.meta && !key.tab) {
      search(query + input);
    }
  });

  const { start, end } = visibleWindow(cursor, shownItems.length, PAGE_SIZE);
  const above = start;
  const below = shownItems.length - end;

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      {searchable && <Text>{`Filter: ${query}`}</Text>}
      <Box flexDirection="column">
        {above > 0 && <Text dimColor>{`  ↑ ${String(above)} more`}</Text>}
        {searchable && shownItems.length === 0 && <Text dimColor> No matches</Text>}
        {shownItems.slice(start, end).map((item, offset) => {
          const index = start + offset;
          const selected = index === cursor;
          const itemDisabled = item.disabled === true;
          const highlight = selected && !itemDisabled;

          return (
            <Box key={item.key} gap={2}>
              <Text {...(highlight && { color: 'cyan' as const })} dimColor={itemDisabled}>
                {selected ? '❯' : ' '}
              </Text>
              <Text
                bold={highlight}
                dimColor={itemDisabled}
                {...(highlight && { color: 'cyan' as const })}
              >
                {item.label}
              </Text>
              {item.description !== undefined && <Text dimColor>{item.description}</Text>}
            </Box>
          );
        })}
        {below > 0 && <Text dimColor>{`  ↓ ${String(below)} more`}</Text>}
      </Box>
      <Text dimColor>{hint ?? (searchable ? SEARCH_HINT : DEFAULT_HINT)}</Text>
    </Box>
  );
};
