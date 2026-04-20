import { useRef, useState, type FC } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
import { DropdownPortal } from './DropdownPortal.js';

export interface TypeaheadOption {
  id: string;
  label: string;
}

interface TypeaheadProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  onSelect: (id: string, label: string) => void;
  options: TypeaheadOption[];
  loading: boolean;
  placeholder?: string;
  disabled?: boolean;
  keepOpenOnSelect?: boolean;
}

export const Typeahead: FC<TypeaheadProps> = ({
  label,
  value,
  onChange,
  onSelect,
  options,
  loading,
  placeholder,
  disabled,
  keepOpenOnSelect,
}) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label className="text-[11px] font-semibold uppercase tracking-widest text-neutral-500">
          {label}
        </label>
      )}
      <div ref={anchorRef} className="relative">
        <FontAwesomeIcon
          icon={faMagnifyingGlass}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-neutral-400"
        />
        <input
          type="text"
          className="w-full rounded border border-black/10 bg-white py-1.5 pl-7 pr-2.5 font-mono text-[12px] text-neutral-800 focus:border-neutral-400 focus:outline-none disabled:opacity-50"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
          }}
        />
      </div>
      <DropdownPortal anchorRef={anchorRef} open={open}>
        {loading && <div className="px-3 py-2 text-[12px] text-neutral-400">Loading…</div>}
        {!loading && options.length === 0 && value.length === 0 && (
          <div className="px-3 py-2 text-[12px] text-neutral-400">Start typing to search…</div>
        )}
        {!loading && options.length === 0 && value.length > 0 && (
          <div className="px-3 py-2 text-[12px] text-neutral-400">No results</div>
        )}
        {!loading &&
          options.map((opt) => (
            <div
              key={opt.id}
              className="cursor-pointer px-3 py-2 text-[12px] text-neutral-800 hover:bg-neutral-100"
              onClick={() => {
                onSelect(opt.id, opt.label);

                if (!keepOpenOnSelect) {
                  setOpen(false);
                }
              }}
            >
              {opt.label}
            </div>
          ))}
      </DropdownPortal>
    </div>
  );
};
