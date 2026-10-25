/**
 * CI check for the registry (npm test -w @mtgdt/registry, or `npm run check -w @mtgdt/registry`):
 *   1. registry/models.json and registry/harnesses.json validate against their JSON Schemas;
 *   2. the rules a schema can't express (validateRegistry): names unique across models, harness and provider
 *      references exist, floating-alias windows don't overlap, efforts are on the canonical scale.
 * Exits 1 with every problem listed.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { REGISTRY_DATA, validateRegistry } from './index.js';
import { PRICES, validatePrices } from './prices.js';

const root = resolve(import.meta.dirname, '../../../registry');
const problems: string[] = [];
// ajv is CommonJS: its default export is the class (or a namespace holding it, depending on the loader).
const AjvClass = ((Ajv2020 as unknown as { default?: unknown }).default ?? Ajv2020) as new (o: object) => {
  compile(schema: object): ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string; params?: unknown }> | null };
};
const ajv = new AjvClass({ allErrors: true, strict: true });
for (const [file, schema] of [['models.json', 'schema/models.schema.json'], ['harnesses.json', 'schema/harnesses.schema.json'], ['prices.json', 'schema/prices.schema.json']] as const) {
  const validate = ajv.compile(JSON.parse(readFileSync(join(root, schema), 'utf8')));
  const data = JSON.parse(readFileSync(join(root, file), 'utf8'));
  if (!validate(data)) {
    for (const e of validate.errors ?? []) problems.push(`registry/${file}${e.instancePath || ''}: ${e.message ?? 'invalid'} ${e.params ? JSON.stringify(e.params) : ''}`);
  }
}
problems.push(...validateRegistry(REGISTRY_DATA).map((e) => `registry: ${e}`));
problems.push(...validatePrices(PRICES, new Set(REGISTRY_DATA.models.map((m) => m.id))).map((e) => `registry: ${e}`));

if (problems.length) {
  console.error(`registry check failed (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`registry ok: ${REGISTRY_DATA.models.length} models, ${REGISTRY_DATA.harnesses.length} harnesses, schema and uniqueness checks passed`);
