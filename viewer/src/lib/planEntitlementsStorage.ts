import { useEffect, useState } from 'react';
import type { JSONValue } from '@kizenapps/engine';
import { CREDENTIAL_PREFIX_CHANGED_EVENT, planEntitlementsKey } from './storageKeys.js';

export interface StoredPlanEntitlements {
  plan: Record<string, Record<string, JSONValue>>;
  entitlements: Record<string, JSONValue>;
}

const EMPTY: StoredPlanEntitlements = { plan: {}, entitlements: {} };

const CHANGED_EVENT = 'kizen:plan-entitlements-changed';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isStoredPlanEntitlements(value: unknown): value is StoredPlanEntitlements {
  if (!isPlainObject(value) || !isPlainObject(value.plan) || !isPlainObject(value.entitlements)) {
    return false;
  }

  return Object.values(value.plan).every(isPlainObject);
}

export function loadPlanEntitlements(): StoredPlanEntitlements {
  try {
    const raw = localStorage.getItem(planEntitlementsKey());

    if (!raw) {
      return EMPTY;
    }

    const parsed: unknown = JSON.parse(raw);

    return isStoredPlanEntitlements(parsed) ? parsed : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function savePlanEntitlements(value: StoredPlanEntitlements): void {
  localStorage.setItem(planEntitlementsKey(), JSON.stringify(value));
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function clearPlanEntitlements(): void {
  localStorage.removeItem(planEntitlementsKey());
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function usePlanEntitlements(): StoredPlanEntitlements {
  const [value, setValue] = useState(loadPlanEntitlements);

  useEffect(() => {
    const handleChange = (): void => {
      setValue(loadPlanEntitlements());
    };

    window.addEventListener(CHANGED_EVENT, handleChange);
    window.addEventListener(CREDENTIAL_PREFIX_CHANGED_EVENT, handleChange);

    return () => {
      window.removeEventListener(CHANGED_EVENT, handleChange);
      window.removeEventListener(CREDENTIAL_PREFIX_CHANGED_EVENT, handleChange);
    };
  }, []);

  return value;
}
