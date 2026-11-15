export function isFetchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'TimeoutError' || (error instanceof TypeError && error.message === 'fetch failed');
}
