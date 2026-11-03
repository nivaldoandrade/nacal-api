import fs from 'node:fs';
import process from 'node:process';
import dotenv from 'dotenv';

const prodEnvPath = '.env.prod';
const errors = [];
const warnings = [];

if (!fs.existsSync(prodEnvPath)) {
  console.error(`Arquivo ${prodEnvPath} não encontrado. Copie .env.prod.example e preencha os valores.`);
  process.exit(1);
}

dotenv.config({ path: '.env', quiet: true });
dotenv.config({ path: prodEnvPath, override: true, quiet: true });

const readKeys = path => new Set(Object.keys(dotenv.parse(fs.readFileSync(path))));
if (fs.existsSync('.env')) {
  const devKeys = readKeys('.env');
  const prodKeys = readKeys(prodEnvPath);
  for (const key of devKeys) {
    if (!prodKeys.has(key)) {
      errors.push(`${key} não está definido no .env.prod; ele herdaria o valor do .env de dev`);
    }
  }
}

const value = name => (process.env[name] ?? '').trim();
const placeholderPattern = /(SUBSTITUA|changeme|seudominio|exemplo\.com|example\.com|000000000000|\.\.\.)/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The runtime allowlist is an exact string match, so CIDR ranges are not supported.
const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;

const requireValue = name => {
  if (!value(name)) {
    errors.push(`${name} ausente`);
  }
};

const rejectPlaceholder = name => {
  if (value(name) && placeholderPattern.test(value(name))) {
    errors.push(`${name} ainda contém um valor de exemplo`);
  }
};

const requireEmail = (name, domain) => {
  requireValue(name);
  if (value(name) && !emailPattern.test(value(name))) {
    errors.push(`${name} não é um e-mail válido`);
  }
  if (domain && value(name) && !value(name).toLowerCase().endsWith(`@${domain}`)) {
    errors.push(`${name} deve usar @${domain}`);
  }
};

const requireHttpsUrl = (name, expectedHost) => {
  requireValue(name);
  if (!value(name)) {
    return;
  }

  let url;
  try {
    url = new URL(value(name));
  } catch {
    errors.push(`${name} não é uma URL válida`);
    return;
  }

  if (url.protocol !== 'https:') {
    errors.push(`${name} precisa usar HTTPS`);
  }
  if (expectedHost && url.hostname !== expectedHost) {
    errors.push(`${name} deve apontar para ${expectedHost}`);
  }
};

const requireArn = (name, service, region) => {
  requireValue(name);
  if (!value(name)) {
    return;
  }

  const pattern = new RegExp(`^arn:aws:${service}:${region}:\\d{12}:.+`);
  if (!pattern.test(value(name))) {
    errors.push(`${name} deve ser um ARN de ${service} em ${region}`);
  }
};

const requireBoolean = name => {
  requireValue(name);
  if (value(name) && !['true', 'false'].includes(value(name))) {
    errors.push(`${name} deve ser true ou false`);
  }
};

requireEmail('COGNITO_EMAIL', 'nacal.app');
requireEmail('COGNITO_EMAIL_TO_REPLY', 'nacal.app');
requireArn('SES_SOURCE_ARN', 'ses', 'sa-east-1');
rejectPlaceholder('SES_SOURCE_ARN');

requireHttpsUrl('APP_WEB_URL', 'app.nacal.app');
if (value('APP_WEB_URL')) {
  try {
    if (new URL(value('APP_WEB_URL')).origin !== value('APP_WEB_URL')) {
      errors.push('APP_WEB_URL deve ser só a origem, sem path nem barra final (ex.: https://app.nacal.app); ela é usada como AllowedOrigin exato no CORS do bucket');
    }
  } catch {
    // Invalid URLs are already reported by requireHttpsUrl.
  }
}
requireValue('API_DOMAIN_NAME');
if (value('API_DOMAIN_NAME') && value('API_DOMAIN_NAME') !== 'api.nacal.app') {
  errors.push('API_DOMAIN_NAME deve ser api.nacal.app');
}
requireArn('API_CERTIFICATE_ARN', 'acm', 'sa-east-1');
rejectPlaceholder('API_CERTIFICATE_ARN');
requireBoolean('APIGATEWAY_DEFAULT_ENDPOINT_DISABLE');
if (value('APIGATEWAY_DEFAULT_ENDPOINT_DISABLE') !== 'true') {
  errors.push('APIGATEWAY_DEFAULT_ENDPOINT_DISABLE deve ser true em produção');
}

