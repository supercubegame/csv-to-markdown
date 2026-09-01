#!/usr/bin/env node
// 心跳存在的理由只有一个：平台会因为仓库长期不活跃**静默停用定时工作流**，
// 而那时 workflow 文件一个字都不会变 —— 「读配置确认 cron 还在」这条检查
// 会在它本该抓住的那次失效上保持绿色。「没有坏消息」和「已经死了」长得一样，
// 带时间戳的正向痕迹不会。
//
// 三个设计点：
// 1. 闸门红也要盖戳（workflow 里是 always()）。心跳回答「这条链还活着吗」，
//    不是「产品对不对」。混在一起的话，一次真失败会伪装成一条死 cron。
// 2. 防自触发靠结构：这一步只在 schedule 或显式手动请求时执行，它推出去的
//    提交触发的是普通 push，那一次永远不写。循环由构造终止，不依赖任何字符串。
// 3. 手动那条路写的是另一个字段。新鲜度只读 last_scheduled_run —— 一次手动
//    盖戳不得救活一条已经死掉的 cron。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const now = new Date().toISOString();
const event = process.env.EVENT || 'unknown';
const prev = existsSync('heartbeat.json') ? JSON.parse(readFileSync('heartbeat.json', 'utf8')) : {};

const next = {
  last_scheduled_run: event === 'schedule' ? now : (prev.last_scheduled_run ?? null),
  last_manual_run: event === 'schedule' ? (prev.last_manual_run ?? null) : now,
  last_event: event,
  last_gate_results: {
    fast: process.env.FAST_RESULT || 'unknown',
    web: process.env.WEB_RESULT || 'unknown',
  },
};

writeFileSync('heartbeat.json', JSON.stringify(next, null, 2) + '\n');
console.log(`心跳已写：${event} @ ${now}`);
