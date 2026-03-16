/**
 * Shared event trigger utilities.
 */

import type { TableInfo, EventTriggerConfig } from '../types.js';

export interface TriggerMatch {
  trigger: EventTriggerConfig;
  table: TableInfo;
}

/**
 * Build a lookup map from trigger name to its config and parent table.
 */
export function buildTriggerLookup(tables: TableInfo[]): Map<string, TriggerMatch> {
  const lookup = new Map<string, TriggerMatch>();
  for (const table of tables) {
    for (const trigger of table.eventTriggers) {
      lookup.set(trigger.name, { trigger, table });
    }
  }
  return lookup;
}
