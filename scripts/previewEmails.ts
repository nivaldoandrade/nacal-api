import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { RenderedEmail } from '../src/infra/emails/emailLayout';
import { betaInviteEmail } from '../src/infra/emails/templates/betaInviteEmail';
import { confirmSignUpEmail } from '../src/infra/emails/templates/confirmSignUpEmail';
import { forgotPasswordEmail } from '../src/infra/emails/templates/forgotPasswordEmail';

const COGNITO_EMAIL_MAX_LENGTH = 20000;
const sample = { code: '482913', name: 'Maria Silva' };

const emails: Record<string, RenderedEmail> = {
  confirmSignUp: confirmSignUpEmail(sample),
  forgotPassword: forgotPasswordEmail(sample),
  betaInvite: betaInviteEmail(),
};

const outDir = resolve(process.argv[2] ?? join(tmpdir(), 'nacal-email-preview'));
mkdirSync(outDir, { recursive: true });

function escapeAttribute(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const sections = Object.entries(emails).map(([name, email]) => {
  writeFileSync(join(outDir, `${name}.html`), email.html);
  writeFileSync(join(outDir, `${name}.txt`), email.text);

  const length = email.html.length;
  const status = length <= COGNITO_EMAIL_MAX_LENGTH ? 'ok' : 'ACIMA DO LIMITE';
  console.log(`${name}: ${length} caracteres de HTML (${status}, limite ${COGNITO_EMAIL_MAX_LENGTH})`);

  const frame = (scheme: 'light' | 'dark') => `<figure><figcaption>${scheme === 'light' ? 'Claro' : 'Escuro'}</figcaption><iframe style="color-scheme:${scheme}" srcdoc="${escapeAttribute(email.html)}"></iframe></figure>`;

  return `<section><h2>${email.subject}</h2><p>${length} caracteres de HTML</p><div class="row">${frame('light')}${frame('dark')}</div></section>`;
});

const index = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Preview dos e-mails do NaCal</title><style>body{font-family:system-ui,sans-serif;margin:24px;background:#fff;color:#18181b}.row{display:flex;gap:16px;flex-wrap:wrap}figure{margin:0}iframe{width:420px;height:720px;border:1px solid #e4e4e7;border-radius:8px}</style></head><body>${sections.join('')}</body></html>`;

writeFileSync(join(outDir, 'index.html'), index);
console.log(`Preview em ${join(outDir, 'index.html')}`);
