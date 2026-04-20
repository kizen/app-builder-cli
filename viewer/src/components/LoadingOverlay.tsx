import type { FC } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpinner } from '@fortawesome/free-solid-svg-icons';

interface LoadingOverlayProps {
  visible: boolean;
}

export const LoadingOverlay: FC<LoadingOverlayProps> = ({ visible }) => {
  if (!visible) {
    return null;
  }

  return (
    <span className="absolute inset-0 flex items-center justify-center rounded bg-white/70">
      <FontAwesomeIcon icon={faSpinner} spin className="text-[11px] text-neutral-400" />
    </span>
  );
};
