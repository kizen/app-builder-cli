import type { FC } from 'react';
import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
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
  initialIndex?: number;
  windowSize?: number;
  isActive?: boolean;
}

const DEFAULT_HINT = '↑/↓ to move, Enter to select, Esc to cancel';
const DEFAULT_WINDOW_SIZE = 10;

const initialCursor = (items: readonly SelectItem[], initialIndex: number): number => {
  const clamped = moveCursor(initialIndex, items.length, 0);

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
  hint = DEFAULT_HINT,
  initialIndex = 0,
  windowSize = DEFAULT_WINDOW_SIZE,
  isActive = true,
}) => {
  const [cursorState, setCursorState] = useState(() => initialCursor(items, initialIndex));
  const disabled = useMemo(() => items.map((item) => item.disabled === true), [items]);
  const cursor = moveCursor(cursorState, items.length, 0);
  const pageSize = Math.max(1, Math.floor(windowSize));

  useInput(
    (input, key) => {
      const move = (delta: number): void => {
        setCursorState(moveCursor(cursor, items.length, delta, { disabled }));
      };

      if (key.upArrow || input === 'k') {
        move(-1);
      } else if (key.downArrow || input === 'j') {
        move(1);
      } else if (key.pageUp) {
        move(-pageSize);
      } else if (key.pageDown) {
        move(pageSize);
      } else if (key.return) {
        const item = items[cursor];

        if (item !== undefined && item.disabled !== true) {
          onSelect(item, cursor);
        }
      } else if (key.escape) {
        onCancel?.();
      }
    },
    { isActive },
  );

  const { start, end } = visibleWindow(cursor, items.length, pageSize);
  const above = start;
  const below = items.length - end;

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      <Box flexDirection="column">
        {above > 0 && <Text dimColor>{`  ↑ ${String(above)} more`}</Text>}
        {items.slice(start, end).map((item, offset) => {
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
      <Text dimColor>{hint}</Text>
    </Box>
  );
};
