'use strict';

const { test, eq } = require('./run');
const { parseTestArgs, stripWrappingQuotes, parseRange } = require('../test-args');

// ---------- stripWrappingQuotes ----------
test('stripWrappingQuotes 去掉双引号', () => {
  eq(stripWrappingQuotes('"gpt-5.5"'), 'gpt-5.5');
});

test('stripWrappingQuotes 去掉单引号', () => {
  eq(stripWrappingQuotes("'gpt-5.5'"), 'gpt-5.5');
});

test('stripWrappingQuotes 保留内部引号', () => {
  eq(stripWrappingQuotes('a"b'), 'a"b');
});

test('stripWrappingQuotes 修剪空白', () => {
  eq(stripWrappingQuotes('  hi  '), 'hi');
});

test('stripWrappingQuotes 空字符串', () => {
  eq(stripWrappingQuotes(''), '');
});

// ---------- parseRange ----------
test('parseRange 单数字', () => {
  eq(parseRange('2', 4), { ok: true, indices: [1] });
});

test('parseRange 范围', () => {
  eq(parseRange('1-4', 4), { ok: true, indices: [0, 1, 2, 3] });
});

test('parseRange a == b', () => {
  eq(parseRange('3-3', 4), { ok: true, indices: [2] });
});

test('parseRange 倒序报错', () => {
  const r = parseRange('4-1', 4);
  eq(r.ok, false);
  eq(r.code, 'bad_range_order');
});

test('parseRange 超出 total', () => {
  const r = parseRange('1-10', 4);
  eq(r.ok, false);
  eq(r.code, 'out_of_range');
});

test('parseRange 单数超出 total', () => {
  const r = parseRange('5', 4);
  eq(r.ok, false);
  eq(r.code, 'out_of_range');
});

test('parseRange 0 给友好提示', () => {
  const r = parseRange('0', 4);
  eq(r.ok, false);
  eq(r.code, 'bad_range_syntax');
  if (!/编号从 1 开始/.test(r.message)) throw new Error('期望编号从1开始提示\n' + r.message);
});

test('parseRange 0-3 给友好提示', () => {
  const r = parseRange('0-3', 4);
  eq(r.ok, false);
  eq(r.code, 'bad_range_syntax');
  if (!/编号从 1 开始/.test(r.message)) throw new Error('期望编号从1开始提示\n' + r.message);
});

test('parseRange 1-0 也给友好提示', () => {
  const r = parseRange('1-0', 4);
  eq(r.ok, false);
  eq(r.code, 'bad_range_syntax');
});

test('parseRange 负数非法', () => {
  const r = parseRange('-1', 4);
  eq(r.ok, false);
  eq(r.code, 'bad_range_syntax');
});

test('parseRange 字母非法', () => {
  const r = parseRange('abc', 4);
  eq(r.ok, false);
  eq(r.code, 'bad_range_syntax');
});

test('parseRange 不合法分隔符', () => {
  const r = parseRange('1..4', 4);
  eq(r.ok, false);
  eq(r.code, 'bad_range_syntax');
});

// ---------- parseTestArgs ----------
test('parseTestArgs 无参数 → 全部 key', () => {
  eq(parseTestArgs([], 4), { ok: true, indices: [0, 1, 2, 3], model: null });
});

test('parseTestArgs 范围 + 模型', () => {
  eq(parseTestArgs(['1-4', 'gpt-5.5'], 4), { ok: true, indices: [0, 1, 2, 3], model: 'gpt-5.5' });
});

test('parseTestArgs 范围 + 带引号模型', () => {
  eq(parseTestArgs(['1-4', '"gpt-5.5"'], 4), { ok: true, indices: [0, 1, 2, 3], model: 'gpt-5.5' });
});

test('parseTestArgs 范围 + 单引号模型', () => {
  eq(parseTestArgs(['1-4', "'claude-opus-4-7'"], 4), { ok: true, indices: [0, 1, 2, 3], model: 'claude-opus-4-7' });
});

test('parseTestArgs 单 key', () => {
  eq(parseTestArgs(['2'], 4), { ok: true, indices: [1], model: null });
});

test('parseTestArgs 单 key + 模型', () => {
  eq(parseTestArgs(['2', 'gpt-5.5'], 4), { ok: true, indices: [1], model: 'gpt-5.5' });
});

test('parseTestArgs 非法范围 4-1', () => {
  const r = parseTestArgs(['4-1'], 4);
  eq(r.ok, false);
  eq(r.code, 'bad_range_order');
});

test('parseTestArgs 超范围 1-99', () => {
  const r = parseTestArgs(['1-99'], 4);
  eq(r.ok, false);
  eq(r.code, 'out_of_range');
});

test('parseTestArgs 空 keys', () => {
  const r = parseTestArgs([], 0);
  eq(r.ok, false);
  eq(r.code, 'empty_keys');
});

test('parseTestArgs 空 keys + 范围 也报 empty_keys', () => {
  const r = parseTestArgs(['1-4'], 0);
  eq(r.ok, false);
  eq(r.code, 'empty_keys');
});

test('parseTestArgs 多余参数', () => {
  const r = parseTestArgs(['1-4', 'gpt-5.5', 'extra'], 4);
  eq(r.ok, false);
  eq(r.code, 'too_many_args');
});

test('parseTestArgs 第一个参数是 garbage', () => {
  const r = parseTestArgs(['gpt-5.5'], 4);
  eq(r.ok, false);
  eq(r.code, 'bad_range_syntax');
});

test('parseTestArgs 范围 + 空字符串模型 → null', () => {
  eq(parseTestArgs(['1-4', ''], 4), { ok: true, indices: [0, 1, 2, 3], model: null });
});

test('parseTestArgs 范围 + 模型中间带点号', () => {
  eq(parseTestArgs(['1-2', 'claude-3-5-haiku-20241022'], 4),
     { ok: true, indices: [0, 1], model: 'claude-3-5-haiku-20241022' });
});

test('parseTestArgs 模型带前后空格被 trim', () => {
  eq(parseTestArgs(['1-2', '  gpt-5.5  '], 4),
     { ok: true, indices: [0, 1], model: 'gpt-5.5' });
});

test('parseTestArgs 模型带引号 + 空格 → 都剥掉', () => {
  eq(parseTestArgs(['1-2', '  "gpt-5.5"  '], 4),
     { ok: true, indices: [0, 1], model: 'gpt-5.5' });
});

test('parseTestArgs 范围 + 仅空格模型 → 视为没传', () => {
  eq(parseTestArgs(['1-2', '   '], 4),
     { ok: true, indices: [0, 1], model: null });
});

test('parseTestArgs total = 1 时单 key 测试', () => {
  eq(parseTestArgs(['1'], 1),
     { ok: true, indices: [0], model: null });
});

test('parseTestArgs total = 1 时 1-1 也合法', () => {
  eq(parseTestArgs(['1-1'], 1),
     { ok: true, indices: [0], model: null });
});

test('parseTestArgs 非常大的范围 → 超出', () => {
  const r = parseTestArgs(['1-1000000'], 4);
  eq(r.ok, false);
  eq(r.code, 'out_of_range');
});

test('parseTestArgs 模型引号内全是空格 → null', () => {
  eq(parseTestArgs(['1-2', '"  "'], 4),
     { ok: true, indices: [0, 1], model: null });
});

test('parseTestArgs 模型周围有空格 + 引号内有空格 → null', () => {
  eq(parseTestArgs(['1-2', ' " " '], 4),
     { ok: true, indices: [0, 1], model: null });
});