requireValue('CORS_ALLOWED_ORIGINS');
if (value('CORS_ALLOWED_ORIGINS')) {
  const origins = value('CORS_ALLOWED_ORIGINS').split(',').map(origin => origin.trim()).filter(Boolean);
  if (origins.includes('*')) {
    errors.push('CORS_ALLOWED_ORIGINS não pode ser * em produção');
  }
  if (!origins.includes('https://app.nacal.app')) {
    errors.push('CORS_ALLOWED_ORIGINS deve incluir https://app.nacal.app');
  }
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:') {
        errors.push(`CORS_ALLOWED_ORIGINS contém uma origem sem HTTPS: ${origin}`);
      }
    } catch {
      errors.push(`CORS_ALLOWED_ORIGINS contém uma URL inválida: ${origin}`);
    }
  }
}

const cdnDomain = value('MEALS_CDN_DOMAIN_NAME');
const cdnCertificate = value('MEALS_CDN_CERTIFICATE_ARN');
if (Boolean(cdnDomain) !== Boolean(cdnCertificate)) {
  errors.push('MEALS_CDN_DOMAIN_NAME e MEALS_CDN_CERTIFICATE_ARN devem ser preenchidos juntos');
}
if (cdnDomain) {
  if (cdnDomain !== 'cdn.nacal.app') {
    errors.push('MEALS_CDN_DOMAIN_NAME deve ser cdn.nacal.app');
  }
  requireArn('MEALS_CDN_CERTIFICATE_ARN', 'acm', 'us-east-1');
  rejectPlaceholder('MEALS_CDN_CERTIFICATE_ARN');
} else {
  warnings.push('MEALS_CDN_DOMAIN_NAME vazio; o CDN usará o domínio padrão *.cloudfront.net');
}

requireEmail('DLQ_ALARM_EMAIL');
requireValue('OPENAI_API_KEY');
rejectPlaceholder('OPENAI_API_KEY');

requireBoolean('MEAL_GATE_ENABLED');
if (value('MEAL_GATE_ENABLED') === 'true') {
  requireValue('CLOUDFLARE_ACCOUNT_ID');
  requireValue('CLOUDFLARE_AI_API_TOKEN');
  rejectPlaceholder('CLOUDFLARE_ACCOUNT_ID');
  rejectPlaceholder('CLOUDFLARE_AI_API_TOKEN');
}

const rejectThreshold = value('MEAL_GATE_REJECT_THRESHOLD');
if (rejectThreshold) {
  const threshold = Number(rejectThreshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    errors.push('MEAL_GATE_REJECT_THRESHOLD deve ser um número entre 0 e 1');
  }
}

