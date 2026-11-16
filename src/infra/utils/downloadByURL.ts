export async function downloadByURL(url: string, init?: { signal?: AbortSignal }): Promise<Buffer> {
  const response = await fetch(url, { signal: init?.signal });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}
