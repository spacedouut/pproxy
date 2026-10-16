import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PPROXY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pproxy-test-'));
const { nextUsage } = await import('../src/pool.js');

const info = (remaining, purchased = 0, consumed = 0, allowance = 1000) => ({
    monthUsageAllowance: allowance,
    remaining,
    unit: 'credits',
    addons: { purchasedCredits: purchased, consumedPurchaseCredits: consumed, purchasedStorage: 0, rateDiscounts: {} },
});

test('nextUsage without addons uses the allowance as max', () => {
    const u = nextUsage(null, info(600));
    assert.equal(u.max, 1000);
    assert.equal(u.addons, 0);
    assert.equal(nextUsage(null, { monthUsageAllowance: 1000, remaining: 600 }).max, 1000);
});

test('nextUsage holds max while addon credit is spent', () => {
    let u = nextUsage(null, info(1500, 500));
    assert.equal(u.max, 1500);
    u = nextUsage(u, info(700, 500));
    assert.equal(u.max, 1500);
    u = nextUsage(u, info(300, 500, 200));
    assert.equal(u.addons, 300);
    assert.equal(u.max, 1500);
});

test('nextUsage resets max when addon credit runs out or grows', () => {
    let u = nextUsage(null, info(1500, 500));
    u = nextUsage(u, info(0, 500, 500));
    assert.equal(u.max, 1000);
    u = nextUsage(null, info(300, 500, 200));
    u = nextUsage(u, info(100, 500, 400));
    assert.equal(u.max, 1300);
    u = nextUsage(u, info(1100, 1500, 400));
    assert.equal(u.addons, 1100);
    assert.equal(u.max, 1100 + 1000);
});

test('nextUsage resets max on a month rollover or plan change', () => {
    let u = nextUsage(null, info(1500, 500));
    u = nextUsage(u, info(200, 500, 300));
    assert.equal(u.max, 1500);
    u = nextUsage(u, info(1200, 500, 300));
    assert.equal(u.max, 1200);
    u = nextUsage(u, info(4000, 500, 300, 5000));
    assert.equal(u.max, 5200);
});
