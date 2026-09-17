import { useEffect, useState } from 'react';
import { planEntitlementsKey } from './storageKeys.js';

export interface StoredPlanEntitlements {
  plan: Record<string, Record<string, unknown>>;
  entitlements: Record<string, unknown>;
}

const EMPTY: StoredPlanEntitlements = { plan: {}, entitlements: {} };

const CHANGED_EVENT = 'kizen:plan-entitlements-changed';

export function loadPlanEntitlements(): StoredPlanEntitlements {
  try {
    const raw = localStorage.getItem(planEntitlementsKey());

    if (!raw) {
      return EMPTY;
    }

    const parsed = JSON.parse(raw) as Partial<StoredPlanEntitlements>;

    return { plan: parsed.plan ?? {}, entitlements: parsed.entitlements ?? {} };
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

    return () => {
      window.removeEventListener(CHANGED_EVENT, handleChange);
    };
  }, []);

  return value;
}
