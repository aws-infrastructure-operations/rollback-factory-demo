// CloudFormation Stacks: the stacks whose templates deploy-test-rollback.yml archives (the API and
// Lambda stacks of dev and prod), and for the selected one its archived templates, newest first,
// with a Restore that updates the stack back to one of them through the rollback service.
import { useMemo, useState } from 'react';
import {
  fetchStackDetails, fetchStacks, restoreStackTemplate, type ArchivedTemplate, type CloudFormationStack, type CloudFormationStackDetails,
} from '../api.js';
import { DateCell, loadState, pendingMessage, useLoad } from './loading.js';
import { DetailPanel, ListPanel } from './Panels.js';
import { ConfirmFacts, ConfirmNote, outcomeMessage, useOperationDialog } from './Operation.js';
import { DataTable, RollbackButton, Tag, type TableMessage } from './ui.js';

const formatAt = (iso: string) => new Date(iso).toLocaleString();

const matches = (s: CloudFormationStack, query: string) => [s.name, s.env, s.project, s.status ?? ''].some((v) => v.toLowerCase().includes(query));

/** Statuses a stack can be updated (so restored) in. */
const UPDATABLE = /^(CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE|IMPORT_ROLLBACK_COMPLETE)$/;

const StackStatus = ({ status }: { status?: string }) => {
  if (!status) return <span className="status muted">Not deployed</span>;
  const kind = /FAILED|ROLLBACK/.test(status) && status !== 'UPDATE_ROLLBACK_COMPLETE' ? ' bad' : /IN_PROGRESS/.test(status) ? ' pending' : '';
  return <span className={`status${kind}`}>{status.replaceAll('_', ' ').toLowerCase()}</span>;
};

/** Where a template came from, as the archive records it. */
const SOURCES: Record<string, string> = {
  cicd: 'deploy', baseline: 'baseline', rollback: 'rollback (tests failed)', restore: 'restore',
};

export function CloudFormationSection() {
  const [reloads, setReloads] = useState(0);
  const list = useLoad(`list#${reloads}`, (signal) => fetchStacks(signal));
  const [query, setQuery] = useState('');
  const [selectedName, setSelectedName] = useState<string>();

  const stacks = list.data?.stacks ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? stacks.filter((s) => matches(s, q)) : stacks;
  }, [stacks, query]);
  // the clicked stack while it is listed, else the first deployed one shown
  const selected = shown.find((s) => s.name === selectedName) ?? shown.find((s) => s.status) ?? shown[0];

  let message = pendingMessage(list, 'the CloudFormation stacks');
  if (list.data && !shown.length) message = { text: `No stacks match “${query.trim()}”.` };

  return (
    <div className="panel-row">
      <ListPanel
        id="cloudformation-stacks" icon="stack" tint="tint-cloudformation" title="CloudFormation Stacks" state={loadState(list)}
        count={list.data && (shown.length === stacks.length ? `${stacks.length}` : `${shown.length} of ${stacks.length}`)}
        description="The stacks whose templates the deploy test rollback workflow archives, dev and prod."
        searchPlaceholder="Search stacks..." search={{ value: query, onChange: setQuery }}
        onRefresh={() => setReloads((n) => n + 1)} refreshing={list.loading}
      >
        {list.failed && list.data && <p className="refresh-error" role="alert">Refresh failed, showing the last list loaded.</p>}
        <DataTable rows={shown} rowKey={(s) => s.name} message={message}
          selectedKey={selected?.name} onSelect={(s) => setSelectedName(s.name)} columns={[
            {
              header: 'Stack Name',
              cell: (s) => (
                <div className="name-with-id">
                  <span className={`dot ${s.status && UPDATABLE.test(s.status) ? 'ok' : 'muted'}`} />
                  <button type="button" className="link-button" aria-pressed={s.name === selected?.name}
                    onClick={(e) => { e.stopPropagation(); setSelectedName(s.name); }}>
                    {s.name}
                  </button>
                </div>
              ),
            },
            { header: 'Environment', cell: (s) => <Tag kind={s.env === 'prod' ? 'prod' : 'dev'}>{s.env}</Tag> },
            { header: 'Status', cell: (s) => <StackStatus status={s.status} /> },
            { header: 'Last Updated', cell: (s) => (s.lastUpdated ? <DateCell iso={s.lastUpdated} /> : '—') },
          ]} />
      </ListPanel>
      {selected?.status
        ? <StackDetailPanel s={selected} reloads={reloads} />
        : <section className="panel detail placeholder" aria-label="Stack details"><p>{selected ? `${selected.name} isn't deployed.` : 'No stack to show.'}</p></section>}
    </div>
  );
}

