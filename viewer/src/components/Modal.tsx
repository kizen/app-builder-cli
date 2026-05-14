import { useState, useCallback, useRef, type FC, useMemo } from 'react';
import type {
  AssistantField,
  ModalConfig,
  RoutablePageConfig,
  SelectOption,
  UnknownJSON,
} from '@kizenapps/engine';
import { DynamicModalContent, type DynamicModalContentHandle } from './DynamicModalContent.js';
import { LoadingOverlay } from './LoadingOverlay.js';
import { Dialog, DialogHeader, type DialogSize } from './Dialog.js';
import { useAppPage } from '@kizenapps/engine/react';

// The engine sends richer block types than ModalBlock declares (number, boolean, select).
// We model the full superset here rather than casting everywhere.
interface FlexBlock {
  type: string;
  // field identifier — dynamic-prompt fields use `key`, legacy modal fields use `id`
  key?: string;
  id?: string;
  // common
  label?: string;
  required?: boolean;
  tooltip?: string;
  placeholder?: string;
  widthPercent?: 50 | 100;
  // description
  content?: string;
  // spacer
  height?: number;
  // text / number
  defaultValue?: string;
  // number
  default?: unknown;
  // boolean
  // `default` above covers bool default too
  // select / dropdown
  options?: SelectOption[];
  allow_multiple?: boolean;
  multiselect?: boolean;
  // container
  fields?: FlexBlock[];
}

// Accept a wider config so `size` and runtime-only block types don't cause TS errors
type FlexConfig = ModalConfig & {
  content?: FlexBlock[];
  size?: 'small' | 'medium' | 'large';
};

const ASSISTANT_FIELD_TYPES: ReadonlySet<AssistantField['type']> = new Set([
  'custom_object',
  'description',
  'container',
  'field',
  'text',
  'number',
  'select',
  'boolean',
]);

// Drops runtime-only block types (e.g. 'spacer') and normalizes id→key so the
// DynamicModalContent's SetupAssistantController only sees rows it understands.
const toAssistantFields = (blocks: FlexBlock[]): AssistantField[] =>
  blocks.flatMap((b): AssistantField[] => {
    const key = b.key ?? b.id;

    if (key === undefined || key === '') {
      return [];
    }

    if (!ASSISTANT_FIELD_TYPES.has(b.type as AssistantField['type'])) {
      return [];
    }

    const field = {
      ...b,
      key,
      type: b.type as AssistantField['type'],
      ...(b.fields !== undefined && { fields: toAssistantFields(b.fields) }),
    } as unknown as AssistantField;

    return [field];
  });

type FieldValues = Record<string, unknown>;

const fieldKey = (b: FlexBlock): string => b.id ?? b.key ?? '';

const buildValues = (blocks: FlexBlock[], fieldValues: FieldValues): UnknownJSON => {
  const result: Record<string, unknown> = {};

  const collect = (block: FlexBlock): void => {
    const k = fieldKey(block);

    if (!k) {
      return;
    }

    if (block.type === 'text') {
      result[k] = { value: (fieldValues[k] as string | undefined) ?? block.defaultValue ?? '' };
    } else if (block.type === 'number') {
      const raw = fieldValues[k] as string | undefined;

      result[k] = {
        value:
          raw !== undefined && raw !== ''
            ? Number(raw)
            : ((block.default as number | undefined) ?? null),
      };
    } else if (block.type === 'boolean') {
      const raw = fieldValues[k];

      result[k] = { value: raw !== undefined ? Boolean(raw) : Boolean(block.default) };
    } else if (block.type === 'select') {
      const raw = (fieldValues[k] as string | undefined) ?? '';
      const option = block.options?.find((o) => o.value === raw);

      result[k] = { value: option ?? (raw ? { value: raw, label: raw } : null) };
    } else if (block.type === 'dropdown') {
      const raw = (fieldValues[k] as string | undefined) ?? block.defaultValue ?? '';
      const option = block.options?.find((o) => o.value === raw);

      result[k] = { value: option ?? (raw ? { value: raw, label: raw } : null) };
    } else if (block.type === 'container') {
      block.fields?.forEach(collect);
    }
  };

  blocks.forEach(collect);

  return result as UnknownJSON;
};

