import { Account } from '@application/entities/Account';

export class AccountItem {
  static readonly TYPE: AccountItem.Type = 'ACCOUNT';

  readonly keys: AccountItem.Keys;

  private constructor(private readonly attrs: AccountItem.Attributes) {
    this.keys = {
      PK: AccountItem.getPK(attrs.id),
      SK: AccountItem.getPK(attrs.id),
      GSI1PK: AccountItem.getPK(attrs.email),
      GSI1SK: AccountItem.getPK(attrs.email),
    };
  }

  static fromEntity(account: Account): AccountItem {
    return new AccountItem({
      ...account,
      termsAcceptedAt: account.termsAcceptedAt?.toISOString() ?? null,
      createdAt: account.createdAt.toISOString(),
    });
  }

  static toEntity(accountItemAttr: AccountItem.Attributes): Account {
    return new Account({
      ...accountItemAttr,
      termsAcceptedAt: accountItemAttr.termsAcceptedAt
        ? new Date(accountItemAttr.termsAcceptedAt)
        : null,
      createdAt: new Date(accountItemAttr.createdAt),
    });
  }

  getItem(): AccountItem.Item {
    return {
      ...this.keys,
      ...this.attrs,
      type: AccountItem.TYPE,
    };
  }

  static getPK(accountId: string): AccountItem.Keys['PK'] {
    return `ACCOUNT#${accountId}`;
  };

  static getSK(accountId: string): AccountItem.Keys['SK'] {
    return `ACCOUNT#${accountId}`;
  };

  static getGSI1PK(email: string): AccountItem.Keys['GSI1PK'] {
    return `ACCOUNT#${email}`;
  };

  static getGSI1SK(email: string): AccountItem.Keys['GSI1SK'] {
    return `ACCOUNT#${email}`;
  };
}

export namespace AccountItem {

  export type Type = 'ACCOUNT';

  export type Keys = {
    PK: `ACCOUNT#${string}`;
    SK: `ACCOUNT#${string}`;
    GSI1PK: `ACCOUNT#${string}`;
    GSI1SK: `ACCOUNT#${string}`;
  }

  export type Attributes = {
    id: string;
    email: string;
    externalId: string;
    isOnboarded: boolean;
    termsAcceptedAt?: string | null;
    termsVersion?: string | null;
    createdAt: string;
  }

  export type Item = Keys & Attributes & {
    type: Type
  }
}