function StackDetailPanel({ s, reloads }: { s: CloudFormationStack; reloads: number }) {
  // refreshing the list reloads the selected stack too, and so does a restore
  const [restores, setRestores] = useState(0);
  const details = useLoad<CloudFormationStackDetails>(`${s.name}#${reloads}.${restores}`, (signal) => fetchStackDetails(s.name, signal));
  const data = details.data;
  const message = pendingMessage(details, s.name);
  const status = data?.status ?? s.status;
  const running = data?.templates.find((t) => t.running);
  const [restoring, setRestoring] = useState<{ name: string; deployedAt: string }>();
  const [outcome, setOutcome] = useState<{ name: string; text: string; error?: boolean }>();

  // the popup that follows the restore while the rollback service waits for CloudFormation
  const operation = useOperationDialog();

  async function restore(t: ArchivedTemplate) {
    const what = `${s.name} to the template archived ${formatAt(t.deployedAt)}`;
    setRestoring({ name: s.name, deployedAt: t.deployedAt });
    setOutcome(undefined);
    const ended = await operation.start(`Restore ${what}`, () => restoreStackTemplate(s.name, t.deployedAt), {
      confirmLabel: 'Restore stack',
      danger: true,
      body: (
        <>
          <ConfirmFacts rows={[
            ['Stack', <>{s.name} <span className="muted-text">· {status}</span></>],
            ['Runs now', running
              ? <>{formatAt(running.deployedAt)} <span className="muted-text">· {SOURCES[running.source] ?? running.source}{running.commit ? ` · ${running.commit.slice(0, 7)}` : ''}</span></>
              : <span className="muted-text">a template that isn't archived</span>],
            ['Restores', <>{formatAt(t.deployedAt)} <span className="muted-text">· {SOURCES[t.source] ?? t.source}{t.commit ? ` · ${t.commit.slice(0, 7)}` : ''} · {t.templateHash}{t.stable ? ' · stable' : ''}</span></>],
          ]} />
          {(t.rolledBack || !t.stable) && (
            <ConfirmNote>
              {t.rolledBack
                ? 'This template failed its integration tests and was rolled back from. '
                : 'This template never passed the integration tests. '}
              A stable one is the safer choice.
            </ConfirmNote>
          )}
          <ConfirmNote>
            The rollback service updates the whole stack to that template: every resource that differs
            changes, which usually takes a few minutes. If CloudFormation can't apply it, it rolls the
            update back and the stack keeps what it runs now. The restore counts as stable once the
            integration tests pass on it again.
          </ConfirmNote>
        </>
      ),
    });
    if (ended.status === 'cancelled') {
      setRestoring(undefined);
      return;
    }
    setOutcome({ name: s.name, ...outcomeMessage(ended, `Restored ${what}.`, 'Restore failed') });
    setRestoring(undefined);
    setRestores((n) => n + 1);
  }
  const busy = restoring?.name === s.name && operation.busy;
  const notUpdatable = status && !UPDATABLE.test(status) ? `The stack is ${status.replaceAll('_', ' ').toLowerCase()}.` : undefined;

  return (
    <>
    {operation.dialog}
    <DetailPanel
      id="cloudformation-stack-details" icon="stack" tint="tint-cloudformation" name={s.name}
      badge={status && UPDATABLE.test(status) ? 'Ready' : undefined}
      subtitle={<>{status}{running && <> &nbsp; template {running.templateHash}</>}</>}
      tabs={['Deployments', 'Configuration', 'Outputs']}
      state={loadState(details)}
    >
      {(tab) => {
        if (tab === 'Deployments') {
          let templatesMessage: TableMessage | undefined = message;
          if (!templatesMessage && !data!.templates.length) {
            templatesMessage = { text: 'No template archived yet: run the deploy test rollback workflow on this stack (deploy rollback-service first).' };
          }
          return (
            <>
            {outcome?.name === s.name && (
              <p className={outcome.error ? 'refresh-error' : 'restore-done'} role={outcome.error ? 'alert' : 'status'}>{outcome.text}</p>
            )}
            {data && data.templates.length > 0 && !data.runningArchived && (
              <p className="stack-note warn">The stack runs a template that isn't archived: another workflow deployed it since.</p>
            )}
            <DataTable rows={data?.templates ?? []} rowKey={(t) => t.deployedAt} message={templatesMessage} columns={[
              {
                header: 'Template',
                cell: (t) => (
                  <div className="stacked">
                    <span className="small" title={t.template}>{t.templateHash}</span>
                    {(t.running || t.stable || t.rolledBack) && (
                      <span className="tags">
                        {t.running && <Tag kind="prod">running</Tag>}
                        {t.stable && <Tag kind="staging">stable</Tag>}
                        {t.rolledBack && <Tag kind="bad">rolled back</Tag>}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                header: 'Source',
                cell: (t) => (
                  <div className="stacked">
                    {t.runUrl ? <a href={t.runUrl} target="_blank" rel="noreferrer">{SOURCES[t.source] ?? t.source}</a> : SOURCES[t.source] ?? t.source}
                    {t.commit && <span className="small muted-text">{t.commit.slice(0, 7)}</span>}
                    {t.restoredFrom && <span className="small muted-text">of {formatAt(t.restoredFrom)}</span>}
                  </div>
                ),
              },
              { header: 'Archived At', cell: (t) => <DateCell iso={t.deployedAt} />, className: 'date-wrap' },
              {
                header: 'Actions',
                cell: (t) => (
                  <RollbackButton
                    label={busy && restoring!.deployedAt === t.deployedAt ? 'Restoring…' : 'Restore'}
                    disabledReason={t.running ? 'The stack runs this template.' : busy ? 'A restore is running.' : notUpdatable}
                    onClick={() => restore(t)} />
                ),
              },
            ]} />
            </>
          );
        }
        if (message) return <DataTable rows={[]} rowKey={() => ''} message={message} columns={[{ header: 'Setting', cell: () => null }]} />;
        if (tab === 'Outputs') {
          return (
            <DataTable rows={data!.outputs} rowKey={(o) => o.key} message={data!.outputs.length ? undefined : { text: 'No outputs.' }} columns={[
              { header: 'Key', cell: (o) => o.key },
              { header: 'Value', cell: (o) => <span className="small">{o.value}</span>, className: 'wrap' },
            ]} />
          );
        }
        return (
          <dl className="config-list">
            {data!.configuration.map(({ label, value }) => (
              <div key={label}><dt>{label}</dt><dd>{/^(Created|Last updated)$/.test(label) ? <DateCell iso={value} /> : value}</dd></div>
            ))}
          </dl>
        );
      }}
    </DetailPanel>
    </>
  );
}
