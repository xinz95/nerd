'use strict';

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
  const month  = parseInt(today.slice(5, 7));
  const statsYear = month <= 4 ? season - 1 : season;

  try {
    setStatus('Loading pitcher stats…');

    // Fetch pNERD scores (shared with game cards page) and 14-day schedule
    // in parallel. The schedule is used for next-start indicators and current
    // team overrides for traded/signed players.
    const nextDates = Array.from({ length: 5 }, (_, i) => shiftDate(today, i));

    const [{ pnerds, flags, components, seasonStats, saberStats }, ...upcomingSchedules] =
      await Promise.all([
        loadAllPnerds(statsYear),
        ...nextDates.map(d => getSchedule(d)),
      ]);

    // Collect upcoming probable starters (next-start badge + current team override).
    const upcomingStarts = {}; // { pid: isoDate }
    const scheduleInfo   = {}; // { pid: { name, teamAbbr, teamId } }
    for (let i = 0; i < nextDates.length; i++) {
      for (const g of upcomingSchedules[i]) {
        if (g.homePitcherId && g.homePitcherName && g.homePitcherName !== 'TBD') {
          if (!upcomingStarts[g.homePitcherId]) upcomingStarts[g.homePitcherId] = nextDates[i];
          if (!scheduleInfo[g.homePitcherId])
            scheduleInfo[g.homePitcherId] = { name: g.homePitcherName, teamAbbr: g.homeTeamAbbr, teamId: g.homeTeamId };
        }
        if (g.awayPitcherId && g.awayPitcherName && g.awayPitcherName !== 'TBD') {
          if (!upcomingStarts[g.awayPitcherId]) upcomingStarts[g.awayPitcherId] = nextDates[i];
          if (!scheduleInfo[g.awayPitcherId])
            scheduleInfo[g.awayPitcherId] = { name: g.awayPitcherName, teamAbbr: g.awayTeamAbbr, teamId: g.awayTeamId };
        }
      }
    }

    // Build display rows — require at least 10 GS to filter out spot starters.
    const { minIp, minGs } = getQualifyingThreshold(statsYear);
    const allPitcherIds = Object.entries(seasonStats)
      .filter(([, s]) => (s.ip || 0) >= minIp || (s.gamesStarted || 0) >= minGs)
      .map(([pid]) => Number(pid));

    allRows = allPitcherIds
      .filter(pid => seasonStats[pid]?.name)
      .map(pid => {
        const s    = seasonStats[pid] || {};
        const saber = saberStats[pid] || {};
        const comp  = components[pid];
        // Schedule info overrides team assignment for traded/signed players.
        const info  = scheduleInfo[pid];
        const tAbbr = info?.teamAbbr || s.teamAbbr || '—';
        const tId   = info?.teamId   || s.teamId   || null;
        return {
          pid,
          name:        s.name,
          teamAbbr:    tAbbr,
          teamId:      tId,
          gs:          s.gamesStarted || 0,
          ip:          comp?.ip    ?? s.ip ?? 0,
          xfip:        comp?.xfip  ?? saber.xfip ?? saber.fip ?? null,
          usedFip:     comp?.usedFip ?? (saber.xfip == null && saber.fip != null),
          kPct:        comp?.kPct  ?? s.kPct  ?? null,
          bbPct:       comp?.bbPct ?? s.bbPct ?? null,
          velocity:    comp?.velocity  ?? null,
          whiffRate:   comp?.whiffRate ?? null,
          ivb:         comp?.ivb       ?? null,
          absHb:       comp?.absHb     ?? null,
          spinEff:     comp?.spinEff   ?? null,
          noPitchData: comp?.noPitchData ?? true,
          pnerd:       pnerds[pid] ?? 5.0,
          flagList:    flags[pid] || [],
          upcoming:    upcomingStarts[pid] || null,
          zXfip:    comp?.zXfip    ?? null,
          zKPct:    comp?.zKPct    ?? null,
          zBbPct:   comp?.zBbPct   ?? null,
          zVel:     comp?.zVel     ?? null,
          zWhiff:   comp?.zWhiff   ?? null,
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
  velocity:  r => r.velocity,
  whiffrate: r => r.whiffRate,
  ivb:       r => r.ivb,
  abhb:      r => r.absHb,
  spineff:   r => r.spinEff,
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

  const whiffStr = r.whiffRate != null
    ? `<span style="${zStyle(r.zWhiff)}">${(r.whiffRate * 100).toFixed(1)}%</span>`
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
      <td class="num col-whiff">${whiffStr}</td>
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
