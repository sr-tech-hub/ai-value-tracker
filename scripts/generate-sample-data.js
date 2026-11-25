#!/usr/bin/env node
// Generates data/sample-usage.json: six months of fictional AI-tool usage for
// "Maplebridge Labs". Run with: node scripts/generate-sample-data.js
//
// No dependencies. The random numbers come from a fixed seed, so every run
// produces the identical file and the numbers quoted in the README stay true.
//
// The file holds raw facts only (seats, last active dates, task counts).
// Hours saved, value and ROI are calculated by the dashboard from editable
// assumptions, so they are deliberately not stored here.

'use strict';

const fs = require('fs');
const path = require('path');

const SEED = 20261031;
const AS_OF = '2026-10-31'; // "Unused for 30+ days" is measured from this date, not from today.
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const TASK_TYPES = ['writing', 'summarizing', 'coding', 'research', 'supportReplies'];

// Small seeded random number generator (mulberry32). Math.random() can't be
// seeded, which would give different data on every run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const chance = (p) => rand() < p;
const between = (min, max) => min + rand() * (max - min);
const intBetween = (min, max) => Math.floor(between(min, max + 1));

// SAMPLE prices for illustration only. Not real vendor pricing.
// category: "assistant" tools do the same general job, so one person holding
// two of them is overlap. "coding" tools are specialised and don't overlap.
const TOOLS = [
  { id: 'claude', name: 'Claude', category: 'assistant', monthlyPricePerSeat: 30 },
  { id: 'chatgpt', name: 'ChatGPT', category: 'assistant', monthlyPricePerSeat: 30 },
  { id: 'copilot', name: 'GitHub Copilot', category: 'coding', monthlyPricePerSeat: 20 },
  { id: 'gemini', name: 'Gemini', category: 'assistant', monthlyPricePerSeat: 25 },
];

const DEFAULT_UNUSED_ODDS = 0.08;

// Per team:
//   seatOdds       chance an employee holds a seat for each tool
//   unusedOdds     overrides DEFAULT_UNUSED_ODDS for specific tools
//   tasksPerMonth  AI-assisted tasks a typical active user completes
//   mix            share of those tasks by type
// The deliberate "story" in the data lives here:
//   Support   - heavy, high-value use (great ROI)
//   Sales     - ChatGPT bought for everyone, barely used (poor ROI)
//   Marketing - pays for ChatGPT and Gemini for the same writing work (overlap)
const TEAMS = [
  {
    name: 'Engineering', headcount: 50,
    seatOdds: { claude: 0.7, copilot: 0.9, chatgpt: 0.15 },
    tasksPerMonth: 15,
    mix: { coding: 0.55, research: 0.2, writing: 0.15, summarizing: 0.1 },
  },
  {
    name: 'Sales', headcount: 35,
    seatOdds: { chatgpt: 0.95, claude: 0.1 },
    unusedOdds: { chatgpt: 0.45 },
    tasksPerMonth: 3,
    mix: { writing: 0.5, research: 0.3, summarizing: 0.2 },
  },
  {
    name: 'Support', headcount: 30,
    seatOdds: { claude: 0.85, chatgpt: 0.15 },
    tasksPerMonth: 70,
    mix: { supportReplies: 0.65, summarizing: 0.2, writing: 0.15 },
  },
  {
    name: 'Marketing', headcount: 20,
    seatOdds: { chatgpt: 0.85, gemini: 0.7, claude: 0.2 },
    unusedOdds: { gemini: 0.4 },
    tasksPerMonth: 30,
    mix: { writing: 0.6, research: 0.25, summarizing: 0.15 },
  },
  {
    name: 'Operations', headcount: 20,
    seatOdds: { chatgpt: 0.5, claude: 0.3 },
    tasksPerMonth: 18,
    mix: { summarizing: 0.4, writing: 0.3, research: 0.3 },
  },
  {
    name: 'Design', headcount: 15,
    seatOdds: { claude: 0.5, chatgpt: 0.4 },
    tasksPerMonth: 15,
    mix: { research: 0.4, writing: 0.3, summarizing: 0.3 },
  },
  {
    name: 'Finance', headcount: 15,
    seatOdds: { chatgpt: 0.5, claude: 0.3 },
    tasksPerMonth: 18,
    mix: { summarizing: 0.5, research: 0.3, writing: 0.2 },
  },
  {
    name: 'HR', headcount: 15,
    seatOdds: { chatgpt: 0.6, gemini: 0.2 },
    tasksPerMonth: 15,
    mix: { writing: 0.6, summarizing: 0.3, research: 0.1 },
  },
];

const COPILOT_MIX = { coding: 1 }; // Copilot only does coding, whatever the team.

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function emptyTasks() {
  return Object.fromEntries(TASK_TYPES.map((t) => [t, 0]));
}

