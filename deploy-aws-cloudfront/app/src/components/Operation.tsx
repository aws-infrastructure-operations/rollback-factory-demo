// The popup of a restore or alias move: first what it will do, to confirm or cancel; then, while the
// rollback service runs it, a progress bar, the steps done so far and the run's log lines, polled
// from GET /api/operations/<id>.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchOperation, type OperationView, type StartedOperation } from '../api.js';

/** How a run the page started ended (or that the popup was closed before it did). */
export interface OperationOutcome {
  status: OperationView['status'] | 'closed' | 'cancelled';
  reason?: string;
}

/** What the popup asks before starting: what will happen, and the button that starts it. */
export interface Confirmation {
  body: ReactNode;
  /** e.g. "Roll back", "Restore", "Point live to v3" */
  confirmLabel: string;
  /** a change to what clients get: the button is red */
  danger?: boolean;
}

interface Run {
  title: string;
  /** set while it waits for the user's answer */
  confirm?: Confirmation;
  id?: string;
  view?: OperationView;
  /** the request to start it failed */
  error?: string;
}

const ENDED = ['succeeded', 'skipped', 'failed'];
const POLL_MS = 1500;

/**
 * `start(title, begin, confirm)` opens the popup on `confirm` (if given) and waits for the answer; then
 * calls `begin` (the POST that starts the run), follows the run and resolves with how it ended
 * (`cancelled` if the user said no). Render `dialog` somewhere in the panel.
 */
export function useOperationDialog() {
  const [run, setRun] = useState<Run>();
  const settle = useRef<((outcome: OperationOutcome) => void) | undefined>(undefined);
  const decide = useRef<((go: boolean) => void) | undefined>(undefined);
  const finish = (outcome: OperationOutcome) => {
    settle.current?.(outcome);
    settle.current = undefined;
  };
  const answer = (go: boolean) => {
    decide.current?.(go);
    decide.current = undefined;
  };

  async function start(title: string, begin: () => Promise<StartedOperation>, confirm?: Confirmation): Promise<OperationOutcome> {
    finish({ status: 'closed' });
    answer(false);
    if (confirm) {
      setRun({ title, confirm });
      const go = await new Promise<boolean>((resolve) => { decide.current = resolve; });
      if (!go) {
        setRun(undefined);
        return { status: 'cancelled' };
      }
    }
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
    if (decide.current) return answer(false);
    // still running: it goes on in the rollback service; the panel reloads to show where it got
    finish({ status: 'closed' });
    setRun(undefined);
  };
  const dialog = run && (run.confirm
    ? <ConfirmDialog title={run.title} confirm={run.confirm} onAnswer={answer} />
    : <OperationDialog run={run} onClose={close} />);
  // busy once confirmed (or started without a confirmation), until the popup closes
  return { start, busy: run !== undefined && !run.confirm, dialog };
}

/** Escape answers like the secondary button; the primary one has the focus. */
function useModalKeys(onEscape: () => void, focus: React.RefObject<HTMLButtonElement | null>) {
  useEffect(() => { focus.current?.focus(); }, [focus]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onEscape(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onEscape]);
}

function ConfirmDialog({ title, confirm, onAnswer }: { title: string; confirm: Confirmation; onAnswer: (go: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // a destructive change starts with the focus on Cancel, so Enter doesn't start it by accident
  const confirmRef = useRef<HTMLButtonElement>(null);
  useModalKeys(() => onAnswer(false), confirm.danger ? cancelRef : confirmRef);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onAnswer(false); }}>
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <h2 id="confirm-title">{title}?</h2>
        <div id="confirm-body" className="confirm-body">{confirm.body}</div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={() => onAnswer(false)}>Cancel</button>
          <button ref={confirmRef} type="button" className={`btn ${confirm.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => onAnswer(true)}>
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Label/value rows for a confirmation: what changes from what to what. */
export const ConfirmFacts = ({ rows }: { rows: Array<[string, ReactNode]> }) => (
  <dl className="confirm-facts">
    {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>
);

/** A highlighted note under the facts, e.g. what the rollback service will do. */
export const ConfirmNote = ({ children }: { children: ReactNode }) => <p className="confirm-note">{children}</p>;

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
    case 'cancelled': return { text: '' };
    default: return { text: `${failed}: ${outcome.reason ?? 'see the rollback service log'}`, error: true };
  }
}
