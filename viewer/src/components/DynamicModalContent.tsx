import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type FC,
  type Ref,
} from 'react';
import type { AssistantField, SetupAssistantConfig, UnknownJSON } from '@kizenapps/engine';
import { SetupAssistantController, useSetupAssistant } from '@kizenapps/engine/react';
import { SetupAssistantRow } from './setup-assistant/SetupAssistantRow.js';
import { useObjectLookups } from '../hooks/useObjectLookups.js';

export interface DynamicModalContentHandle {
  validateAndGetValues: () => Promise<{ isValid: boolean; values: Record<string, unknown> }>;
}

const DynamicContentInner: FC<{
  fields: AssistantField[];
  pluginApiName: string;
  onLoadingChange: (loading: boolean) => void;
  handleRef: Ref<DynamicModalContentHandle>;
}> = ({ fields, pluginApiName, onLoadingChange, handleRef }) => {
  const { validateForm, inferencePending, expressionsIdle, initialExpressionsPending, state } =
    useSetupAssistant();

  const isLoading = inferencePending || !expressionsIdle || initialExpressionsPending;

  useEffect(() => {
    onLoadingChange(isLoading);
  }, [isLoading, onLoadingChange]);

  useImperativeHandle(
    handleRef,
    () => ({
      validateAndGetValues: async () => {
        const { isValid } = await validateForm();

        return { isValid, values: state };
      },
    }),
    [validateForm, state],
  );

  return (
    <div className="flex flex-col gap-3">
      {fields.map((field) => (
        <SetupAssistantRow key={field.key} field={field} pluginApiName={pluginApiName} />
      ))}
    </div>
  );
};

export const DynamicModalContent = forwardRef<
  DynamicModalContentHandle,
  {
    fields: AssistantField[];
    pluginApiName: string;
    onLoadingChange: (loading: boolean) => void;
  }
>(({ fields, pluginApiName, onLoadingChange }, ref) => {
  const { getObjectByAPIName, getCustomObjectDetails } = useObjectLookups();
  const stateRef = useRef<Record<string, unknown>>({});

  const handleStateChange = useCallback((newState: Record<string, unknown>) => {
    stateRef.current = newState;
  }, []);

  const config: SetupAssistantConfig = { fields };

  return (
    <SetupAssistantController
      config={config}
      value={{} as Record<string, UnknownJSON>}
      onStateChange={handleStateChange}
      disabledKeys={[]}
      getObjectByAPIName={getObjectByAPIName}
      getCustomObjectDetails={getCustomObjectDetails}
    >
      <DynamicContentInner
        fields={fields}
        pluginApiName={pluginApiName}
        onLoadingChange={onLoadingChange}
        handleRef={ref}
      />
    </SetupAssistantController>
  );
});

DynamicModalContent.displayName = 'DynamicModalContent';
