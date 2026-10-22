import { Meal } from '@application/entities/Meal';

export class MealRejectedError extends Error {
  constructor(
    public readonly reason: Meal.RejectionReason,
    public readonly gateScore?: number,
  ) {
    super(`Meal rejected: ${reason}`);
    this.name = MealRejectedError.name;
  }
}
