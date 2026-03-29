import { JobExecutor } from "./JobExecutor";

// Singleton map of running job executors
const registry = new Map<string, JobExecutor>();

export function getExecutor(jobId: string): JobExecutor | undefined {
  return registry.get(jobId);
}

export function setExecutor(jobId: string, executor: JobExecutor): void {
  registry.set(jobId, executor);
}

export function removeExecutor(jobId: string): void {
  registry.delete(jobId);
}

export function getAllExecutors(): Map<string, JobExecutor> {
  return registry;
}
