export type Non2xxMetricName = 'WebhookNon2xx';

const NON_2XX_METRIC_METADATA_KEY = 'custom:non2xxMetric';

export function Non2xxMetric(name: Non2xxMetricName): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(NON_2XX_METRIC_METADATA_KEY, name, target);
  };
}

export function getNon2xxMetric(controllerImpl: object): Non2xxMetricName | undefined {
  return Reflect.getMetadata(NON_2XX_METRIC_METADATA_KEY, controllerImpl);
}
