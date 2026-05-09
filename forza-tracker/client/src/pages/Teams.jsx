import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';

const DEFAULT_TEAMS = [
  { name: 'Team Apex', color: '#5b8def', member_ids: [] },
  { name: 'Team Banzai', color: '#e26d5c', member_ids: [] },
];

export default function Teams() {
  const [users, setUsers] = useState([]);
  const [seasons, setSeasons] = useState([]);
  const [seasonId, setSeasonId] = useState(null);
  const [teams, setTeams] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    Promise.all([api.users(), api.seasons()]).then(([u, s]) => {
      setUsers(u);
      setSeasons(s);
      const active = s.find(x => x.status === 'active') || s[0];
      if (active) setSeasonId(active.id);
    });
  }, []);

  useEffect(() => {
    if (!seasonId) return;
    api.teams(seasonId).then(t => {
      if (t.length === 0) {
        setTeams(DEFAULT_TEAMS.map(td => ({ ...td })));
      } else {
        setTeams(t.map(team => ({
          id: team.id,
          name: team.name,
          color: team.color,
          member_ids: team.members.map(m => m.id),
        })));
      }
    });
  }, [seasonId]);

  const assigned = useMemo(() => new Set(teams.flatMap(t => t.member_ids)), [teams]);
  const unassigned = users.filter(u => !assigned.has(u.id));

  const updateTeam = (idx, patch) => setTeams(ts => ts.map((t, i) => i === idx ? { ...t, ...patch } : t));

  const toggleMember = (teamIdx, userId) => {
    setTeams(ts => ts.map((t, i) => {
      if (i !== teamIdx) return { ...t, member_ids: t.member_ids.filter(id => id !== userId) };
      return t.member_ids.includes(userId)
        ? { ...t, member_ids: t.member_ids.filter(id => id !== userId) }
        : { ...t, member_ids: [...t.member_ids, userId] };
    }));
  };

  const save = async () => {
    setError(null);
    if (teams.length !== 2) return setError('Need exactly 2 teams.');
    if (!teams.every(t => t.member_ids.length === 2)) return setError('Each team needs exactly 2 drivers.');
    if (assigned.size !== users.length) return setError('Every driver must be on a team.');
    setBusy(true);
    try {
      const payload = teams.map(t => ({ name: t.name, color: t.color, member_ids: t.member_ids }));
      await api.saveTeams(seasonId, payload);
      setSavedAt(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row spread">
        <div>
          <h1>Teams</h1>
          <p className="subtitle">2 teams of 2. Each driver belongs to exactly one team for the season.</p>
        </div>
        <select value={seasonId || ''} onChange={e => setSeasonId(Number(e.target.value))}>
          {seasons.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {unassigned.length > 0 && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong style={{ color: 'var(--text)' }}>Unassigned:</strong>{' '}
          {unassigned.map(u => (
            <span key={u.id} className="driver" style={{ marginRight: 10 }}>
              <span className="dot" style={{ background: u.color }} />{u.display_name}
            </span>
          ))}
        </div>
      )}

      <div className="grid two">
        {teams.map((team, idx) => (
          <div key={idx} className="panel" style={{ borderTop: `3px solid ${team.color}` }}>
            <div className="row" style={{ marginBottom: 12, gap: 8 }}>
              <input
                type="color"
                value={team.color}
                onChange={e => updateTeam(idx, { color: e.target.value })}
                style={{ width: 40, height: 38, padding: 0, background: 'transparent', border: 'none' }}
              />
              <input
                value={team.name}
                onChange={e => updateTeam(idx, { name: e.target.value })}
                style={{ flex: 1, fontSize: 16, fontWeight: 600 }}
              />
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {users.map(u => {
                const onThisTeam = team.member_ids.includes(u.id);
                const onOtherTeam = !onThisTeam && assigned.has(u.id);
                return (
                  <label
                    key={u.id}
                    className="row"
                    style={{
                      gap: 10,
                      padding: '8px 10px',
                      background: onThisTeam ? 'var(--panel-2)' : 'transparent',
                      border: '1px solid',
                      borderColor: onThisTeam ? team.color : 'var(--border)',
                      borderRadius: 8,
                      opacity: onOtherTeam ? 0.4 : 1,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={onThisTeam}
                      disabled={onOtherTeam || (!onThisTeam && team.member_ids.length >= 2)}
                      onChange={() => toggleMember(idx, u.id)}
                    />
                    <span className="dot" style={{ background: u.color }} />
                    <div style={{ flex: 1 }}>
                      <div>{u.display_name}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{u.gamertag}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {error && <div className="panel" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>{error}</div>}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        {savedAt && <span style={{ color: 'var(--muted)', fontSize: 12 }}>Saved at {savedAt.toLocaleTimeString()}</span>}
        <button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save teams'}</button>
      </div>
    </>
  );
}
