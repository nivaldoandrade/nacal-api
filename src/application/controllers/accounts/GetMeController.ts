import { Controller } from '@application/contracts/Controller';
import { Profile } from '@application/entities/Profile';
import { Subscription } from '@application/entities/Subscription';
import { ResourceNotFound } from '@application/errors/application/ResourceNotFound';
import { GetProfileAndGoalByAccountId } from '@application/query/GetProfileAndGoalByAccountId';
import { AccountProvisioningService } from '@application/services/AccountProvisioningService';
import { MealQuotaService } from '@application/services/MealQuotaService';
import { AuthGateway } from '@infra/gateways/AuthGateway';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class GetMeController extends Controller<'private'> {

  constructor(
    private readonly getProfileAndGoaByAccountId: GetProfileAndGoalByAccountId,
    private readonly mealQuotaService: MealQuotaService,
    private readonly authGateway: AuthGateway,
    private readonly accountProvisioningService: AccountProvisioningService,
  ) {
    super();
  }

  protected async handler(request: Controller.RequestPrivate): Promise<Controller.Response<GetMeController.Response>> {

    const accountId = request.accountId;

    const { isOnboarded, email, profile, goal, subscription } = await this.getAccountData(request);

    const plan = Subscription.resolveEffectivePlan(
      subscription
        ? {
          status: subscription.status,
          trialEndsAt: subscription.trialEndsAt ? new Date(subscription.trialEndsAt) : undefined,
          paidUntil: subscription.paidUntil ? new Date(subscription.paidUntil) : undefined,
        }
        : null,
    );

    const { mealQuota, dailyMealQuota } = await this.mealQuotaService.getUsage({ accountId, plan });

    return {
      statusCode: 200,
      body: {
        isOnboarded,
        email,
        profile,
        goal,
        subscription: subscription
          ? {
            plan,
            planId: subscription.planId,
            status: subscription.status,
            trialEndsAt: subscription.trialEndsAt,
            paidUntil: subscription.paidUntil,
          }
          : null,
        mealQuota,
        dailyMealQuota,
      },
    };
  }

  private async getAccountData(request: Controller.RequestPrivate) {
    try {
      return await this.getProfileAndGoaByAccountId.execute(request.accountId);
    } catch (error) {
      if (!(error instanceof ResourceNotFound)) {
        throw error;
      }
    }

    // A Cognito user without an Account only happens when the Account write failed after the
    // user was confirmed. Recover here, the first call after sign-in, instead of paying for the
    // check on every sign-in.
    await this.provisionMissingAccount(request);

    return this.getProfileAndGoaByAccountId.execute(request.accountId);
  }

  private async provisionMissingAccount(request: Controller.RequestPrivate): Promise<void> {
    const accessToken = request.headers['authorization']?.replace(/^Bearer\s+/i, '');

    if (!accessToken) {
      throw new ResourceNotFound('Account not found.');
    }

    const user = await this.authGateway.getUser(accessToken);

    if (!user.email || !user.externalId || !user.emailVerified || user.internalId !== request.accountId) {
      throw new ResourceNotFound('Account not found.');
    }

    await this.accountProvisioningService.ensureAccount({
      email: user.email,
      internalId: user.internalId,
      externalId: user.externalId,
    });
  }
}

namespace GetMeController {

  export type Response = {
    isOnboarded: boolean;
    email: string;
    profile: {
      name: string;
      birthDate: string;
      gender: string;
      height: number;
      weight: number;
      goal: Profile.Goal;
    } | null,
    goal: {
      calories: number;
      proteins: number;
      carbohydrates: number;
      fats: number;
    } | null,
    subscription: {
      plan: Subscription.EffectivePlan;
      planId: Subscription.PlanIdType;
      status: Subscription.StatusType;
      trialEndsAt?: string;
      paidUntil?: string;
    } | null,
    mealQuota: MealQuotaService.Quota;
    dailyMealQuota: MealQuotaService.Quota | null;
  }
}
