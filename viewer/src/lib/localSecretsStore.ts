import { integrationSecretKey } from './storageKeys.js';

export function hasSecretValue(pluginApiName: string, secretName: string): boolean {
  try {
    return localStorage.getItem(integrationSecretKey(pluginApiName, secretName)) !== null;
  } catch {
    return false;
  }
}

export function saveSecretLocally(
  pluginApiName: string,
  secretName: string,
  value: string,
): Promise<void> {
  try {
    localStorage.setItem(integrationSecretKey(pluginApiName, secretName), value);

    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error('Could not save secret locally'));
  }
}

export function clearSecretLocally(pluginApiName: string, secretName: string): void {
  localStorage.removeItem(integrationSecretKey(pluginApiName, secretName));
}
