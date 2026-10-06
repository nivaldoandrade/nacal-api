
export type Constructor<T = any> = new (...args: any[]) => T;
export type AbstractConstructor<T = any> = abstract new (...args: any[]) => T;

export class Registry {
  private static instance: Registry;

  static getInstance() {
    if (this.instance) {
      return this.instance;
    }

    this.instance = new Registry();
    return this.instance;
  }

  private constructor() { }

  private providers = new Map<string, Constructor>();
  private instanceCache = new Map<string, unknown>();
  private bindings = new Map<string, Constructor>();

  bind(token: AbstractConstructor, impl: Constructor) {
    this.bindings.set(token.name, impl);
  }

  register(impl: Constructor) {
    const token = impl.name;

    if (this.providers.has(token)) {
      throw new Error(`${token} already in registered.`);
    }

    this.providers.set(token, impl);
  }

  resolver<T>(impl: AbstractConstructor<T>): T {
    const token = impl.name;

    if (this.instanceCache.has(token)) {
      return this.instanceCache.get(token) as T;
    }

    const constructor = this.bindings.get(token) ?? this.providers.get(token);

    if (!constructor) {
      throw new Error(`${token} is not registered.`);
    }
    const paramTypes: Constructor[] = Reflect.getMetadata('design:paramtypes', constructor) || [];

    const deps = paramTypes.map(dep => {

      return this.resolver(dep);
    });

    const instance = new constructor(...deps);

    this.instanceCache.set(token, instance);

    return instance;
  }
}

