import { env } from '@shared/config/env';

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
  // eslint-disable-next-line no-console
  console.warn(`Invalid BETA_GATE_ENABLED value "${raw}", keeping the beta gate enabled.`);

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
