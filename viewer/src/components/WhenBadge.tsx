import { useEffect, useState, type FC } from 'react';
import { getEnabledState } from '@kizenapps/engine/util';
import type { UnknownJSON } from '@kizenapps/engine';
import { Tooltip } from './Tooltip.js';

interface WhenBadgeProps {
  when: string;
  whenState: Record<string, UnknownJSON>;
}

export const WhenBadge: FC<WhenBadgeProps> = ({ when, whenState }) => {
  const [result, setResult] = useState<boolean | null>(null);

  useEffect(() => {
    void getEnabledState(when, whenState)
      .then(setResult)
      .catch(() => {
        setResult(null);
      });
  }, [when, whenState]);

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
