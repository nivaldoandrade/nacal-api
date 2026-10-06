import { Subscription } from '@application/entities/Subscription';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class GetPlansUseCase {

  async execute(): Promise<GetPlansUseCase.Output> {
    const plans = Object.values(Subscription.Plan).map((plan) => ({
      id: plan.id,
      name: plan.name,
      price: plan.priceCents,
      cycle: plan.cycle,
      trialDays: plan.trialDays,
      features: [...plan.features],
    }));

    return { plans };
  }
}

namespace GetPlansUseCase {
  export type Output = {
    plans: Array<{
      id: Subscription.PlanIdType;
      name: string;
      price: number;
      cycle: string;
      trialDays: number;
      features: string[];
    }>;
  };
}