function splitTasks(total, mix) {
  const tasks = emptyTasks();
  for (const [type, share] of Object.entries(mix)) {
    tasks[type] = Math.round(total * share * between(0.8, 1.2));
  }
  return tasks;
}

function mainTaskType(mix) {
  return Object.entries(mix).sort((a, b) => b[1] - a[1])[0][0];
}

function buildSeat(seatId, employeeId, team, tool) {
  const mix = tool.id === 'copilot' ? COPILOT_MIX : team.mix;
  const unusedOdds = team.unusedOdds?.[tool.id] ?? DEFAULT_UNUSED_ODDS;
  const isUnused = chance(unusedOdds);

  // Unused seats either never started (-1) or stopped in some month before
  // October, so their last activity is at least 30 days before AS_OF.
  const lastUsedMonthIndex = isUnused
    ? (chance(0.35) ? -1 : intBetween(0, MONTHS.length - 2))
    : MONTHS.length - 1;

  const personalPace = between(0.4, 1.6); // some people are light users, some heavy
  const usage = MONTHS.map((month, i) => {
    if (i > lastUsedMonthIndex) return { month, tasks: emptyTasks() };
    const adoptionRamp = 0.8 + 0.06 * i; // usage grows slowly as people get used to the tools
    const noise = between(0.75, 1.25);
    const total = team.tasksPerMonth * personalPace * adoptionRamp * noise;
    return { month, tasks: splitTasks(total, mix) };
  });

  let lastActive = null;
  if (lastUsedMonthIndex >= 0) {
    const month = MONTHS[lastUsedMonthIndex];
    const latestDay = daysInMonth(month);
    const earliestDay = isUnused ? 1 : 5; // active seats: used within the last ~4 weeks
    lastActive = `${month}-${pad(intBetween(earliestDay, latestDay))}`;

    // A seat with a last active date must show at least one task that month.
    const last = usage[lastUsedMonthIndex].tasks;
    if (Object.values(last).every((n) => n === 0)) last[mainTaskType(mix)] = 1;
  }

  return { seatId, employeeId, team: team.name, tool: tool.id, lastActive, usage };
}

function generate() {
  const seats = [];
  let employeeNumber = 0;
  let seatNumber = 0;

  for (const team of TEAMS) {
    for (let i = 0; i < team.headcount; i++) {
      employeeNumber++;
      const employeeId = `EMP-${pad(employeeNumber, 3)}`;
      for (const tool of TOOLS) {
        const odds = team.seatOdds[tool.id] ?? 0;
        if (!chance(odds)) continue;
        seatNumber++;
        seats.push(buildSeat(`SEAT-${pad(seatNumber, 3)}`, employeeId, team, tool));
      }
    }
  }

  return {
    meta: {
      company: 'Maplebridge Labs',
      note: 'Built with sample data to protect confidentiality. Maplebridge Labs is a fictional company.',
      pricingNote: 'Seat prices are SAMPLE values for illustration, not real vendor pricing.',
      asOf: AS_OF,
      months: MONTHS,
      taskTypes: TASK_TYPES,
      seed: SEED,
      generatedBy: 'scripts/generate-sample-data.js',
    },
    teams: TEAMS.map((t) => ({ name: t.name, headcount: t.headcount })),
    tools: TOOLS.map((t) => ({ ...t, priceIsSample: true })),
    seats,
  };
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);
}

function printSummary(data) {
  const isUnused = (s) => s.lastActive === null || daysBetween(s.lastActive, data.meta.asOf) >= 30;
  const price = Object.fromEntries(data.tools.map((t) => [t.id, t.monthlyPricePerSeat]));

  const byTool = {};
  for (const t of data.tools) byTool[t.name] = { seats: 0, unused: 0, 'unused $/mo': 0 };
  const byTeam = {};
  for (const t of data.teams) byTeam[t.name] = { headcount: t.headcount, seats: 0, unused: 0 };

  for (const s of data.seats) {
    const toolName = data.tools.find((t) => t.id === s.tool).name;
    byTool[toolName].seats++;
    byTeam[s.team].seats++;
    if (isUnused(s)) {
      byTool[toolName].unused++;
      byTool[toolName]['unused $/mo'] += price[s.tool];
      byTeam[s.team].unused++;
    }
  }

  const unused = data.seats.filter(isUnused);
  const spend = data.seats.reduce((sum, s) => sum + price[s.tool], 0);
  const waste = unused.reduce((sum, s) => sum + price[s.tool], 0);

  console.log(`\n${data.meta.company} sample data, as of ${data.meta.asOf}`);
  console.log(`Paid seats: ${data.seats.length}   Monthly spend: $${spend}`);
  console.log(`Unused 30+ days: ${unused.length} seats ($${waste}/month)\n`);
  console.table(byTool);
  console.table(byTeam);
}

const data = generate();
const outFile = path.join(__dirname, '..', 'data', 'sample-usage.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + '\n');
console.log(`Wrote ${path.relative(process.cwd(), outFile)}`);
printSummary(data);
