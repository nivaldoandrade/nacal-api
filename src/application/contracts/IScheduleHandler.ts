
export interface IScheduleHandler<
  TInput extends Record<string, unknown>
  = Record<string, unknown>,
  TOutput = void
> {
  handle(input: TInput): Promise<TOutput>;
}
