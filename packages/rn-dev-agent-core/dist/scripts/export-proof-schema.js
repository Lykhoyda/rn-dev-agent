import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { datetimeRegex } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { finalProofReceiptSchema } from '../domain/proof-receipt.js';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(scriptDir, '../../schemas/proof-receipt.schema.json');
function sortJson(value) {
    if (Array.isArray(value))
        return value.map(sortJson);
    if (value === null || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, sortJson(nested)]));
}
function externalizeDateTime(jsonSchema) {
    if (!jsonSchema || !('format' in jsonSchema) || jsonSchema.format !== 'date-time') {
        return jsonSchema;
    }
    const { format: _format, ...converted } = jsonSchema;
    return { ...converted, pattern: datetimeRegex({}).source };
}
const schema = zodToJsonSchema(finalProofReceiptSchema, {
    name: 'FinalProofReceipt',
    nameStrategy: 'title',
    target: 'jsonSchema7',
    $refStrategy: 'none',
    removeAdditionalStrategy: 'strict',
    postProcess: externalizeDateTime,
});
const bytes = `${JSON.stringify(sortJson(schema), null, 2)}\n`;
const digest = createHash('sha256').update(bytes).digest('hex');
const check = process.argv.includes('--check');
if (check) {
    if (!existsSync(schemaPath) || readFileSync(schemaPath, 'utf8') !== bytes) {
        process.stderr.write('proof receipt schema is stale; run yarn schema:proof\n');
        process.exitCode = 1;
    }
}
else {
    mkdirSync(dirname(schemaPath), { recursive: true });
    writeFileSync(schemaPath, bytes, 'utf8');
}
process.stdout.write(`${digest}\n`);
