export type EmailBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'code'; value: string }
  | { type: 'note'; text: string }
  | { type: 'button'; text: string; href: string };

export type EmailContent = {
  subject: string;
  preheader: string;
  heading: string;
  blocks: EmailBlock[];
  footerReason?: string;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

const SITE_URL = 'https://www.nacal.app';
const LOGO_URL = `${SITE_URL}/assets/apple-touch-icon.png`;
const CONTAINER_WIDTH = 520;
const FONT_STACK = '-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif';
const MONO_STACK = '\'SF Mono\',Menlo,Consolas,\'Courier New\',monospace';
const FOOTER_REASON = 'Você recebeu este e-mail porque este endereço foi usado no NaCal.';
const FOOTER_REPLY = 'Dúvidas? É só responder este e-mail.';

const colors = {
  page: '#f4f4f5',
  card: '#ffffff',
  border: '#e4e4e7',
  text: '#18181b',
  muted: '#71717a',
  accent: '#bef264',
  accentInk: '#1a2e05',
  link: '#64a30d',
};

const darkColors = {
  page: '#09090b',
  card: '#18181b',
  border: '#27272a',
  text: '#fafafa',
  muted: '#a1a1aa',
  link: '#bef264',
};

const baseStyles = [
  'body{margin:0;padding:0;width:100%;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}',
  'table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}',
  'img{-ms-interpolation-mode:bicubic}',
  `@media (max-width:${CONTAINER_WIDTH}px){.nc-pad{padding:28px 20px!important}.nc-code{font-size:28px!important;letter-spacing:6px!important}}`,
].join('');

const darkRules = [
  `.nc-page{background-color:${darkColors.page}!important}`,
  `.nc-card{background-color:${darkColors.card}!important;border-color:${darkColors.border}!important}`,
  `.nc-text{color:${darkColors.text}!important}`,
  `.nc-muted{color:${darkColors.muted}!important}`,
  `.nc-link{color:${darkColors.link}!important}`,
];

const darkStyles = `@media (prefers-color-scheme:dark){${darkRules.join('')}}`;

const outlookComDarkStyles = [
  `[data-ogsb] .nc-page{background-color:${darkColors.page}!important}`,
  `[data-ogsb] .nc-card{background-color:${darkColors.card}!important}`,
  `[data-ogsc] .nc-text{color:${darkColors.text}!important}`,
  `[data-ogsc] .nc-muted{color:${darkColors.muted}!important}`,
  `[data-ogsc] .nc-link{color:${darkColors.link}!important}`,
].join('');

const appleDataDetectorStyles = 'a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}';

const msoHead = '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>body,table,td,p,h1,a,span{font-family:Arial,Helvetica,sans-serif!important}.nc-code{font-family:Consolas,\'Courier New\',monospace!important}</style><![endif]-->';

const msoContainerOpen = `<!--[if mso]><table role="presentation" width="${CONTAINER_WIDTH}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`;
const msoContainerClose = '<!--[if mso]></td></tr></table><![endif]-->';

const preheaderFiller = '&#8199;&#65279;&#847; '.repeat(40);

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textStyle({ size, lineHeight, color, margin }: { size: number; lineHeight: number; color: string; margin: string }) {
  return `margin:${margin};font-family:${FONT_STACK};font-size:${size}px;line-height:${lineHeight}px;mso-line-height-rule:exactly;color:${color}`;
}

function renderBlockHtml(block: EmailBlock) {
  if (block.type === 'code') {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td align="center" bgcolor="${colors.accent}" style="background-color:${colors.accent};border-radius:12px;padding:20px 12px"><span class="nc-code" style="font-family:${MONO_STACK};font-size:32px;line-height:40px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:8px;color:${colors.accentInk}">${escapeHtml(block.value)}</span></td></tr></table>`;
  }

  if (block.type === 'button') {
    const href = escapeHtml(block.href);

    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 24px"><tr><td align="center" bgcolor="${colors.accent}" style="background-color:${colors.accent};border-radius:12px"><a href="${href}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT_STACK};font-size:16px;line-height:24px;mso-line-height-rule:exactly;font-weight:600;color:${colors.accentInk};text-decoration:none;border-radius:12px">${escapeHtml(block.text)}</a></td></tr></table>`;
  }

  if (block.type === 'note') {
    return `<p class="nc-muted" style="${textStyle({ size: 14, lineHeight: 22, color: colors.muted, margin: '0 0 16px' })}">${escapeHtml(block.text)}</p>`;
  }

  return `<p class="nc-text" style="${textStyle({ size: 16, lineHeight: 26, color: colors.text, margin: '0 0 16px' })}">${escapeHtml(block.text)}</p>`;
}

function renderBlockText(block: EmailBlock) {
  if (block.type === 'code') {
    return `    ${block.value}`;
  }

  if (block.type === 'button') {
    return `${block.text}: ${block.href}`;
  }

  return block.text;
}

function renderHead(subject: string) {
  return [
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeHtml(subject)}</title>`,
    msoHead,
    `<style>${baseStyles}</style>`,
    `<style>${darkStyles}</style>`,
    `<style>${outlookComDarkStyles}</style>`,
    `<style>${appleDataDetectorStyles}</style>`,
    '</head>',
  ].join('');
}

function renderHtml({ subject, preheader, heading, blocks, footerReason = FOOTER_REASON }: EmailContent) {
  const body = blocks.map(renderBlockHtml).join('');
  const footerStyle = textStyle({ size: 12, lineHeight: 18, color: colors.muted, margin: '0 0 8px' });
  const lastFooterStyle = textStyle({ size: 12, lineHeight: 18, color: colors.muted, margin: '0' });

  return [
    '<!DOCTYPE html>',
    '<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">',
    renderHead(subject),
    `<body class="nc-page" style="margin:0;padding:0;width:100%;background-color:${colors.page}">`,
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escapeHtml(preheader)}${preheaderFiller}</div>`,
    `<table role="presentation" class="nc-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${colors.page}" style="background-color:${colors.page}"><tr><td align="center" style="padding:32px 16px">`,
    msoContainerOpen,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${CONTAINER_WIDTH}px">`,
    `<tr><td align="center" style="padding:0 0 24px"><a href="${SITE_URL}" style="text-decoration:none"><img src="${LOGO_URL}" width="56" height="56" alt="NaCal" style="display:block;width:56px;height:56px;border:0;outline:none;border-radius:14px;font-family:${FONT_STACK};font-size:18px;font-weight:700;color:${colors.text}"></a></td></tr>`,
    `<tr><td class="nc-card nc-pad" bgcolor="${colors.card}" style="background-color:${colors.card};border:1px solid ${colors.border};border-radius:16px;padding:36px 32px">`,
    `<h1 class="nc-text" style="${textStyle({ size: 24, lineHeight: 32, color: colors.text, margin: '0 0 20px' })};font-weight:600">${escapeHtml(heading)}</h1>`,
    body,
    '</td></tr>',
    '<tr><td align="center" style="padding:24px 16px 0">',
    `<p class="nc-muted" style="${footerStyle}">${escapeHtml(footerReason)}</p>`,
    `<p class="nc-muted" style="${footerStyle}">${escapeHtml(FOOTER_REPLY)}</p>`,
    `<p class="nc-muted" style="${lastFooterStyle}"><a class="nc-link" href="${SITE_URL}" style="font-family:${FONT_STACK};color:${colors.link};text-decoration:none">nacal.app</a></p>`,
    '</td></tr>',
    '</table>',
    msoContainerClose,
    '</td></tr></table>',
    '</body></html>',
  ].join('');
}

function renderText({ heading, blocks, footerReason = FOOTER_REASON }: EmailContent) {
  return [
    heading,
    '',
    ...blocks.flatMap((block) => [renderBlockText(block), '']),
    '--',
    footerReason,
    FOOTER_REPLY,
    'nacal.app',
  ].join('\n');
}

export function renderEmail(content: EmailContent): RenderedEmail {
  return {
    subject: content.subject,
    html: renderHtml(content),
    text: renderText(content),
  };
}

export function greeting(name?: string) {
  const firstName = name?.trim().split(/\s+/)[0];

  if (!firstName) {
    return 'Oi!';
  }

  return `Oi, ${firstName}!`;
}
