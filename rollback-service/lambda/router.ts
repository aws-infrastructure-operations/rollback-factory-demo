// Routes every event the rollback service receives to the right rollback manager.
//
// Alarm notifications (SNS): the manager is the <type> in the alarm name,
//   rollback-factory-demo-<type>-<name>-<env>, type = apigateway | cloudfront | lambda.
// Alarms of another environment, or named outside the convention, are skipped.
//
// Direct invocations:
//   { type: 'scheduled-check' }                     EventBridge: Lambda manager's sync / stable / re-check
//   { type: 'sync', functionName? }                 deploy-aws-lambda after promotion, manual rollbacks
//   { type: 'restore', manager: 'apigateway', ... } deploy-aws-api-gateway: deployment:restore
import type { EnvName } from '../lib/config.js';
import { parseAlarmName } from '../lib/config.js';

export interface AlarmNotification {
  alarmName: string;
  newState: string;
  reason: string;
}

type SnsRecord = { Sns: { Message: string } };

export type ServiceEvent =
  | { type: 'scheduled-check' }
  | { type: 'sync'; functionName?: string }
  | { type: 'restore'; manager: 'apigateway'; deployedAt: string; reason?: string; actor?: string }
  | { Records: SnsRecord[] };

export interface Managers {
  apigateway: (alarm: AlarmNotification, env: EnvName) => Promise<unknown>;
  apigatewayRestore: (req: { deployedAt: string; reason?: string; actor?: string }, env: EnvName) => Promise<unknown>;
  cloudfront: (alarm: AlarmNotification, env: EnvName) => Promise<unknown>;
  /** The Lambda manager takes the raw event: SNS records, sync and scheduled checks. */
  lambda: (event: { type: 'scheduled-check' } | { type: 'sync'; functionName?: string } | { Records: SnsRecord[] }) => Promise<unknown[]>;
}

const skip = (reason: string) => {
  console.log(JSON.stringify({ msg: 'skipped', reason }));
  return { action: 'skip', reason };
};

export function createRouter(envName: EnvName, managers: Managers) {
  async function routeAlarm(record: SnsRecord) {
    const message = JSON.parse(record.Sns.Message);
    const alarm: AlarmNotification = {
      alarmName: message.AlarmName,
      newState: message.NewStateValue,
      reason: message.NewStateReason,
    };
    const parsed = typeof alarm.alarmName === 'string' ? parseAlarmName(alarm.alarmName) : undefined;
    if (!parsed) return { alarm: alarm.alarmName, ...skip(`'${alarm.alarmName}' is not a rollback-factory-demo-<type>-<name>-<env> alarm`) };
    if (parsed.env !== envName) {
      return { alarm: alarm.alarmName, ...skip(`'${alarm.alarmName}' belongs to ${parsed.env}; this is the ${envName} rollback service`) };
    }
    // Only ALARM transitions can lead to a rollback; skipping the rest here means a manager never
    // reads its target (a project stack that may not exist yet) for an OK or INSUFFICIENT_DATA.
    if (alarm.newState !== 'ALARM') {
      return { alarm: alarm.alarmName, manager: parsed.type, ...skip(`state is ${alarm.newState}, not ALARM`) };
    }
    console.log(JSON.stringify({ msg: 'routing alarm', alarm: alarm.alarmName, state: alarm.newState, manager: parsed.type }));
    switch (parsed.type) {
      case 'apigateway':
        return { alarm: alarm.alarmName, manager: parsed.type, result: await managers.apigateway(alarm, envName) };
      case 'cloudfront':
        return { alarm: alarm.alarmName, manager: parsed.type, result: await managers.cloudfront(alarm, envName) };
      case 'lambda': {
        const [result] = await managers.lambda({ Records: [record] });
        return { alarm: alarm.alarmName, manager: parsed.type, result };
      }
    }
  }

  return async function route(event: ServiceEvent) {
    console.log('Event:', JSON.stringify(event));
    if ('Records' in event) {
      const results = [];
      for (const record of event.Records ?? []) results.push(await routeAlarm(record));
      return results;
    }
    switch (event.type) {
      case 'scheduled-check':
      case 'sync':
        return managers.lambda(event);
      case 'restore':
        if (event.manager !== 'apigateway') throw new Error(`Restore is only supported for apigateway, got ${event.manager}`);
        return managers.apigatewayRestore(event, envName);
      default:
        throw new Error(`Unknown event: ${JSON.stringify(event)}`);
    }
  };
}
