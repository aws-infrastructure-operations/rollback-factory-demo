// The ETA line of the rollback popup (components/Operation.tsx), kept free of React so it is easy to test.

/** 0:07, 1:05 */
export const formatDuration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** The line the popup shows next to the status, from the elapsed time and the usual duration. */
export function etaText(elapsedMs: number, estimate: { ms: number; from: 'history' | 'default'; runs: number } | undefined, ended: boolean) {
  if (ended) return `Took ${formatDuration(elapsedMs)}`;
  const elapsed = `Elapsed ${formatDuration(elapsedMs)}`;
  if (!estimate) return elapsed;
  const left = estimate.ms - elapsedMs;
  if (left > 0) return `${elapsed} · about ${formatDuration(left)} left`;
  return `${elapsed} · taking longer than usual (usually ~${formatDuration(estimate.ms)})`;
}
