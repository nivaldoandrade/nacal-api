/* eslint-disable no-console */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import dotenv from 'dotenv';

import { betaInviteEmail } from '../src/infra/emails/templates/betaInviteEmail';

const SERVICE = 'nacal-api';
const LAMBDA_REGION = 'sa-east-1';
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const args = process.argv.slice(2);
const send = args.includes('--send');
const stageArg = args.find(arg => arg.startsWith('--stage='));
const stage = stageArg ? stageArg.slice('--stage='.length) : 'prod';
const recipients = [...new Set(args.filter(arg => !arg.startsWith('--')).map(arg => arg.trim().toLowerCase()))];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (stage !== 'prod' && stage !== 'dev') {
  fail(`Stage inválido: "${stage}". Use --stage=prod (padrão) ou --stage=dev.`);
}

if (recipients.length === 0) {
  fail('Uso: npx tsx scripts/sendBetaInvites.ts email1@x.com email2@y.com [--send] [--stage=dev]');
}

const invalid = recipients.filter(email => !emailPattern.test(email));
if (invalid.length > 0) {
  fail(`E-mails inválidos: ${invalid.join(', ')}`);
}

const envPath = stage === 'prod' ? '.env.prod' : '.env';
const fileEnv = dotenv.config({ path: envPath, quiet: true }).parsed ?? {};

function requireEnv(name: string) {
  const value = (fileEnv[name] ?? '').trim();

  if (!value) {
    fail(`${name} ausente em ${envPath}.`);
  }

  return value;
}

const from = requireEnv('COGNITO_EMAIL');
const replyTo = requireEnv('COGNITO_EMAIL_TO_REPLY');
const sourceArn = requireEnv('SES_SOURCE_ARN');
const sesRegion = sourceArn.split(':')[3];

if (!sesRegion) {
  fail(`Não foi possível ler a região do SES_SOURCE_ARN em ${envPath}.`);
}

function isGateEnabled(raw: string | undefined) {
  const value = (raw ?? '').trim().toLowerCase();

  return value !== 'false' && value !== '0' && value !== '';
}

async function findNotAllowed() {
  const functionName = `${SERVICE}-${stage}-preSignUpTrigger`;
  const lambda = new LambdaClient({ region: LAMBDA_REGION });
  const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  const variables = config.Environment?.Variables ?? {};

  if (!isGateEnabled(variables.BETA_GATE_ENABLED)) {
    console.log(`Beta gate desligado em ${functionName}: todos os e-mails estão liberados.`);
    return [];
  }

  const allowed = new Set(
    (variables.BETA_ALLOWED_EMAILS ?? '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  );

  return recipients.filter(email => !allowed.has(email));
}

async function main() {
  const notAllowed = await findNotAllowed();

  if (notAllowed.length > 0) {
    fail(`Ainda não liberados no BETA_ALLOWED_EMAILS publicado (${stage}). Adicione e faça o deploy antes de convidar:\n${notAllowed.map(email => `  - ${email}`).join('\n')}`);
  }

  const email = betaInviteEmail();

  if (!send) {
    const outDir = join(tmpdir(), 'nacal-beta-invite');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'betaInvite.html'), email.html);
    writeFileSync(join(outDir, 'betaInvite.txt'), email.text);

    console.log(`Dry-run (${stage}). Todos liberados. Destinatários:`);
    recipients.forEach(recipient => console.log(`  - ${recipient}`));
    console.log(`From: ${from} | Reply-To: ${replyTo} | Assunto: ${email.subject}`);
    console.log(`Preview em ${join(outDir, 'betaInvite.html')}`);
    console.log('Rode de novo com --send para enviar.');
    return;
  }

  const ses = new SESv2Client({ region: sesRegion });
  let failures = 0;

  for (const recipient of recipients) {
    try {
      await ses.send(new SendEmailCommand({
        FromEmailAddress: from,
        FromEmailAddressIdentityArn: sourceArn,
        ReplyToAddresses: [replyTo],
        Destination: { ToAddresses: [recipient] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: email.html, Charset: 'UTF-8' },
              Text: { Data: email.text, Charset: 'UTF-8' },
            },
          },
        },
      }));
      console.log(`ok    ${recipient}`);
    } catch (error) {
      failures += 1;
      console.error(`erro  ${recipient}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`${recipients.length - failures} enviado(s), ${failures} com erro.`);

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
