'use strict';

// ---------------------------------------------------------------------------
// Utilities (stand-alone — does not load app.js)
// ---------------------------------------------------------------------------

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d + days).toISOString().slice(0, 10);
}

function nerdColor(score) {
  const s = Math.max(0, Math.min(10, score));
  let r, g, b;
  if (s <= 5) {
    const t = s / 5;
    r = Math.round(224 + (232 - 224) * t);
    g = Math.round(82  + (184 - 82)  * t);
    b = Math.round(82  + (75  - 82)  * t);
  } else {
    const t = (s - 5) / 5;
    r = Math.round(232 + (76  - 232) * t);
    g = Math.round(184 + (175 - 184) * t);
    b = Math.round(75  + (116 - 75)  * t);
  }
  return `rgb(${r},${g},${b})`;
}

function formatShortDate(iso) {
  const today    = todayISO();
  const tomorrow = shiftDate(today, 1);
  if (iso === today)    return 'Today';
  if (iso === tomorrow) return 'Tomorrow';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Cell coloring from directional z-score (positive = good)
// ---------------------------------------------------------------------------

function zStyle(z) {
  if (z == null) return '';
  const c = Math.max(-2.5, Math.min(2.5, z));
  if (c >  0.35) return `color:rgba(76,175,116,${(0.55 + Math.min(c, 2) * 0.2).toFixed(2)})`;
  if (c < -0.35) return `color:rgba(224,82,82,${(0.55 + Math.min(Math.abs(c), 2) * 0.2).toFixed(2)})`;
  return '';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let allRows    = [];
let sortKey    = 'pnerd';
let sortAsc    = false;
let filterMode = 'all'; // 'all' | 'upcoming'

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function setStatus(msg) {
  document.getElementById('loading-wrap').textContent = msg;
}

function showError(msg) {
  document.getElementById('loading-wrap').classList.add('hidden');
  document.getElementById('error-msg').textContent = msg;
  document.getElementById('error-wrap').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Main data pipeline
// ---------------------------------------------------------------------------

async function loadPitchers() {
  const today  = todayISO();
  const season = parseInt(today.slice(0, 4));

  try {
    setStatus('Loading pitcher stats…');

    // Fetch season data + next 5 days of schedules concurrently
    // Use yesterday as the stat cutoff so today's games don't affect scores.
    const endDate   = shiftDate(today, -1);
    const nextDates = [0,1,2,3,4,5,6,7,8,9,10,11,12,13].map(d => shiftDate(today, d));
    const [seasonStats, saberStats, standings, ...upcomingSchedules] = await Promise.all([
      getPitcherSeasonStats(season, endDate),
      getPitcherSabermetrics(season, endDate),
      getStandings(season, endDate),
      ...nextDates.map(d => getSchedule(d)),
    ]);

    // Determine how far into the season we are
    const gpVals = Object.values(standings).map(s => s.gamesPlayed).filter(g => g > 0);
    const avgGp  = gpVals.length ? gpVals.reduce((a, b) => a + b, 0) / gpVals.length : 1;
    const minIp  = Math.max(3, avgGp);

    // Collect upcoming probable starters and their next start date
    const upcomingStarts = {}; // { pid: isoDate } — earliest date wins
    for (let i = 0; i < nextDates.length; i++) {
      for (const g of upcomingSchedules[i]) {
        if (g.homePitcherId && !upcomingStarts[g.homePitcherId])
          upcomingStarts[g.homePitcherId] = nextDates[i];
        if (g.awayPitcherId && !upcomingStarts[g.awayPitcherId])
          upcomingStarts[g.awayPitcherId] = nextDates[i];
      }
    }

    // Use prior year stats for all March/April games (small sample size)
    const todayMonth = parseInt(today.slice(5, 7));
    const isEarlySeason = todayMonth <= 4;
    let effectiveSeasonStats = seasonStats;
    let effectiveSaberStats  = saberStats;
    if (isEarlySeason) {
      setStatus('Fetching prior season stats (March/April)…');
      const [priorSeason, priorSaber] = await Promise.all([
        getPitcherSeasonStats(season - 1),
        getPitcherSabermetrics(season - 1),
      ]);
      effectiveSeasonStats = priorSeason;
      effectiveSaberStats  = priorSaber;
    }

    // Build the union of pitcher IDs to display:
    //   • anyone who has started at least one game this season
    //   • anyone who is a probable starter in the next 5 days
    const starterIds  = Object.entries(effectiveSeasonStats)
      .filter(([, s]) => (s.gamesStarted || 0) >= 1)
      .map(([pid]) => Number(pid));
    const upcomingIds = Object.keys(upcomingStarts).map(Number);
    const allPitcherIds = [...new Set([...starterIds, ...upcomingIds])];

    setStatus(`Fetching pitch data for ${allPitcherIds.length} pitchers… (cached after first load)`);

    // During March/April use prior year pitch data; otherwise use current year.
    const pitchSeason = isEarlySeason ? season - 1 : season;
    const pitchDataMap = await getPitcherPitchDataParallel(allPitcherIds, pitchSeason, today);

    setStatus('Computing scores…');
    const { pnerds, flags, components } = computeAllPnerds(
      effectiveSeasonStats, effectiveSaberStats, pitchDataMap, minIp
    );

    // Build player name map: prior-year stats first, then current-year stats
    // (for team accuracy), then upcoming schedule (most authoritative for current team)
    const playerNames = {}; // { pid: { name, teamAbbr, teamId } }
    for (const [pid, s] of Object.entries(effectiveSeasonStats)) {
      if (s.name) playerNames[pid] = { name: s.name, teamAbbr: s.teamAbbr || '—', teamId: s.teamId || null };
    }
    // Override team with current-year data — covers players who changed teams since last year
    for (const [pid, s] of Object.entries(seasonStats)) {
      if (s.teamAbbr) {
        if (playerNames[pid]) {
          playerNames[pid].teamAbbr = s.teamAbbr;
          if (s.teamId) playerNames[pid].teamId = s.teamId;
        } else if (s.name) {
          playerNames[pid] = { name: s.name, teamAbbr: s.teamAbbr, teamId: s.teamId || null };
        }
      }
    }
    for (const schedule of upcomingSchedules) {
      for (const g of schedule) {
        if (g.homePitcherId && g.homePitcherName !== 'TBD' && g.homeTeamAbbr)
          playerNames[g.homePitcherId] = { name: g.homePitcherName, teamAbbr: g.homeTeamAbbr, teamId: g.homeTeamId || null };
        if (g.awayPitcherId && g.awayPitcherName !== 'TBD' && g.awayTeamAbbr)
          playerNames[g.awayPitcherId] = { name: g.awayPitcherName, teamAbbr: g.awayTeamAbbr, teamId: g.awayTeamId || null };
      }
    }

    // Assemble display rows
    allRows = allPitcherIds
      .filter(pid => playerNames[pid]) // skip pitchers with no name to display
      .map(pid => {
        const comp = components[pid];  // null for below-threshold pitchers
        const s    = effectiveSeasonStats[pid] || {};
        const pn   = playerNames[pid];
        return {
          pid,
          name:        pn.name,
          teamAbbr:    pn.teamAbbr,
          teamId:      pn.teamId,
          gs:          s.gamesStarted || 0,
          ip:          comp?.ip     ?? s.ip ?? 0,
          xfip:        comp?.xfip   ?? null,
          usedFip:     comp?.usedFip ?? false,
          kPct:        comp?.kPct   ?? s.kPct  ?? null,
          bbPct:       comp?.bbPct  ?? s.bbPct ?? null,
          velocity:    comp?.velocity ?? null, // already null when noPitchData
          ivb:         comp?.ivb      ?? null,
          absHb:       comp?.absHb    ?? null,
          spinEff:     comp?.spinEff  ?? null,
          noPitchData: comp?.noPitchData ?? true,
          pnerd:       pnerds[pid] ?? 5.0,
          flagList:    flags[pid] || [],
          upcoming:    upcomingStarts[pid] || null,
          // Directional z-scores (positive = good) — for cell coloring
          zXfip:  comp?.zXfip  ?? null,
          zKPct:  comp?.zKPct  ?? null,
          zBbPct: comp?.zBbPct ?? null,
          zVel:     comp?.zVel     ?? null,
          zIvb:     comp?.zIvb     ?? null,
          zAbsHb:   comp?.zAbsHb   ?? null,
          zSpinEff: comp?.zSpinEff ?? null,
        };
      });

    renderTable();

    const updatedTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    document.getElementById('updated-at').textContent = `Updated ${updatedTime}`;
    document.getElementById('loading-wrap').classList.add('hidden');
    document.getElementById('table-wrap').classList.remove('hidden');
    document.getElementById('table-legend').classList.remove('hidden');

  } catch (err) {
    showError(`Failed to load: ${err.message}`);
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Render / sort
// ---------------------------------------------------------------------------

const SORT_FNS = {
  name:     r => r.name,
  team:     r => r.teamAbbr,
  gs:       r => r.gs,
  ip:       r => r.ip,
  xfip:     r => r.xfip,
  kpct:     r => r.kPct,
  bbpct:    r => r.bbPct,
  velocity: r => r.velocity,
  ivb:      r => r.ivb,
  abhb:     r => r.absHb,
  spineff:  r => r.spinEff,
  pnerd:    r => r.pnerd,
};

function renderTable() {
  let rows = [...allRows];

  if (filterMode === 'upcoming') rows = rows.filter(r => r.upcoming);

  const fn = SORT_FNS[sortKey] || (r => r.pnerd);
  rows.sort((a, b) => {
    let av = fn(a), bv = fn(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;   // nulls always sink
    if (bv == null) return -1;
    if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortAsc ? av - bv : bv - av;
  });

  document.getElementById('row-count').textContent =
    `${rows.length} pitcher${rows.length !== 1 ? 's' : ''}`;

  document.getElementById('pitcher-tbody').innerHTML = rows.map(rowHtml).join('');

  document.querySelectorAll('.pitchers-table th[data-col]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === sortKey) th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
  });
}

function rowHtml(r) {
  const color = nerdColor(r.pnerd);
  const na    = '<span class="na">—</span>';

  const xfipStr = r.xfip != null
    ? `<span style="${zStyle(r.zXfip)}">${r.xfip.toFixed(2)}${r.usedFip ? '<sup title="FIP used">*</sup>' : ''}</span>`
    : na;

  const kStr = r.kPct != null
    ? `<span style="${zStyle(r.zKPct)}">${(r.kPct * 100).toFixed(1)}%</span>`
    : na;

  const bbStr = r.bbPct != null
    ? `<span style="${zStyle(r.zBbPct)}">${(r.bbPct * 100).toFixed(1)}%</span>`
    : na;

  const veloStr = r.velocity != null
    ? `<span style="${zStyle(r.zVel)}">${r.velocity.toFixed(1)}</span>`
    : na;

  const ivbStr = r.ivb != null
    ? `<span style="${zStyle(r.zIvb)}">${r.ivb.toFixed(1)}</span>`
    : na;

  const abhbStr = r.absHb != null
    ? `<span style="${zStyle(r.zAbsHb)}">${r.absHb.toFixed(1)}</span>`
    : na;

  const spinEffStr = r.spinEff != null
    ? `<span style="${zStyle(r.zSpinEff)}">${r.spinEff.toFixed(1)}</span>`
    : na;

  const upcomingBadge = r.upcoming
    ? `<span class="upcoming-badge">${formatShortDate(r.upcoming)}</span>`
    : '';

  const upcomingDot = r.upcoming
    ? ' <span class="upcoming-dot" title="Starting in the next 5 days"></span>'
    : '';

  const headshotUrl = `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_67,q_auto:best/v1/people/${r.pid}/headshot/67/current`;

  const playerUrl = mlbPlayerUrl(r.name, r.pid);
  const teamUrl   = mlbTeamUrl(r.teamId);
  const teamCell  = teamUrl
    ? `<a href="${teamUrl}" target="_blank" rel="noopener">${r.teamAbbr}</a>`
    : r.teamAbbr;

  return `
    <tr>
      <td class="col-headshot"><a href="${playerUrl}" target="_blank" rel="noopener"><img class="headshot-img" src="${headshotUrl}" alt="${r.name}" loading="lazy"></a></td>
      <td class="col-name"><a href="${playerUrl}" target="_blank" rel="noopener">${r.name}</a>${upcomingDot}</td>
      <td class="col-team">${teamCell}</td>
      <td class="num col-gs">${r.gs}</td>
      <td class="num col-ip">${r.ip.toFixed(1)}</td>
      <td class="num">${xfipStr}</td>
      <td class="num">${kStr}</td>
      <td class="num">${bbStr}</td>
      <td class="num col-velo">${veloStr}</td>
      <td class="num col-ivb">${ivbStr}</td>
      <td class="num col-abhb">${abhbStr}</td>
      <td class="num col-spineff">${spinEffStr}</td>
      <td class="num pnerd-cell"><span style="color:${color};font-weight:700">${r.pnerd.toFixed(1)}</span></td>
      <td>${upcomingBadge}</td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

document.querySelectorAll('.filter-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    filterMode = btn.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (allRows.length) renderTable();
  });
});

document.querySelector('.pitchers-table').addEventListener('click', e => {
  const th = e.target.closest('th[data-col]');
  if (!th || !th.classList.contains('sortable')) return;
  const col = th.dataset.col;
  if (sortKey === col) {
    sortAsc = !sortAsc;
  } else {
    sortKey = col;
    // Numeric columns default descending; name/team default ascending
    sortAsc = (col === 'name' || col === 'team');
  }
  renderTable();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadPitchers();
