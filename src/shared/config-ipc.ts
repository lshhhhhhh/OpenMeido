/**
 * IPC channel names for the config service. Kept in its own tiny file (no
 * Zod, no schema) so the preload bundle stays small — preload only needs
 * channel names + types, not the validator.
 */
export const ConfigIPC = {
  Get: 'config:get',
  Set: 'config:set',
  Changed: 'config:changed',
} as const
