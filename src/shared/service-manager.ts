/**
 * ServiceManager interface.
 *
 * Standardizes the init/stop lifecycle for all background services
 * (events, crons, async actions). Each subsystem exports a manager
 * that conforms to this interface, enabling uniform startup and
 * graceful shutdown in the server orchestrator.
 */

export interface ServiceManager {
  /** Initialize the service (register workers, schedules, etc.). */
  init(): Promise<void>;
  /** Gracefully stop the service. */
  stop(): Promise<void>;
}
