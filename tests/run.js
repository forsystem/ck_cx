// 简易测试运行器：只看断言抛错，输出最终通过/失败数。无任何依赖。
'use strict';

const path = require('path');
const fs = require('fs');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg || 'eq'}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

async function run() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('用法: node tests/run.js <test file...>');
    process.exit(1);
  }

  for (const f of files) {
    require(path.resolve(f));
  }

  const t0 = Date.now();
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      pass++;
    } catch (e) {
      console.log(`  ✗ ${t.name}`);
      console.log(`    ${(e.stack || e.message).split('\n').join('\n    ')}`);
      fail++;
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n合计: ${pass} 通过 / ${fail} 失败 （${elapsed}s）`);
  if (fail > 0) process.exit(1);
}

module.exports = { test, eq };

if (require.main === module) run();
