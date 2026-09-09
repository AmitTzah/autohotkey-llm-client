'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../headless/seed');

describe('headless seed date helpers', () => {
  it('daysAgo formats the local calendar date without converting through UTC', () => {
    const RealDate = global.Date;
    class LocalMidnightDate {
      constructor() {
        this.year = 2026;
        this.month = 8; // September, zero-based
        this.day = 9;
      }
      getFullYear() { return this.year; }
      getMonth() { return this.month; }
      getDate() { return this.day; }
      setDate(value) { this.day = value; }
      toISOString() { throw new Error('daysAgo must not convert local fixture dates through UTC'); }
    }

    try {
      global.Date = LocalMidnightDate;
      assert.equal(seed.daysAgo(0), '2026-09-09');
      assert.equal(seed.daysAgo(1), '2026-09-08');
    } finally {
      global.Date = RealDate;
    }
  });
});
