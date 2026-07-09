import { useEffect, useState } from 'react';
import { getEnabledState } from '@kizenapps/engine/util';
import type { UnknownJSON } from '@kizenapps/engine';

// Evaluates a `when` condition through the engine's getEnabledState. Returns
// null while pending, on evaluation failure, or when no condition is set.
export const useWhenEnabled = (
  when: string | undefined,
  whenState: Record<string, UnknownJSON>,
): boolean | null => {
  const [result, setResult] = useState<boolean | null>(null);

  useEffect(() => {
    if (!when) {
      setResult(null);

      return;
    }

    let cancelled = false;

    void getEnabledState(when, whenState)
      .then((enabled) => {
        if (!cancelled) {
          setResult(enabled);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [when, whenState]);

  return result;
};
