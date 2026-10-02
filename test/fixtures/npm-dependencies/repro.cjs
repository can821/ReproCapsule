const parse = require('@repro/parser');
const prepare = require('@repro/helper');
const input = require('./profile.json');
parse(prepare(input));
