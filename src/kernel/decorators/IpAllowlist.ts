type IpAllowlistSelector = (config: any) => string[];

const IP_ALLOWLIST_METADATA_KEY = 'custom:ipAllowlist';

export function IpAllowlist(selector: IpAllowlistSelector): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(IP_ALLOWLIST_METADATA_KEY, selector, target);
  };
}

export function getIpAllowlist(target: object): IpAllowlistSelector | undefined {
  return Reflect.getMetadata(IP_ALLOWLIST_METADATA_KEY, target.constructor);
}