interface FieldProps {
  block: FlexBlock;
  values: FieldValues;
  onChange: (key: string, value: unknown) => void;
}

const Label: FC<{
  label?: string | undefined;
  required?: boolean | undefined;
  tooltip?: string | undefined;
}> = ({ label, required, tooltip }) => (
  <span className="flex items-center gap-1 text-[11px] font-medium text-neutral-500">
    {label}
    {required && <span className="text-red-500">*</span>}
    {tooltip && (
      <span
        className="cursor-help rounded-full border border-neutral-300 px-1 text-[10px] text-neutral-400"
        title={tooltip}
      >
        i
      </span>
    )}
  </span>
);

const ModalField: FC<FieldProps> = ({ block, values, onChange }) => {
  const k = fieldKey(block);

  if (block.type === 'description') {
    return <p className="m-0 text-[13px] text-neutral-700">{block.content}</p>;
  }

  if (block.type === 'spacer') {
    return <div style={{ height: block.height ?? 8 }} />;
  }

  if (block.type === 'text') {
    return (
      <label className="flex flex-col gap-1">
        <Label label={block.label} required={block.required} tooltip={block.tooltip} />
        <input
          type="text"
          value={(values[k] as string | undefined) ?? block.defaultValue ?? ''}
          placeholder={block.placeholder}
          onChange={(e) => {
            onChange(k, e.target.value);
          }}
          className="rounded border border-black/10 px-2 py-1.5 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-neutral-400"
        />
      </label>
    );
  }

  if (block.type === 'number') {
    return (
      <label className="flex flex-col gap-1">
        <Label label={block.label} required={block.required} tooltip={block.tooltip} />
        <input
          type="number"
          value={(values[k] as string | undefined) ?? ''}
          placeholder={block.placeholder}
          onChange={(e) => {
            onChange(k, e.target.value);
          }}
          className="rounded border border-black/10 px-2 py-1.5 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-neutral-400"
        />
      </label>
    );
  }

  if (block.type === 'boolean') {
    const checked = values[k] !== undefined ? Boolean(values[k]) : Boolean(block.default);

    return (
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            onChange(k, e.target.checked);
          }}
          className="h-3.5 w-3.5 rounded border-black/20 accent-neutral-800"
        />
        <span className="flex items-center gap-1 text-[12px] text-neutral-700">
          {block.label}
          {block.required && <span className="text-red-500">*</span>}
          {block.tooltip && (
            <span
              className="cursor-help rounded-full border border-neutral-300 px-1 text-[10px] text-neutral-400"
              title={block.tooltip}
            >
              i
            </span>
          )}
        </span>
      </label>
    );
  }

  if (block.type === 'select' || block.type === 'dropdown') {
    return (
      <label className="flex flex-col gap-1">
        <Label label={block.label} required={block.required} tooltip={block.tooltip} />
        <select
          value={(values[k] as string | undefined) ?? block.defaultValue ?? ''}
          onChange={(e) => {
            onChange(k, e.target.value);
          }}
          className="rounded border border-black/10 bg-white px-2 py-1.5 font-mono text-[12px] focus:outline-none"
        >
          {(block.placeholder != null || !block.required) && (
            <option value="">{block.placeholder ?? '—'}</option>
          )}
          {(block.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (block.type === 'container') {
    return (
      <div className="flex flex-wrap gap-3">
        {(block.fields ?? []).map((child) => (
          <div
            key={fieldKey(child) || child.type}
            style={{ width: child.widthPercent === 50 ? 'calc(50% - 6px)' : '100%' }}
          >
            <ModalField block={child} values={values} onChange={onChange} />
          </div>
        ))}
      </div>
    );
  }

  return null;
};

const ModalCustomContent: FC<{
  pages?: RoutablePageConfig[] | undefined;
  viewId?: string | undefined;
}> = ({ pages, viewId }) => {
  const view = useMemo(() => {
    if (!pages || !viewId) {
      return undefined;
    }

    return pages.find((p) => p.api_name === viewId) ?? undefined;
  }, [pages, viewId]);

  const {
    scriptUIRef,
    outputUIRef,
    scopedCss,
    sanitizedHtml,
    interactableScriptRef,
    iframeURL,
    pending,
  } = useAppPage(view);

  return (
    <div className="relative h-full w-full">
      {pending && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 font-mono text-[11px] text-neutral-400">
          loading…
        </div>
      )}

      {view?.type === 'script' && (
        <>
          <div ref={scriptUIRef} className="h-full w-full p-3" />
          <style>{scopedCss}</style>
        </>
      )}

      {view?.type === 'html' && (
        <div ref={interactableScriptRef} className="h-full overflow-auto p-3">
          {sanitizedHtml && (
            <div className="h-full" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
          )}
          <div ref={outputUIRef} />
          <style>{scopedCss}</style>
        </div>
      )}

      {view?.type === 'iframe' && iframeURL && (
        <iframe src={iframeURL} className="h-full w-full border-0" title={view.name} />
      )}
    </div>
  );
};

interface ModalProps {
  show: boolean;
  config: ModalConfig;
  pluginApiName?: string;
  onConfirm: (values: UnknownJSON) => void;
  onHide: (eventSource: 'button' | 'close', ...args: unknown[]) => void;
  pages?: RoutablePageConfig[];
}

const SIZE_MAP: Record<string, DialogSize> = {
  small: 'sm',
  medium: 'md',
  large: 'xl',
};

export const Modal: FC<ModalProps> = ({
  show,
  config,
  pluginApiName,
  onConfirm,
  onHide,
  pages,
}) => {
  const flex = config as FlexConfig;
  const blocks = (flex.content ?? []) as FlexBlock[];
  const isDynamic = Boolean(flex.dynamic);

  console.log(show, config, pluginApiName);

  const [fieldValues, setFieldValues] = useState<FieldValues>({});
  const [dynamicLoading, setDynamicLoading] = useState(false);
  const dynamicRef = useRef<DynamicModalContentHandle>(null);

  const isCustomView = Boolean(config.viewId);

  const handleChange = useCallback((key: string, value: unknown) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleConfirm = async (): Promise<void> => {
    if (isDynamic && dynamicRef.current) {
      const { isValid, values } = await dynamicRef.current.validateAndGetValues();

      if (!isValid) {
        return;
      }

      onConfirm(values as UnknownJSON);
    } else {
      const values = buildValues(blocks, fieldValues);

      setFieldValues({});
      onConfirm(values);
    }
  };

  const handleHide = (source: 'button' | 'close'): void => {
    setFieldValues({});
    setDynamicLoading(false);
    onHide(source);
  };

  const confirmLabel = config.confirmButton?.label ?? 'Confirm';
  const cancelLabel = config.cancelButton?.label ?? 'Cancel';
  const size = SIZE_MAP[flex.size ?? 'medium'] ?? 'md';

  return (
    <Dialog
      open={show}
      size={size}
      onBackdropClick={() => {
        handleHide('close');
      }}
      header={config.title ? <DialogHeader title={config.title} /> : undefined}
      footer={
        <>
          <button
            onClick={() => {
              handleHide('button');
            }}
            className="rounded border border-black/10 px-3 py-1.5 text-[12px] text-neutral-600 transition-colors hover:bg-black/5"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={isDynamic && dynamicLoading}
            className={`rounded px-3 py-1.5 text-[12px] text-white transition-colors ${
              isDynamic && dynamicLoading
                ? 'cursor-not-allowed bg-neutral-400'
                : 'bg-neutral-900 hover:bg-neutral-700'
            }`}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {isCustomView ? (
        <ModalCustomContent pages={pages} viewId={config.viewId} />
      ) : isDynamic ? (
        <div className="relative max-h-[60vh] overflow-y-auto px-5 py-4">
          <DynamicModalContent
            ref={dynamicRef}
            fields={toAssistantFields(blocks)}
            pluginApiName={pluginApiName ?? flex.pluginApiName ?? ''}
            onLoadingChange={setDynamicLoading}
          />
          <LoadingOverlay visible={dynamicLoading} />
        </div>
      ) : (
        blocks.length > 0 && (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto px-5 py-4">
            {blocks.map((block, i) => (
              <ModalField
                key={fieldKey(block) || `${block.type}-${String(i)}`}
                block={block}
                values={fieldValues}
                onChange={handleChange}
              />
            ))}
          </div>
        )
      )}
    </Dialog>
  );
};
