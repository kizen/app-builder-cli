import type { FC } from 'react';
import { Text, useInput } from 'ink';

export interface ConfirmPromptProps {
  prompt: string;
  strict: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

export const ConfirmPrompt: FC<ConfirmPromptProps> = ({ prompt, strict, onAccept, onCancel }) => {
  useInput((input, key) => {
    if (key.ctrl) {
      return;
    }

    const answer = input.toLowerCase();

    if (answer === 'y' || (!strict && key.return)) {
      onAccept();
    } else if (strict || answer === 'n' || key.escape) {
      onCancel();
    }
  });

  return <Text bold>{prompt}</Text>;
};

export interface ProductionConfirmProps {
  isProduction: boolean;
  strict?: boolean;
  prompt: string;
  productionPrompt: string;
  onAccept: () => void;
  onCancel: () => void;
}

export const ProductionConfirm: FC<ProductionConfirmProps> = ({
  isProduction,
  strict = false,
  prompt,
  productionPrompt,
  onAccept,
  onCancel,
}) => (
  <>
    {isProduction && (
      <Text color="red" bold>
        PRODUCTION
      </Text>
    )}
    <ConfirmPrompt
      prompt={isProduction || strict ? productionPrompt : prompt}
      strict={isProduction || strict}
      onAccept={onAccept}
      onCancel={onCancel}
    />
  </>
);
