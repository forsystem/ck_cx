// Shared parser for `cx/ck test [range] [model]` argument lists.
// 设计目标：纯函数，无副作用，方便单测。
//
// 返回：
//   { ok: true,  indices: number[], model: string | null }
//   { ok: false, code: string, message: string }
//
// code 取值：
//   - empty_keys          配置里没有任何 key
//   - bad_range_syntax    第一个参数既不是数字也不是 a-b
//   - bad_range_order     a > b，例如 4-1
//   - out_of_range        索引超过 keys.length 或小于 1
//   - too_many_args       多余的尾部参数
//
// 约定：indices 是 0-based，但用户输入是 1-based。

'use strict';

function stripWrappingQuotes(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

function isPositiveInt(s) {
  return /^[1-9][0-9]*$/.test(s);
}

function isNonNegativeInt(s) {
  return /^(?:0|[1-9][0-9]*)$/.test(s);
}

function parseRange(token, total) {
  const t = String(token).trim();

  // 单数字 0 → 友好提示
  if (t === '0') {
    return {
      ok: false,
      code: 'bad_range_syntax',
      message: '编号从 1 开始，不存在第 0 个 key。用法示例：test 1 / test 1-4',
    };
  }

  if (isPositiveInt(t)) {
    const n = Number(t);
    if (n > total) {
      return {
        ok: false,
        code: 'out_of_range',
        message: `编号 ${n} 超出范围（当前共有 ${total} 个 key，可用范围 1-${total}）`,
      };
    }
    return { ok: true, indices: [n - 1] };
  }

  // a-b 形式
  const m = t.match(/^([0-9]+)-([0-9]+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);

    if (a === 0 || b === 0) {
      return {
        ok: false,
        code: 'bad_range_syntax',
        message: `编号从 1 开始，不存在第 0 个 key。请改用如 1-${Math.max(b, 1)} 这种形式`,
      };
    }

    if (a > b) {
      return {
        ok: false,
        code: 'bad_range_order',
        message: `非法范围 ${a}-${b}：起点必须 ≤ 终点。是不是想写 ${b}-${a}？`,
      };
    }

    if (a > total || b > total) {
      return {
        ok: false,
        code: 'out_of_range',
        message: `范围 ${a}-${b} 超出可用 key 数量（当前共有 ${total} 个，可用范围 1-${total}）`,
      };
    }

    const indices = [];
    for (let i = a; i <= b; i++) indices.push(i - 1);
    return { ok: true, indices };
  }

  return {
    ok: false,
    code: 'bad_range_syntax',
    message: `无法解析范围 "${token}"。用法示例：test 1（单个）/ test 1-4（范围）`,
  };
}

// args: 去掉 'test' 之后的剩余 argv
// total: 当前 cfg.keys.length
function parseTestArgs(args, total) {
  if (!Number.isInteger(total) || total <= 0) {
    return {
      ok: false,
      code: 'empty_keys',
      message: '还没有任何 key，先用 add 命令添加一个再试',
    };
  }

  const list = Array.isArray(args) ? args.slice() : [];

  if (list.length === 0) {
    const indices = [];
    for (let i = 0; i < total; i++) indices.push(i);
    return { ok: true, indices, model: null };
  }

  const rangeToken = stripWrappingQuotes(list[0]);
  const r = parseRange(rangeToken, total);
  if (!r.ok) return r;

  let model = null;
  if (list.length >= 2) {
    const m = stripWrappingQuotes(list[1]);
    // 去掉外层引号之后，可能还剩纯空白，视为没传
    if (m && m.trim()) model = m.trim();
  }

  if (list.length > 2) {
    return {
      ok: false,
      code: 'too_many_args',
      message: `多余的参数：${list.slice(2).join(' ')}。用法：test [编号|范围] [模型]`,
    };
  }

  return { ok: true, indices: r.indices, model };
}

module.exports = {
  parseTestArgs,
  stripWrappingQuotes,
  isPositiveInt,
  isNonNegativeInt,
  parseRange,
};
