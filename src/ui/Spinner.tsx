import type { FC } from 'react';
import { useEffect, useState } from 'react';
import { Text } from 'ink';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const Spinner: FC = () => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => {
      clearInterval(id);
    };
  }, []);

  return <Text color="cyan">{SPINNER_FRAMES[frame] ?? '⠋'}</Text>;
};
