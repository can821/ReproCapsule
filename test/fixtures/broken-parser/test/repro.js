import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProfile } from '../src/parser.js';

const input = JSON.parse(readFileSync(new URL('../data/profile.json', import.meta.url), 'utf8'));
assert.deepEqual(parseProfile(input), { id: 7, name: '' });
