/* eslint-disable no-console */
import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';

dotenv.config({ path: '.env.local' });

const API_DOMAIN_NAME = process.env.API_DOMAIN_NAME?.replace(/\/+$/, '');
const TOKEN = process.env.BEAREAR_TOKEN;

if (!API_DOMAIN_NAME || !TOKEN) {
  throw new Error('Missing API_DOMAIN_NAME or BEAREAR_TOKEN in .env.local');
}

const API_URL = `${API_DOMAIN_NAME}/create-meal`;

interface IPresignResponse {
  mealId: string;
  uploadSignature: string;
}

interface ICreateMealResponse {
  mealId: string;
  url: string;
  fields: Record<string, string>;
}

type MimeType = 'audio/m4a' | 'image/jpeg' | 'audio/3gp' | 'audio/webm';

// ─── Edite aqui para testar manualmente ──────────────────────────────────────
// file:             asset em scripts/assets (image.jpg, audio.m4a, audio.webm...)
// mimeType:         precisa casar com o asset
// timeZone:         fuso IANA usado pela API para decidir name/icon (ex.: America/Sao_Paulo)
// localHourOverride: se definido (0-23), ignora `timeZone` e força essa hora local
//                    com um fuso fixo Etc/GMT (teste determinístico, sem depender do relógio)
// Exemplos:
//   - Almoço:   localHourOverride: 14
//   - Café:     localHourOverride: 8
//   - Override por áudio ("estou almoçando" às 16h): mimeType audio/m4a + localHourOverride: 16
const CONFIG = {
  file: path.resolve(__dirname, 'assets', 'audio-cafe.m4a'),
  mimeType: 'audio/m4a' as MimeType,
  timeZone: 'America/Sao_Paulo' as string | undefined,
  localHourOverride: 22 as number | undefined,
};
// ─────────────────────────────────────────────────────────────────────────────

async function readFile(filePath: string, type: MimeType): Promise<{
  data: Buffer;
  size: number;
  type: string;
}> {
  console.log(`🔍 Reading file from disk: ${filePath}`);
  const data = await fs.readFile(filePath);
  return {
    data,
    size: data.length,
    type,
  };
}

function timeZoneForLocalHour(targetHour: number, at: Date = new Date()): string {
  let offset = targetHour - at.getUTCHours();

  while (offset > 14) {
    offset -= 24;
  }

  while (offset < -12) {
    offset += 24;
  }

  if (offset === 0) {
    return 'UTC';
  }

  const sign = offset <= 0 ? '+' : '-';

  return `Etc/GMT${sign}${Math.abs(offset)}`;
}

async function createMeal(
  fileType: string,
  fileSize: number,
  timeZone?: string,
): Promise<ICreateMealResponse> {
  console.log(`🚀 Requesting presigned POST for ${fileSize} bytes of type ${fileType}`);
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ contentType: fileType, fileSize, timeZone }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get presigned POST: ${res.status} ${res.statusText} — ${body}`);
  }

  const json = (await res.json()) as IPresignResponse;
  const decoded = JSON.parse(
    Buffer.from(json.uploadSignature, 'base64').toString('utf-8'),
  ) as ICreateMealResponse;

  console.log('✅ Received presigned POST data');
  return {
    ...decoded,
    mealId: json.mealId,
  };
}

function buildFormData(
  fields: Record<string, string>,
  fileData: Buffer,
  filename: string,
  fileType: string,
): FormData {
  console.log(`📦 Building FormData with ${Object.keys(fields).length} fields and file ${filename}`);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  const blob = new Blob([new Uint8Array(fileData)], { type: fileType });
  form.append('file', blob, filename);
  return form;
}

async function uploadToS3(url: string, form: FormData): Promise<void> {
  console.log(`📤 Uploading to S3 at ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`S3 upload failed: ${res.status} ${res.statusText} — ${text}`);
  }

  console.log('🎉 Upload completed successfully');
}

async function uploadFile({ file, mimeType, timeZone }: IUploadFileParams): Promise<void> {
  try {
    const { data, size, type } = await readFile(file, mimeType);
    const { url, fields } = await createMeal(type, size, timeZone);
    const form = buildFormData(fields, data, path.basename(file), type);
    await uploadToS3(url, form);
  } catch (err) {
    console.error('❌ Error during uploadFile:', err);
    throw err;
  }
}

interface IUploadFileParams {
  file: string;
  mimeType: MimeType;
  timeZone?: string;
}

const effectiveTimeZone = CONFIG.localHourOverride !== undefined
  ? timeZoneForLocalHour(CONFIG.localHourOverride)
  : CONFIG.timeZone;

console.log(`🧭 timeZone usada pela API: ${effectiveTimeZone ?? '(fallback da API)'}`);

uploadFile({
  file: CONFIG.file,
  mimeType: CONFIG.mimeType,
  timeZone: effectiveTimeZone,
}).catch(() => process.exit(1));