requireBoolean('BETA_GATE_ENABLED');
if (value('BETA_GATE_ENABLED') === 'true') {
  requireValue('BETA_ALLOWED_EMAILS');
  const allowedEmails = value('BETA_ALLOWED_EMAILS').split(',').map(email => email.trim()).filter(Boolean);
  if (allowedEmails.length === 0) {
    errors.push('BETA_ALLOWED_EMAILS precisa ter ao menos um e-mail');
  }
  for (const email of allowedEmails) {
    if (!emailPattern.test(email)) {
      errors.push(`BETA_ALLOWED_EMAILS contém um e-mail inválido: ${email}`);
    }
  }
  // Lambda caps the total size of a function's environment variables at 4 KB.
  const allowlistBytes = Buffer.byteLength(value('BETA_ALLOWED_EMAILS'), 'utf8');
  if (allowlistBytes > 2048) {
    errors.push(`BETA_ALLOWED_EMAILS tem ${allowlistBytes} bytes; acima de 2 KB ele ameaça o limite de 4 KB de variáveis de ambiente do Lambda`);
  } else if (allowlistBytes > 1024) {
    warnings.push(`BETA_ALLOWED_EMAILS tem ${allowlistBytes} bytes; o limite de 4 KB de variáveis de ambiente do Lambda está se aproximando`);
  }
} else if (value('BETA_GATE_ENABLED') === 'false') {
  warnings.push('BETA_GATE_ENABLED=false; o lançamento será público e exigirá termos/privacidade publicados');
}

requireValue('GOOGLE_CLIENT_ID');
if (value('GOOGLE_CLIENT_ID') && !value('GOOGLE_CLIENT_ID').endsWith('.apps.googleusercontent.com')) {
  errors.push('GOOGLE_CLIENT_ID deve ser um client ID do Google');
}
rejectPlaceholder('GOOGLE_CLIENT_ID');
requireValue('GOOGLE_CLIENT_SECRET');
rejectPlaceholder('GOOGLE_CLIENT_SECRET');

const asaasBaseUrl = value('ASAAS_BASE_URL');
const isAsaasSandbox = asaasBaseUrl === 'https://api-sandbox.asaas.com';
if (asaasBaseUrl !== 'https://api.asaas.com' && !isAsaasSandbox) {
  errors.push('ASAAS_BASE_URL deve ser https://api.asaas.com ou https://api-sandbox.asaas.com');
}
if (isAsaasSandbox) {
  warnings.push('ASAAS_BASE_URL em sandbox; cobranças reais ficam desativadas');
}
requireValue('ASAAS_API_KEY');
rejectPlaceholder('ASAAS_API_KEY');
requireValue('ASAAS_WEBHOOK_TOKEN');
rejectPlaceholder('ASAAS_WEBHOOK_TOKEN');

const webhookIps = value('ASAAS_WEBHOOK_ALLOWED_IPS');
if (webhookIps === '*') {
  if (isAsaasSandbox) {
    warnings.push('ASAAS_WEBHOOK_ALLOWED_IPS=* no sandbox; a allowlist de IP fica desativada');
  } else {
    errors.push('ASAAS_WEBHOOK_ALLOWED_IPS não pode ser * em produção');
  }
} else if (webhookIps) {
  for (const ip of webhookIps.split(',').map(item => item.trim()).filter(Boolean)) {
    if (!ipPattern.test(ip)) {
      errors.push(`ASAAS_WEBHOOK_ALLOWED_IPS contém um IP inválido (use IPs individuais, sem CIDR): ${ip}`);
    }
  }
} else if (isAsaasSandbox) {
  warnings.push('ASAAS_WEBHOOK_ALLOWED_IPS vazio no sandbox; a allowlist oficial de produção pode bloquear webhooks');
} else {
  warnings.push('ASAAS_WEBHOOK_ALLOWED_IPS vazio; usando a allowlist oficial de produção do Asaas');
}

if (!process.env.AWS_PROFILE) {
  errors.push('AWS_PROFILE não definido; use AWS_PROFILE=nacal-prod para não deployar na conta de dev');
} else if (process.env.AWS_PROFILE === 'default') {
  warnings.push('AWS_PROFILE=default; confirme que esse perfil aponta para a conta de produção');
}
if (process.env.AWS_REGION && process.env.AWS_REGION !== 'sa-east-1') {
  warnings.push(`AWS_REGION=${process.env.AWS_REGION}; a API usa sa-east-1`);
}

if (errors.length > 0) {
  console.error('Ambiente de produção inválido:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn('Avisos:');
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}

console.log('Ambiente de produção validado.');
