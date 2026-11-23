'use strict';

const source = require('../data/promotion-authoring-audiences.json');

module.exports = typeof source === 'string' ? JSON.parse(source) : source;
