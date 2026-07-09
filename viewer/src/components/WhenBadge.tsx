import type { FC } from 'react';
import type { UnknownJSON } from '@kizenapps/engine';
import { useWhenEnabled } from '../hooks/useWhenEnabled.js';
import { Tooltip } from './Tooltip.js';

interface WhenBadgeProps {
  when: string;
  whenState: Record<string, UnknownJSON>;
}

export const WhenBadge: FC<WhenBadgeProps> = ({ when, whenState }) => {
  const result = useWhenEnabled(when, whenState);

  if (result === null) {
    return null;
  }

  return (
    <Tooltip text={when}>
      <span className={`font-mono text-[10px] ${result ? 'text-green-600' : 'text-amber-600'}`}>
        {result ? 'enabled' : 'disabled'} by condition
      </span>
    </Tooltip>
  );
};
