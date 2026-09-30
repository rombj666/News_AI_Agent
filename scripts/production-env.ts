import { readFile } from 'node:fs/promises';
export async function productionEnv() {
  // This repository deliberately keeps wrangler.jsonc as strict JSON.
  const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));
  return {...process.env,...config.vars} as Record<string,string|undefined>;
}
