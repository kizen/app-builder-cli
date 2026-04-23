import { useCallback, useState } from 'react';

export function useLogHistory(limit: number): [string[], (message: string) => void] {
  const [history, setHistory] = useState<string[]>([]);

  const append = useCallback(
    (message: string): void => {
      setHistory((h) => [...h, `${new Date().toLocaleTimeString()}: ${message}`].slice(-limit));
    },
    [limit],
  );

  return [history, append];
}
