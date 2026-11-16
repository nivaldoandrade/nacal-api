import { env } from '@shared/config/env';
import { logger } from '@shared/logger/logger';

function isBetaGateEnabled(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }

  const value = raw.trim().toLowerCase();

  if (value === 'true' || value === '1') {
    return true;
  }

  if (value === 'false' || value === '0' || value === '') {
    return false;
  }

  // Fail closed: an unrecognized value must not silently open the closed beta.
  logger.warn('invalid BETA_GATE_ENABLED, keeping the beta gate enabled', { value: raw });

  return true;
}

export function isBetaAllowed(email: string): boolean {
  if (!isBetaGateEnabled(env.BETA_GATE_ENABLED)) {
    return true;
  }

  const allowedEmails = (env.BETA_ALLOWED_EMAILS ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  return allowedEmails.includes(email.trim().toLowerCase());
}
