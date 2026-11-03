import { PendingSignUp } from '@application/entities/PendingSignUp';

export class PendingSignUpItem {
  static readonly TYPE: PendingSignUpItem.Type = 'PENDING_SIGNUP';

  readonly keys: PendingSignUpItem.Keys;

  private constructor(private readonly attrs: PendingSignUpItem.Attributes) {
    this.keys = {
      PK: PendingSignUpItem.getPK(attrs.accountId),
      SK: PendingSignUpItem.getSK(attrs.accountId),
    };
  }

  static fromEntity(pending: PendingSignUp): PendingSignUpItem {
    return new PendingSignUpItem({
      accountId: pending.accountId,
      email: pending.email,
      externalId: pending.externalId,
      profile: {
        ...pending.profile,
        birthDate: pending.profile.birthDate.toISOString(),
      },
      termsVersion: pending.termsVersion,
      termsAcceptedAt: pending.termsAcceptedAt.toISOString(),
      createdAt: pending.createdAt.toISOString(),
      expiresAt: pending.expiresAt,
    });
  }

  static toEntity(attrs: PendingSignUpItem.Attributes): PendingSignUp {
    return new PendingSignUp({
      ...attrs,
      profile: {
        ...attrs.profile,
        birthDate: new Date(attrs.profile.birthDate),
      },
      termsAcceptedAt: new Date(attrs.termsAcceptedAt),
      createdAt: new Date(attrs.createdAt),
    });
  }

  getItem(): PendingSignUpItem.Item {
    return {
      ...this.keys,
      ...this.attrs,
      type: PendingSignUpItem.TYPE,
    };
  }

  static getPK(accountId: string): PendingSignUpItem.Keys['PK'] {
    return `PENDING_SIGNUP#${accountId}`;
  }

  static getSK(accountId: string): PendingSignUpItem.Keys['SK'] {
    return `PENDING_SIGNUP#${accountId}`;
  }
}

export namespace PendingSignUpItem {
  export type Type = 'PENDING_SIGNUP';

  export type Keys = {
    PK: `PENDING_SIGNUP#${string}`;
    SK: `PENDING_SIGNUP#${string}`;
  };

  export type ProfileAttributes = {
    name: string;
    birthDate: string;
    gender: PendingSignUp.ProfileData['gender'];
    height: number;
    weight: number;
    activityLevel: PendingSignUp.ProfileData['activityLevel'];
    goal: PendingSignUp.ProfileData['goal'];
  };

  export type Attributes = {
    accountId: string;
    email: string;
    externalId: string;
    profile: ProfileAttributes;
    termsVersion: string;
    termsAcceptedAt: string;
    createdAt: string;
    expiresAt: number;
  };

  export type Item = Keys & Attributes & {
    type: Type;
  };
}
