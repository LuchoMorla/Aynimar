'use strict';
// node scripts/deploy-health-test.js — el aviso de deploy no marca como faltante lo que no se usa.
const assert = require('assert');
const { deployHealthChecks } = require('../libs/deployHealth');

const base = { JWT_SECRET: 'x', GROQ_API_KEY: 'x', DROPI_WORKER_URL: 'https://w', DROPI_WORKER_KEY: 'k' };

assert.deepStrictEqual(deployHealthChecks(base).missing, [], 'producción actual (login + Worker, sin integration key) = OK');
assert.deepStrictEqual(deployHealthChecks({ ...base, GROQ_API_KEY: undefined, GROQ_IA_KEY: 'x' }).missing, [], 'GROQ_IA_KEY vale');
assert.deepStrictEqual(deployHealthChecks({ ...base, DROPI_ORDER_TRANSPORT: 'http' }).missing, ['dropi_integration_key'], 'http sin clave = falta');
assert.deepStrictEqual(deployHealthChecks({ ...base, DROPI_ORDER_TRANSPORT: 'http', DROPI_INTEGRATION_KEY: 'k' }).missing, []);
assert.deepStrictEqual(deployHealthChecks({ ...base, DROPI_WORKER_KEY: undefined }).missing, ['cloudflare_worker'], 'sin Worker = falta');
assert.deepStrictEqual(deployHealthChecks({}).missing, ['jwt_secret', 'groq_api_key', 'cloudflare_worker']);

console.log('Deploy health tests: 6 passed, 0 failed');
