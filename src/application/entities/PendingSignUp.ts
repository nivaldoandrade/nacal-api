import { Profile } from '@application/entities/Profile';

export class PendingSignUp {
  readonly accountId: string;

  readonly email: string;

  readonly externalId: string;

  readonly profile: PendingSignUp.ProfileData;

  readonly termsVersion: string;

  readonly termsAcceptedAt: Date;

  readonly createdAt: Date;

  readonly expiresAt: number;

  constructor(attr: PendingSignUp.Attributes) {
    this.accountId = attr.accountId;
    this.email = attr.email;
    this.externalId = attr.externalId;
    this.profile = attr.profile;
    this.termsVersion = attr.termsVersion;
    this.termsAcceptedAt = attr.termsAcceptedAt;
    this.createdAt = attr.createdAt ?? new Date();
    this.expiresAt = attr.expiresAt;
  }
}

export namespace PendingSignUp {
  export type ProfileData = {
    name: string;
    birthDate: Date;
    gender: Profile.Gender;
    height: number;
    weight: number;
    activityLevel: Profile.ActivityLevel;
    goal: Profile.Goal;
  };

  export type Attributes = {
    accountId: string;
    email: string;
    externalId: string;
    profile: ProfileData;
    termsVersion: string;
    termsAcceptedAt: Date;
    createdAt?: Date;
    expiresAt: number;
  };
}
