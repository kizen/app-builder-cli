import { useCallback, useState } from 'react';

/**
 * useState backed by localStorage.
 *
 * On mount, attempts to read and JSON-parse the stored value. Falls back to
 * `defaultValue` on missing key or parse error. The setter persists the new
 * value via JSON.stringify; passing `null` removes the key entirely.
 */
export function useLocalStorage<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);

      if (raw === null) {
        return defaultValue;
      }

      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  });

  const set = useCallback(
    (newValue: T): void => {
      setValue(newValue);

      if (newValue === null || newValue === undefined) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify(newValue));
      }
    },
    [key],
  );

  return [value, set];
}
