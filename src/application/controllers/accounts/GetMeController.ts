import { Controller } from '@application/contracts/Controller';
import { Profile } from '@application/entities/Profile';
import { Subscription } from '@application/entities/Subscription';
import { GetProfileAndGoalByAccountId } from '@application/query/GetProfileAndGoalByAccountId';
import { MealQuotaService } from '@application/services/MealQuotaService';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class GetMeController extends Controller<'private'> {

  constructor(
    private readonly getProfileAndGoaByAccountId: GetProfileAndGoalByAccountId,
    private readonly mealQuotaService: MealQuotaService,
  ) {
    super();
  }

  protected async handler(request: Controller.RequestPrivate): Promise<Controller.Response<GetMeController.Response>> {

    const accountId = request.accountId;

    const { isOnboarded, profile, goal, subscription } = await this.getProfileAndGoaByAccountId.execute(accountId);

    const plan = Subscription.resolveEffectivePlan(
      subscription
        ? {
          status: subscription.status,
          trialEndsAt: subscription.trialEndsAt ? new Date(subscription.trialEndsAt) : undefined,
          paidUntil: subscription.paidUntil ? new Date(subscription.paidUntil) : undefined,
        }
        : null,
    );

    const mealQuota = await this.mealQuotaService.getUsage({ accountId, plan });

    return {
      statusCode: 200,
      body: {
        isOnboarded,
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
      },
    };
  }
}

namespace GetMeController {

  export type Response = {
    isOnboarded: boolean;
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
    mealQuota: {
      used: number;
      limit: number | null;
      remaining: number | null;
    }
  }
}
