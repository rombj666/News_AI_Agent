import { productionPreflight } from '../src/production/preflight.js';
import { productionEnv } from './production-env.js';
// Offline only. No network, secret values, setting changes or paid calls.
try {
  const results=productionPreflight(await productionEnv());
  for(const r of results)console.log(`${r.name} ${r.fields.length?'FAIL '+r.fields.join(','):'PASS'}`);
  if(results.some(r=>r.fields.length))process.exitCode=1;
}catch{console.error('PRODUCTION_CONFIG FAIL CONFIG_FILE_INVALID');process.exitCode=1;}
