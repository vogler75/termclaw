'use strict';
// Cron expressions for scheduled prompts: five fields (minute hour day-of-month month day-of-week) in
// local time, with *, lists (1,5), ranges (1-5) and steps (*/15, 8-18/2). Day of week: 0 or 7 = Sunday.
// As in cron, when both day fields are restricted a day matches if either one does.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseField(text, f) {
  const set = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Schedule: "${part}" is not a valid ${f.name}`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`Schedule: step 0 in ${f.name}`);
    let lo = f.min;
    let hi = f.max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      // "5/15" means from 5 to the end in steps, "5" alone only 5.
      hi = b === undefined ? (m[2] === undefined ? a : f.max) : b;
    }
    if (lo < f.min || hi > f.max || lo > hi) throw new Error(`Schedule: ${f.name} must be ${f.min}–${f.max}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Schedule: five fields are needed (minute hour day month weekday)');
  const [minute, hour, dom, month, dowRaw] = parts.map((p, i) => parseField(p, FIELDS[i]));
  const dow = new Set([...dowRaw].map((d) => d % 7));
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function dayMatches(c, d) {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

// First time after `from` that matches; null if there is none within five years (e.g. 31 February).
function nextRun(expr, from = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 5 * 366 * 86400e3;
  for (let i = 0; i < 200000 && d.getTime() <= limit; i++) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

// Short text for the common shapes, the expression itself for everything else.
function describeCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return String(expr || '');
  const [mi, ho, dom, mon, dow] = parts;
  const num = (s) => /^\d+$/.test(s);
  if (dom !== '*' || mon !== '*') return expr;
  if (num(mi) && ho === '*' && dow === '*') return `every hour at :${pad(mi)}`;
  const every = /^\*\/(\d+)$/.exec(mi);
  if (every && ho === '*' && dow === '*') return `every ${every[1]} minutes`;
  if (!num(mi) || !num(ho)) return expr;
  const time = `${pad(ho)}:${pad(mi)}`;
  if (dow === '*') return `every day at ${time}`;
  if (dow === '1-5') return `weekdays at ${time}`;
  if (/^[0-7](,[0-7])*$/.test(dow)) return `${dow.split(',').map((d) => DAYS[d % 7]).join(', ')} at ${time}`;
  return expr;
}

module.exports = { parseCron, nextRun, describeCron };
