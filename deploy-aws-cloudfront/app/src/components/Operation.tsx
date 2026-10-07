// The popup that follows a restore or alias move while the rollback service runs it: a progress bar,
// the steps done so far and the run's log lines, polled from GET /api/operations/<id>.
import { useEffect, useRef, useState } from 'react';
import { fetchOperation, type OperationView, type StartedOperation } from '../api.js';

/** How a run the page started ended (or that the popup was closed before it did). */
export interface OperationOutcome {
  status: OperationView['status'] | 'closed';
  reason?: string;
}

interface Run {
  title: string;
  id?: string;
  view?: OperationView;
  /** the request to start it failed */
  error?: string;
}

const ENDED = ['succeeded', 'skipped', 'failed'];
const POLL_MS = 1500;

/**
 * `start(title, begin)` opens the popup, calls `begin` (the POST that starts the run), follows the
 * run and resolves with how it ended. Render `dialog` somewhere in the panel.
 */
export function useOperationDialog() {
  const [run, setRun] = useState<Run>();
  const settle = useRef<((outcome: OperationOutcome) => void) | undefined>(undefined);
  const finish = (outcome: OperationOutcome) => {
    settle.current?.(outcome);
    settle.current = undefined;
  };

  async function start(title: string, begin: () => Promise<StartedOperation>): Promise<OperationOutcome> {
    finish({ status: 'closed' });
    setRun({ title });
    const ended = new Promise<OperationOutcome>((resolve) => { settle.current = resolve; });
    try {
      const { operationId } = await begin();
      setRun({ title, id: operationId });
    } catch (err) {
      const reason = (err as Error).message;
      setRun({ title, error: reason });
      finish({ status: 'failed', reason });
    }
    return ended;
  }

  // poll the run until it ends (or the popup is closed)
  const id = run?.id;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const view = await fetchOperation(id, controller.signal);
        setRun((current) => (current?.id === id ? { ...current, view } : current));
        if (ENDED.includes(view.status)) return finish({ status: view.status, reason: view.reason });
      } catch {
        if (controller.signal.aborted) return;
        // a failed poll: try again on the next tick
      }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id]);

  const close = () => {
    // still running: it goes on in the rollback service; the panel reloads to show where it got
    finish({ status: 'closed' });
    setRun(undefined);
  };
  return { start, busy: run !== undefined, dialog: run && <OperationDialog run={run} onClose={close} /> };
}

const STATUS_TEXT: Record<OperationView['status'], string> = {
  queued: 'Waiting for the rollback service…',
  running: 'Running…',
  succeeded: 'Done',
  skipped: 'Nothing changed',
  failed: 'Failed',
};

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function OperationDialog({ run, onClose }: { run: Run; onClose: () => void }) {
  const { view, error } = run;
  const status = error ? 'failed' : view?.status ?? 'queued';
  const progress = error ? 100 : view?.progress ?? 2;
  const reason = error ?? view?.reason;
  const ended = ENDED.includes(status);
  const logRef = useRef<HTMLPreElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { closeRef.current?.focus(); }, []);
  // keep the newest line in view
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [view?.lines.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop">
      <div className="modal operation" role="dialog" aria-modal="true" aria-labelledby="operation-title" data-status={status}>
        <h2 id="operation-title">{run.title}</h2>
        <div className="operation-status">
          <span className={`status ${status === 'failed' ? 'bad' : status === 'succeeded' ? '' : 'pending'}`}>{STATUS_TEXT[status]}</span>
          {reason && <span className="operation-reason">{reason}</span>}
        </div>
        <div className={`progress ${status}`} role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="progress-bar" style={{ width: `${progress}%` }} />
        </div>
        {view && (
          <ol className="operation-steps">
            {view.steps.map((step) => (
              <li key={step.label} className={step.done ? 'done' : undefined}>{step.label}</li>
            ))}
          </ol>
        )}
        <div className="operation-log-label">
          Rollback service log{run.id && <span className="muted-text small"> · {run.id}</span>}
        </div>
        <pre className="operation-log" ref={logRef} aria-live="polite">
          {view?.lines.length
            ? view.lines.map((line, i) => (
              <span key={i} className={`log-line ${line.level.toLowerCase()}`}>
                <span className="log-time">{clock(line.time)}</span> <span className="log-level">{line.level}</span> {line.text}{'\n'}
              </span>
            ))
            : <span className="muted-text">{error ? 'The rollback service was not started.' : 'No lines yet: the rollback service starts within a few seconds.'}</span>}
        </pre>
        <div className="modal-actions">
          {!ended && <span className="muted-text small">Closing doesn't stop it: the rollback service carries on.</span>}
          <button ref={closeRef} type="button" className="rollback" onClick={onClose}>{ended ? 'Close' : 'Close and keep running'}</button>
        </div>
      </div>
    </div>
  );
}

/** The line a panel shows once a run it started ended (or its popup was closed). */
export function outcomeMessage(outcome: OperationOutcome, done: string, failed: string): { text: string; error?: boolean } {
  switch (outcome.status) {
    case 'succeeded': return { text: done };
    case 'skipped': return { text: `Nothing changed: ${outcome.reason ?? 'the rollback service skipped it'}.` };
    case 'closed': return { text: 'Still running in the rollback service: refresh to see where it got.' };
    default: return { text: `${failed}: ${outcome.reason ?? 'see the rollback service log'}`, error: true };
  }
}
