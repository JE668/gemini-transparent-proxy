'use client';
import React, { useEffect, useState, useCallback, useMemo } from 'react';

// ---- 样式常量 (定义在最顶层，防止 ReferenceError) ----
const pageStyle = { backgroundColor: '#f1f5f9', minHeight: '100vh', padding: '40px 20px', fontFamily: 'Inter, system-ui, sans-serif', color: '#1e293b' };
const statusBarStyle = { display: 'flex', alignItems: 'center', padding: '15px 25px', borderRadius: '16px', backgroundColor: 'white', boxShadow: '0 2px 10px rgba(0,0,0,0.05)', flexWrap: 'wrap' };
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' };
const cardStyle = { padding: '20px', borderRadius: '16px', transition: 'transform 0.2s' };

// ---- 常量与工具函数 ----
const REFRESH_INTERVAL = 30000;
const HTTP_STATUS_DESC = {
  400: '请求格式错误', 401: '认证失败/密钥无效', 403: '权限不足/访问被拒',
  404: '资源不存在', 408: '请求超时', 429: '请求过于频繁(限流)',
  500: '服务器内部错误', 502: '网关错误(上游异常)', 503: '服务暂不可用', 504: '网关超时(上游无响应)',
};
const MODEL_COLORS = {
  'gemma-4-31b-it': '#6366f1', 'gemma-4-26b-a4b-it': '#8b5cf6',
  'gemini-1.5-pro': '#ec4899', 'gemini-1.5-flash': '#10b981', 'default': '#6366f1'
};

const getStatusDesc = (code) => HTTP_STATUS_DESC[code] || '';
const getModelColor = (modelId) => MODEL_COLORS[modelId] || MODEL_COLORS.default;
const formatTime = (iso) => {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return iso; }
};
const getTimeUntilReset = () => {
  const now = new Date();
  const reset = new Date(now);
  reset.setUTCHours(7, 0, 0, 0);
  if (now >= reset) reset.setUTCDate(reset.getUTCDate() + 1);
  const diffMs = reset - now;
  const totalSeconds = Math.floor(diffMs / 1000);
  return { hours: Math.floor(totalSeconds / 3600), minutes: Math.floor((totalSeconds % 3600) / 60), seconds: totalSeconds % 60 };
};
const formatCountdown = (cd) => `${String(cd.hours).padStart(2, '0')}:${String(cd.minutes).padStart(2, '0')}:${String(cd.seconds).padStart(2, '0')}`;

// ---- 主题引擎 ----
const getTheme = (darkMode) => ({
  page: { backgroundColor: darkMode ? '#0f172a' : '#f1f5f9', color: darkMode ? '#f1f5f9' : '#1e293b' },
  card: { backgroundColor: darkMode ? '#1e293b' : 'white', border: darkMode ? '1px solid #334155' : '1px solid #e2e8f0', boxShadow: darkMode ? '0 4px 6px -1px rgba(0,0,0,0.3)' : '0 1px 3px rgba(0,0,0,0.06)' },
  text: { main: darkMode ? '#f8fafc' : '#0f172a', sub: darkMode ? '#94a3b8' : '#64748b', muted: darkMode ? '#64748b' : '#94a3b8' },
  bgAlt: { backgroundColor: darkMode ? '#0f172a' : '#f8fafc', border: darkMode ? '1px solid #334155' : '1px solid #f1f5f9', color: darkMode ? '#cbd5e1' : '#475569' },
  statusBar: { backgroundColor: darkMode ? '#1e293b' : 'white', border: darkMode ? '1px solid #334155' : '1px solid #e2e8f0' }
});

// ---- 子组件 ----
function StatusDot({ ok }) {
  return <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: ok ? '#22c55e' : '#ef4444', boxShadow: ok ? '0 0 8px rgba(34,197,94,0.5)' : '0 0 8px rgba(239,68,68,0.5)' }} />;
}

