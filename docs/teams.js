'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let allRows = [];
let sortKey = 'tnerd';
let sortAsc = false;

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

async function loadTeams() {
  const today   = todayISO();
  const season  = parseInt(today.slice(0, 4));
  const endDate = shiftDate(today, -1);

  // Use prior year stats for all March/April games (small sample size)
  const todayMonth    = parseInt(today.slice(5, 7));
  const isEarlySeason = todayMonth <= 4;
  const statsYear     = isEarlySeason ? season - 1 : season;

  try {
    setStatus('Loading team stats…');

    const [standings, hittingSaber, hittingPA, pitcherStats] = await Promise.all([
      getStandings(statsYear, isEarlySeason ? null : endDate),
      getHittingSabermetrics(statsYear, isEarlySeason ? null : endDate),
      getHittingSeasonStats(statsYear, isEarlySeason ? null : endDate),
      getPitcherSeasonStats(statsYear, isEarlySeason ? null : endDate),
    ]);
    // Merge plate appearances and strikeouts into sabermetrics objects.
    for (const [pid, { pa, so }] of Object.entries(hittingPA)) {
      if (hittingSaber[pid]) { hittingSaber[pid].pa = pa; hittingSaber[pid].so = so; }
    }

    // Compute bullpen ERA per team: relievers = pitchers where starts < half of appearances.
    const bpAcc = {}; // { teamId: { er, ip } }
    for (const s of Object.values(pitcherStats)) {
      const { teamId, era, ip, gamesStarted, gamesPlayed } = s;
      if (!teamId || era == null || ip < 1) continue;
      // Reliever: fewer than half of appearances are starts. Fall back to gamesStarted === 0
      // if gamesPlayed is missing (e.g. stale cache before gamesPlayed was added).
      const isReliever = gamesPlayed > 0 ? gamesStarted / gamesPlayed < 0.5 : gamesStarted === 0;
      if (!isReliever) continue;
      if (!bpAcc[teamId]) bpAcc[teamId] = { er: 0, ip: 0 };
      bpAcc[teamId].er += era * ip / 9;
      bpAcc[teamId].ip += ip;
    }
    const bullpenEra = {};
    for (const [tid, { er, ip }] of Object.entries(bpAcc)) {
      if (ip > 0) bullpenEra[tid] = (er / ip) * 9;
    }

    setStatus('Computing scores…');
    const { tnerds, components } = computeAllTnerds(standings, hittingSaber, bullpenEra);

    // Build rows — one per team in standings
    allRows = Object.entries(standings)
      .filter(([, st]) => st.name) // skip any entry without a team name
      .map(([tid, st]) => {
        const tidN = Number(tid);
        const comp = components[tidN] ?? components[tid] ?? null;
        return {
          tid:    tidN,
          name:   st.name,

          w:      st.wins,
          l:      st.losses,
          gp:     st.gamesPlayed,
          wrc:    comp?.wrcPlus         ?? null,
          pera:   comp?.proxyEra        ?? null,
          bpEra:  comp?.bullpenEra      ?? null,
          luck:   comp?.luck            ?? null,
          rd:     comp?.signedRdPerGame ?? null,
          kPct:   comp?.kPct            ?? null,
          tnerd:  tnerds[tidN] ?? tnerds[tid] ?? 5.0,
          zWrc:   comp?.zWrc   ?? null,
          zEra:   comp?.zEra   ?? null,
          zBpEra: comp?.zBpEra ?? null,
          zLuck:  comp?.zLuck  ?? null,
          zRd:    comp?.zRd    ?? null,
          zKPct:  comp?.zKPct  ?? null,
          noData: comp == null,
        };
      });

    renderTable();

    const updatedTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    document.getElementById('updated-at').textContent = `Updated ${updatedTime}`;
    document.getElementById('row-count').textContent  = allRows.length;
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
  name:  r => r.name,
  w:     r => r.w,
  l:     r => r.l,
  wrc:   r => r.wrc,
  pera:  r => r.pera,
  bpera: r => r.bpEra,
  luck:  r => r.luck,
  rd:    r => r.rd,
  kpct:  r => r.kPct,
  tnerd: r => r.tnerd,
};

function renderTable() {
  const rows = [...allRows];

  const fn = SORT_FNS[sortKey] || (r => r.tnerd);
  rows.sort((a, b) => {
    let av = fn(a), bv = fn(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortAsc ? av - bv : bv - av;
  });

  document.getElementById('team-tbody').innerHTML = rows.map(rowHtml).join('');

  document.querySelectorAll('.teams-table th[data-col]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === sortKey) th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
  });
}

function rowHtml(r) {
  const color = nerdColor(r.tnerd);
  const na    = '<span class="na">—</span>';

  const fmtDec = (v, p = 2) => v != null ? v.toFixed(p) : na;

  // Luck: show as signed percentage points (e.g. +3.1% or -2.4%)
  const luckStr = r.luck != null
    ? `<span style="${zStyle(r.zLuck)}">${r.luck >= 0 ? '+' : ''}${(r.luck * 100).toFixed(1)}%</span>`
    : na;

  // RD/G: show signed, color based on zRd (which rewards near-zero abs RD)
  const rdStr = r.rd != null
    ? `<span style="${zStyle(r.zRd)}">${r.rd >= 0 ? '+' : ''}${r.rd.toFixed(2)}</span>`
    : na;

  const wrcStr = r.wrc != null
    ? `<span style="${zStyle(r.zWrc)}">${Math.round(r.wrc)}</span>`
    : na;

  const peraStr = r.pera != null
    ? `<span style="${zStyle(r.zEra)}">${r.pera.toFixed(2)}</span>`
    : na;

  const bpEraStr = r.bpEra != null
    ? `<span style="${zStyle(r.zBpEra)}">${r.bpEra.toFixed(2)}</span>`
    : na;

  const kPctStr = r.kPct != null
    ? `<span style="${zStyle(r.zKPct)}">${(r.kPct * 100).toFixed(1)}%</span>`
    : na;

  const insufficientNote = r.noData
    ? ' <span style="color:var(--text-muted);font-size:0.75em">(insufficient data)</span>'
    : '';

  const teamUrl  = mlbTeamUrl(r.tid);
  const nameLink = teamUrl
    ? `<a href="${teamUrl}" target="_blank" rel="noopener">${r.name}</a>`
    : r.name;
  const logoUrl  = mlbTeamLogoUrl(r.tid);
  const logoCell = logoUrl
    ? `<img class="team-logo-img" src="${logoUrl}" alt="${r.abbr}" loading="lazy" onerror="this.style.display='none'">`
    : '';

  return `
    <tr>
      <td class="col-team-logo">${logoCell}</td>
      <td class="col-team-name">${nameLink}${insufficientNote}</td>

      <td class="num record-cell">${r.w}</td>
      <td class="num record-cell">${r.l}</td>
      <td class="num">${wrcStr}</td>
      <td class="num col-proxy-era">${peraStr}</td>
      <td class="num col-bp-era">${bpEraStr}</td>
      <td class="num">${luckStr}</td>
      <td class="num col-kpct">${kPctStr}</td>
      <td class="num col-rd">${rdStr}</td>
      <td class="num tnerd-cell"><span style="color:${color};font-weight:700">${r.tnerd.toFixed(1)}</span></td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// Sort controls
// ---------------------------------------------------------------------------

document.querySelector('.teams-table').addEventListener('click', e => {
  const th = e.target.closest('th[data-col]');
  if (!th || !th.classList.contains('sortable')) return;
  const col = th.dataset.col;
  if (sortKey === col) {
    sortAsc = !sortAsc;
  } else {
    sortKey = col;
    sortAsc = (col === 'name' || col === 'abbr');
  }
  renderTable();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadTeams();
