import { IScheduleHandler } from '@application/contracts/IScheduleHandler';
import { ReconcilePaymentsUseCase } from '@application/useCases/billing/ReconcilePaymentsUseCase';
import { Injectable } from '@kernel/decorators/Injectable';

@Injectable()
export class ReconcilePaymentsScheduleHandler implements IScheduleHandler<Record<string, unknown>, ReconcilePaymentsUseCase.Output> {

  constructor(
    private readonly reconcilePaymentsUseCase: ReconcilePaymentsUseCase,
  ) { }

  async handle(input: Record<string, unknown>): Promise<ReconcilePaymentsUseCase.Output> {
    const lookbackDays = Number(input.lookbackDays);
    const isValid = Number.isInteger(lookbackDays) && lookbackDays > 0;

    return this.reconcilePaymentsUseCase.execute({
      lookbackDays: isValid ? Math.min(lookbackDays, ReconcilePaymentsUseCase.MAX_LOOKBACK_DAYS) : undefined,
    });
  }

}