function StatusEmoji({ emoji, label, value, valueColor, mono }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '4px 20px' }}>
      <span style={{ fontSize: '20px' }}>{emoji}</span>
      <div>
        <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: '500' }}>{label}</div>
        <div style={{ fontSize: '18px', fontWeight: '700', color: valueColor || '#0f172a', fontFamily: mono ? 'monospace' : undefined }}>{value}</div>
      </div>
    </div>
  );
}

function Tag({ label, value, color }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 10px', borderRadius: '6px', fontSize: '12px', fontFamily: 'monospace', backgroundColor: `${color}11`, color, border: `1px solid ${color}33` }}>
      <span style={{ opacity: 0.7 }}>{label}</span><span style={{ fontWeight: '600' }}>{value}</span>
    </span>
  );
}

function HorizontalBar({ label, value, max, color }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '13px' }}>
        <span style={{ fontFamily: 'monospace', fontWeight: '600', color: '#1e293b' }}>{label}</span>
        <span style={{ fontFamily: 'monospace', color: '#64748b' }}>{value.toLocaleString()}</span>
      </div>
      <div style={{ backgroundColor: '#f1f5f9', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, borderRadius: '4px', background: color, transition: 'width 0.5s ease' }} />
      </div>
    </div>
  );
}

function SparklineChart({ data, width = 700, height = 160, theme }) {
  if (!data || data.length === 0) return null;
  const maxVal = Math.max(...data.map(d => d.count), 1);
  const padX = 40, padY = 20;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;
  const stepX = chartW / (data.length - 1);
  const points = data.map((d, i) => ({ x: padX + i * stepX, y: padY + chartH - (d.count / maxVal) * chartH, ...d }));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x},${padY + chartH} L${points[0].x},${padY + chartH} Z`;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <path d={areaPath} fill="#6366f1" opacity="0.1" />
      <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="2" />
      {points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="3" fill="#6366f1" />)}
    </svg>
  );
}

function ModelCard({ item, isSelected, theme }) {
  const color = getModelColor(item.model);
  const pct = Math.min(item.percent, 100);
  return (
    <div style={{ ...theme.card, ...cardStyle, border: isSelected ? `2px solid ${color}` : theme.card.border }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
        <h3 style={{ margin: 0, fontSize: '14px', color: theme.text.main }}>{item.model}</h3>
        <span style={{ fontWeight: 'bold', color: color }}>{pct.toFixed(1)}%</span>
      </div>
      <div style={{ backgroundColor: '#f1f5f9', height: '6px', borderRadius: '3px' }}>
        <div style={{ height: '100%', width: `${pct}%`, backgroundColor: color, borderRadius: '3px' }} />
      </div>
      <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
        <Tag label="使用" value={`${item.used}`} color={color} />
      </div>
    </div>
  );
}

function EmptyState({ emoji, text }) {
  return <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>{emoji} <p>{text}</p></div>;
}

// ---- 主组件 ----
export default function DashboardPage() {
  const [darkMode, setDarkMode] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [quota, setQuota] = useState(null);
  const [health, setHealth] = useState(null);
  const [errors, setErrors] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [clients, setClients] = useState(null);
  const [recent, setRecent] = useState(null);
  const [selectedModel, setSelectedModel] = useState(null);
  const [showStatusTable, setShowStatusTable] = useState(false);
  const [authError, setAuthError] = useState('');

  const theme = useMemo(() => getTheme(darkMode), [darkMode]);

  useEffect(() => {
    const saved = localStorage.getItem('dashboard_token');
    if (saved) { setPassword(saved); setAuthed(true); }
  }, []);

  const handleLogin = async (e) => {
    e?.preventDefault();
    try {
      const res = await fetch('/api/quota', { headers: { 'Authorization': `Bearer ${password}` } });
      if (res.ok) { localStorage.setItem('dashboard_token', password); setAuthed(true); }
      else { setAuthError('密码错误'); }
    } catch { setAuthError('连接失败'); }
  };

  const authFetch = useCallback(async (url) => {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${password}` } });
    if (res.status === 401) { localStorage.removeItem('dashboard_token'); setAuthed(false); return null; }
    return res;
  }, [password]);

  const fetchData = useCallback(async () => {
    if (!authed) return;
    try {
      const [q, h, e, t, c, r] = await Promise.all([
        authFetch('/api/quota').then(res => res?.json()),
        authFetch('/api/health').then(res => res?.json()).catch(() => null),
        authFetch('/api/errors').then(res => res?.json()).catch(() => null),
        authFetch('/api/timeline').then(res => res?.json()).catch(() => null),
        authFetch('/api/clients').then(res => res?.json()).catch(() => null),
        authFetch('/api/recent').then(res => res?.json()).catch(() => null),
      ]);
      if (!q && !h && !e && !t && !c && !r) return;
      setQuota(q); setHealth(h); setErrors(e); setTimeline(t); setClients(c); setRecent(r);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, [authed, authFetch]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchData]);

  const modelDistribution = useMemo(() => {
    if (!quota?.data) return [];
    const max = Math.max(...quota.data.map(d => d.used), 1);
    return quota.data.map((d, i) => ({ label: d.model, value: d.used, max, color: ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd'][i % 4] }));
  }, [quota]);

  const filteredRecent = useMemo(() => {
    if (!selectedModel || !recent?.recent) return recent?.recent || [];
    return recent.recent.filter(r => r.model === selectedModel);
  }, [selectedModel, recent]);

  if (!authed) {
    return (
      <div style={{ ...pageStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <form onSubmit={handleLogin} style={{ background: 'white', padding: '40px', borderRadius: '16px', boxShadow: '0 10px 25px rgba(0,0,0,0.1)', width: '100%', maxWidth: '400px' }}>
          <h2 style={{ textAlign: 'center', marginBottom: '24px' }}>Dashboard Login</h2>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" style={{ width: '100%', padding: '12px', marginBottom: '16px', borderRadius: '8px', border: '1px solid #ddd' }} />
          {authError && <p style={{ color: 'red', fontSize: '14px' }}>{authError}</p>}
          <button type="submit" style={{ width: '100%', padding: '12px', backgroundColor: '#6366f1', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>Login</button>
        </form>
      </div>
    );
  }

  if (loading) return <div style={{ ...pageStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>;

  return (
    <div style={{ ...pageStyle, ...theme.page }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <header style={headerStyle}>
          <h1 style={{ color: theme.text.main, margin: 0 }}>Gemini Dashboard</h1>
          <button onClick={() => setDarkMode(!darkMode)} style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid #ddd', cursor: 'pointer' }}>{darkMode ? '☀️' : '🌙'}</button>
        </header>
        <div style={{ ...statusBarStyle, ...theme.statusBar, marginBottom: '32px' }}>
          <StatusDot ok={health?.status === 'ok'} />
          <div style={{ width: '1px', height: '30px', background: '#eee', margin: '0 15px' }} />
          <StatusEmoji emoji="🚀" label="Total" value={(quota?.globalRequests || 0).toLocaleString()} />
          <StatusEmoji emoji="⏳" label="Latency" value={health?.avgLatency ? `${health.avgLatency}ms` : 'N/A'} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
          {modelDistribution.map((d, i) => (
            <div key={i} onClick={() => setSelectedModel(selectedModel === d.label ? null : d.label)} style={{ cursor: 'pointer' }}>
              <ModelCard item={{...d, model: d.label, limit: d.max, used: d.value, percent: (d.value/d.max)*100}} isSelected={selectedModel === d.label} theme={theme} />
            </div>
          ))}
        </div>
        <div style={{ marginTop: '32px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          <div style={{ ...theme.card, padding: '20px', borderRadius: '16px' }}>
            <h2 style={{ fontSize: '18px', marginBottom: '16px' }}>Timeline</h2>
            <SparklineChart data={timeline?.timeline || []} theme={theme} />
          </div>
          <div style={{ ...theme.card, padding: '20px', borderRadius: '16px' }}>
            <h2 style={{ fontSize: '18px', marginBottom: '16px' }}>Recent Requests</h2>
            <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {filteredRecent.map((r, i) => (
                <div key={i} style={{ fontSize: '13px', padding: '8px 0', borderBottom: `1px solid ${theme.card.border}` }}>
                  {formatTime(r.ts)} - {r.model} - {r.status}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
