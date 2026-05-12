import { useEffect } from 'react';
import { useSetupAssistant } from '@kizenapps/engine/react';
import type { AssistantField } from '@kizenapps/engine';

type SetupAssistantContext = ReturnType<typeof useSetupAssistant>;

export interface FieldBlockContext extends SetupAssistantContext {
  /** Whether this field should be hidden (from field.when evaluation). */
  shouldHide: boolean;
  /** Whether input should be disabled. */
  isDisabled: boolean;
  /** Error/validation state for this field key. */
  errorState: ReturnType<SetupAssistantContext['getFieldErrorState']>;
}

/**
 * Common setup for every setup-assistant block component.
 *
 * - Calls `useSetupAssistant()` and re-exports all values
 * - Evaluates `field.when` expression for conditional visibility
 * - Pre-computes `shouldHide`, `isDisabled`, and `errorState`
 *
 * The caller is responsible for rendering `null` when `shouldHide` is true
 * (hooks cannot conditionally return).
 */
export function useFieldBlock(field: AssistantField, disabled = false): FieldBlockContext {
  const ctx = useSetupAssistant();
  const { evaluateExpression, shouldHideField, getFieldErrorState, disabledKeys } = ctx;

  useEffect(() => {
    if (field.when) {
      void evaluateExpression(field.when, field.key);
    }
  }, [field.when, field.key, evaluateExpression]);

  const shouldHide = shouldHideField(field.key);
  const isDisabled = disabledKeys.includes(field.key) || disabled;
  const errorState = getFieldErrorState(field.key);

  return { ...ctx, shouldHide, isDisabled, errorState };
}
