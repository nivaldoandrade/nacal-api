import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const API_DOMAIN_NAME = process.env.API_DOMAIN_NAME?.replace(/\/+$/, '');
const TOKEN = process.env.BEAREAR_TOKEN;

if (!API_DOMAIN_NAME || !TOKEN) {
  throw new Error('Missing API_DOMAIN_NAME or BEAREAR_TOKEN in .env.local');
}

const API_URL = `${API_DOMAIN_NAME}/meals/text`;

const CONFIG = {
  text: 'no almoço comi 2 colheres de arroz, feijão, um bife e uma coca zero lata',
  timeZone: 'America/Sao_Paulo' as string | undefined,
  localHourOverride: undefined as number | undefined,
};

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

async function createTextMeal(text: string, timeZone?: string): Promise<void> {
  console.log(`🚀 POST ${API_URL}`);
  const startedAt = Date.now();

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ text, timeZone }),
  });

  const body = await res.text();
  console.log(`⏱️ ${res.status} ${res.statusText} em ${Date.now() - startedAt}ms`);

  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body);
  }

  if (!res.ok) {
    process.exit(1);
  }
}

const effectiveTimeZone = CONFIG.localHourOverride !== undefined
  ? timeZoneForLocalHour(CONFIG.localHourOverride)
  : CONFIG.timeZone;

console.log(`🧭 timeZone usada pela API: ${effectiveTimeZone ?? '(fallback da API)'}`);
console.log(`📝 text: ${CONFIG.text}`);

createTextMeal(CONFIG.text, effectiveTimeZone).catch((error) => {
  console.error('❌ Error during createTextMeal:', error);
  process.exit(1);
});
