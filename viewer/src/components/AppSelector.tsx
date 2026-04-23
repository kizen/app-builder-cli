import { useEffect, useRef, useState, type FC } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
import type { BundlePlugin } from '../types.js';
import { DropdownPortal } from './DropdownPortal.js';

interface AppSelectorProps {
  bundle: BundlePlugin[];
  currentApiName: string | undefined;
}

export const AppSelector: FC<AppSelectorProps> = ({ bundle, currentApiName }) => {
  const navigate = useNavigate();
  const anchorRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onDocMouseDown = (e: MouseEvent): void => {
      const anchor = anchorRef.current;

      if (anchor && e.target instanceof Node && anchor.contains(e.target)) {
        return;
      }

      setOpen(false);
    };

    document.addEventListener('mousedown', onDocMouseDown);

    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
    };
  }, [open]);

  const currentApp = currentApiName ? bundle.find((a) => a.api_name === currentApiName) : undefined;
  const currentLabel = currentApp ? currentApp.name : 'Select app…';

  if (bundle.length <= 1) {
    return (
      <span className="max-w-[220px] truncate px-1 text-[12px] font-medium text-neutral-700">
        {bundle[0]?.name ?? currentLabel}
      </span>
    );
  }

  return (
    <div ref={anchorRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
        }}
        className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1 text-[12px] font-medium text-neutral-700 hover:border-black/20 hover:text-neutral-900"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="max-w-[220px] truncate">{currentLabel}</span>
        <FontAwesomeIcon icon={faChevronDown} className="text-[10px] text-neutral-400" />
      </button>
      <DropdownPortal anchorRef={anchorRef} open={open}>
        <ul role="listbox" className="py-1">
          {bundle.map((app) => {
            const apiName = app.api_name;
            const isActive = apiName === currentApiName;

            return (
              <li
                key={apiName}
                role="option"
                aria-selected={isActive}
                className={`cursor-pointer truncate px-3 py-2 text-[12px] hover:bg-neutral-100 ${
                  isActive ? 'bg-neutral-100 font-semibold text-neutral-900' : 'text-neutral-700'
                }`}
                onClick={() => {
                  void navigate({ to: '/$apiName/summary', params: { apiName } });
                  setOpen(false);
                }}
              >
                {app.name}
              </li>
            );
          })}
        </ul>
      </DropdownPortal>
    </div>
  );
};
