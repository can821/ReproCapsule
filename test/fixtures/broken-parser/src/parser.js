import { displayName } from './schema.js';

export function parseProfile(record) {
  // Bug: a missing optional display name is not handled before trimming.
  return { id: record.id, name: displayName(record).trim() };
}
