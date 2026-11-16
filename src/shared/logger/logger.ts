import { AsyncLocalStorage } from 'node:async_hooks';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

type LogFields = Record<string, unknown>;

type MetricName = 'MealFailed' | 'WebhookNon2xx';

const METRICS_NAMESPACE = 'NaCal';

const MAX_CAUSE_DEPTH = 3;

const storage = new AsyncLocalStorage<LogFields>();

function serializeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const serialized: LogFields = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };

  const metadata = (error as { $metadata?: { httpStatusCode?: number; requestId?: string } }).$metadata;

  if (metadata) {
    serialized['httpStatusCode'] = metadata.httpStatusCode;
    serialized['requestId'] = metadata.requestId;
  }

  if (error instanceof AggregateError) {
    serialized['errors'] = error.errors.map((item) => serializeError(item, depth + 1));
  }

  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    serialized['cause'] = serializeError(error.cause, depth + 1);
  }

  return serialized;
}

function serializeFields(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, serializeError(value)]),
  );
}

function write(entry: LogFields): void {
  let line: string;

  try {
    line = JSON.stringify(entry);
  } catch (error) {
    line = JSON.stringify({
      timestamp: entry['timestamp'],
      level: entry['level'],
      message: entry['message'],
      serializationError: String(error),
    });
  }

  process.stdout.write(`${line}\n`);
}

function log(level: LogLevel, message: string, fields: LogFields = {}): void {
  write({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...storage.getStore(),
    ...serializeFields(fields),
  });
}

export const logger = {
  info(message: string, fields?: LogFields): void {
    log('INFO', message, fields);
  },

  warn(message: string, fields?: LogFields): void {
    log('WARN', message, fields);
  },

  error(message: string, fields?: LogFields): void {
    log('ERROR', message, fields);
  },

  metric(name: MetricName, fields: LogFields = {}): void {
    const service = process.env['SERVICE_NAME'] ?? 'nacal-api';

    write({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      message: `metric ${name}`,
      ...storage.getStore(),
      ...serializeFields(fields),
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRICS_NAMESPACE,
            Dimensions: [['Service']],
            Metrics: [{ Name: name, Unit: 'Count' }],
          },
        ],
      },
      Service: service,
      [name]: 1,
    });
  },

  runWithContext<T>(context: LogFields, fn: () => T): T {
    return storage.run({ ...context }, fn);
  },

  appendContext(fields: LogFields): void {
    const store = storage.getStore();

    if (store) {
      Object.assign(store, fields);
    }
  },
};

export namespace logger {
  export type Fields = LogFields;
  export type Metric = MetricName;
}
