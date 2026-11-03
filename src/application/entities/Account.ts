
export class Account {
  readonly id: string;

  readonly email: string;

  externalId: string;

  isOnboarded: boolean;

  termsAcceptedAt: Date | null;

  termsVersion: string | null;

  readonly createdAt: Date;

  constructor(attr: Account.Attributes) {
    this.id = attr.id;
    this.email = attr.email;
    this.externalId = attr.externalId;
    this.isOnboarded = attr.isOnboarded;
    this.termsAcceptedAt = attr.termsAcceptedAt ?? null;
    this.termsVersion = attr.termsVersion ?? null;
    this.createdAt = attr.createdAt ?? new Date();
  }
}

namespace Account {
  export type Attributes = {
    id: string;
    email: string;
    externalId: string;
    isOnboarded: boolean;
    termsAcceptedAt?: Date | null;
    termsVersion?: string | null;
    createdAt?: Date
  }
}
