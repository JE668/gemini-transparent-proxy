use client';
import React, { useEffect, useState, useCallback, useMemo } from 'react';

// =============================================================================
// 1. 样式常量 (Styles) - 必须定义在最顶层以防止 ReferenceError
// =============================================================================
const pageStyle = { fontFamily: 'Inter, system-ui, -apple-system, sans-serif', minHeight: '100vh' };
const containerStyle = { maxWidth: '1440px', margin: '0 auto', padding: '32px 20px' };
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' };
const titleStyle = { fontSize: '32px', fontWeight: '800', margin: 0, letterSpacing: '-0.025em' };
const subtitleStyle = { color: '#64748b', fontSize: '14px', marginTop: '4px' };
const refreshBtnStyle = { width: '40px', height: '40px', borderRadius: '10px', border: '1px solid #e2e8f0', backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', transition: 'all 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' };
const statusBarStyle = { display: 'flex', alignItems: 'center', padding: '16px 24px', borderRadius: '16px', marginBottom: '32px', gap: '12px', flexWrap: 'wrap' };
const dividerStyle = { width: '1px', height: '24px', backgroundColor: '#e2e8f0' };
const cardStyle = { borderRadius: '16px', padding: '24px', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)' };
const sectionHeaderStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' };
const sectionTitleStyle = { fontSize: '18px', fontWeight: '700', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' };
const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '24px', marginBottom: '32px' };
const twoColStyle = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '32px' };
const errorRowStyle = { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', borderRadius: '12px', fontSize: '13px', fontFamily: 'monospace' };
const tagStyle = { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: '600' };
const emptyStateStyle = { textAlign: 'center', padding: '40px', color: '#94a3b8' };
const footerStyle = { textAlign: 'center', padding: '40px 0', color: '#94a3b8', fontSize: '13px', borderTop: '1px solid #e2e8f0', marginTop: '40px' };

// =============================================================================
// 2. 常量与工具函数 (Constants & Utils)
// =============================================================================
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
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return iso; }
};
const getTimeUntilReset = () => {
  const now = new Date();
  const reset = new Date(now); reset.setUTCHours(7, 0, 0, 0);
  if (now >= reset) reset.setUTCDate(reset.getUTCDate() + 1);
  const diffMs = reset - now;
  const totalSeconds = Math.floor(diffMs / 1000);
  return { hours: Math.floor(totalSeconds / 3600), minutes: Math.floor((totalSeconds % 3600) / 60), seconds: totalSeconds % 60 };
};
const formatCountdown = (cd) => `${String(cd.hours).padStart(2, '0')}:${String(cd.minutes).padStart(2, '0')}:${String(cd.seconds).padStart(2, '0')}`;

const getTheme = (darkMode) => ({
  page: { backgroundColor: darkMode ? '#0f172a' : '#f8fafc', color: darkMode ? '#f1f5f9' : '#0f172a' },
  card: { backgroundColor: darkMode ? '#1e293b' : 'white', border: darkMode ? '1px solid #334155' : '1px solid #e2e8f0', boxShadow: darkMode ? '0 10px 15px -3px rgba(0,0,0,0.5)' : '0 4px 6px -1px rgba(0,0,0,0.1)' },
  text: { main: darkMode ? '#f8fafc' : '#0f172a', sub: darkMode ? '#94a3b8' : '#64748b', muted: darkMode ? '#64748b' : '#94a3b8' },
  bgAlt: { backgroundColor: darkMode ? '#0f172a' : '#f1f5f9', border: darkMode ? '1px solid #334155' : '1px solid #e2e8f0', color: darkMode ? '#cbd5e1' : '#475569' },
  statusBar: { backgroundColor: darkMode ? '#1e293b' : 'white', border: darkMode ? '1px solid #334155' : '1px solid #e2e8f0' },
  input: { backgroundColor: darkMode ? '#0f172a' : 'white', border: darkMode ? '1px solid #334155' : '#e2e8f0', color: darkMode ? 'white' : 'black' }
});

// =============================================================================
// 3. 高级组件 (Professional Components)
// =============================================================================

function StatusDot({ ok }) {
  return <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: ok ? '#22c55e' : '#ef4444', boxShadow: ok ? '0 0 8px rgba(34,197,94,0.5)' : '0 0 8px rgba(239,68,68,0.5)' }} />;
}

function StatusEmoji({ emoji, label, value, valueColor, mono }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <span style={{ fontSize: '22px' }}>{emoji}</span>
      <div>
        <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: '500' }}>{label}</div>
        <div style={{ fontSize: '18px', fontWeight: '700', color: valueColor || '#0f172a', fontFamily: mono ? 'monospace' : undefined }}>{value}</div>
      </div>
    </div>
  );
}

function Tag({ label, value, color }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: '600', backgroundColor: `${color}15`, color: color, border: `1px solid ${color}30` }}>
      <span style={{ opacity: 0.7 }}>{label}</span><span style={{ fontWeight: '700' }}>{value}</span>
    </span>
  );
}

function HorizontalBar({ label, value, max, color }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '13px' }}>
        <span style={{ fontWeight: '600', color: '#475569' }}>{label}</span>
        <span style={{ fontFamily: 'monospace', color: '#64748b' }}>{value.toLocaleString()}</span>
      </div>
      <div style={{ backgroundColor: '#f1f5f9', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, backgroundColor: color, borderRadius: '4px', transition: 'width 0.8s cubic-bezier(0.4, 0, 0.2, 1)' }} />
      </div>
    </div>
  );
}

function SparklineChart({ data, width = 700, height = 160, theme }) {
  if (!data || data.length === 0) return <EmptyState emoji="📊" text="暂无时间线数据" />;
  const maxVal = Math.max(...data.map(d => d.count), 1);
  const padX = 40, padY = 20;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;
  const stepX = chartW / (data.length - 1);
  const points = data.map((d, i) => ({ x: padX + i * stepX, y: padY + chartH - (d.count / maxVal) * chartH, ...d }));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x},${padY + chartH} L${points[0].x},${padY + chartH} Z`;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#areaGrad)" />
      <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="4" fill="#6366f1" stroke="white" strokeWidth="2" />
      ))}
    </svg>
  );
}

function ModelCard({ item, isSelected, theme }) {
  const color = getModelColor(item.model);
  const pct = Math.min(item.percent, 100);
  return (
    <div style={{ ...cardStyle, ...theme.card, border: isSelected ? `2px solid ${color}` : theme.card.border, boxShadow: isSelected ? `0 20px 25px -5px ${color}20` : theme.card.boxShadow, transform: isSelected ? 'translateY(-4px)' : 'none' }} onClick={() => isSelected && null}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ fontSize: '16px', fontWeight: '700', color: theme.text.main }}>{item.model}</div>
        <div style={{ fontSize: '14px', fontWeight: '800', color: color }}>{pct.toFixed(1)}%</div>
      </div>
      <div style={{ backgroundColor: '#f1f5f9', height: '8px', borderRadius: '4px', marginBottom: '16px' }}>
        <div style={{ height: '100%', width: `${pct}%`, backgroundColor: color, borderRadius: '4px', transition: 'width 1s ease' }} />
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <Tag label="使用" value={item.used} color={color} />
        <Tag label="延迟" value={`${item.avgLatency || 0}ms`} color="#64748b" />
      </div>
    </div>
  );
}

function EmptyState({ emoji, text }) {
  return <div style={emptyStateStyle}><span>{emoji}</span><p>{text}</p></div>;
}

// =============================================================================
// 4. 主组件 (Main Component)
// =============================================================================
export default function DashboardPage() {
  // 1. Hooks
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

  // 2. 主题
  const theme = useMemo(() => getTheme(darkMode), [darkMode]);

  // 3. 认证
  useEffect(() => {
    const saved = localStorage.getItem('dashboard_token');
    if (saved) { setPassword(saved); setAuthed(true); }
  }, []);

  const handleLogin = async (e) => {
    e?.preventDefault();
    try {
<<<<<<< HEAD
      const res = await fetch('/api/dashboard');
      const data = await res.json();
      
      if (data.error) throw new Error(data.error);

      setQuota({ data: data.quota.data, globalRequests: data.globalRequests });
      setTimeline(data.timeline);
      setRecent({ recent: data.recent.recent, retries: data.totalRetries });
      setClients(data.clients);
      setErrors(data.errors);
      
      // we still need health as a separate check since it's usually a heartbeat
      const healthRes = await fetch('/api/health').then(r => r.json()).catch(() => null);
      setHealth(healthRes);
      
      setLastUpdate(new Date());
    } catch (e) {
      console.error('Fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, []);
=======
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

  // 4. 数据
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
>>>>>>> 64752ab58f1bfaf0c0875b3b0fe51470ba6cb511

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchData]);

  // 5. 派生
  const modelDistribution = useMemo(() => {
    if (!quota?.data) return [];
    const max = Math.max(...quota.data.map(d => d.used), 1);
    return quota.data.map((d, i) => ({ label: d.model, value: d.used, max, color: ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd'][i % 4] }));
  }, [quota]);

  const filteredRecent = useMemo(() => {
    if (!selectedModel || !recent?.recent) return recent?.recent || [];
    return recent.recent.filter(r => r.model === selectedModel);
  }, [selectedModel, recent]);

  // 6. 渲染
  if (!authed) {
    return (
      <div style={{ ...pageStyle, backgroundColor: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <form onSubmit={handleLogin} style={{ background: 'white', padding: '48px', borderRadius: '24px', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)', width: '100%', maxWidth: '400px' }}>
          <h2 style={{ textAlign: 'center', marginBottom: '32px', fontSize: '24px', fontWeight: '800' }}>Dashboard Login</h2>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" style={{ width: '100%', padding: '14px', marginBottom: '16px', borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '16px' }} />
          {authError && <p style={{ color: '#ef4444', fontSize: '14px', marginBottom: '16px' }}>{authError}</p>}
          <button type="submit" style={{ width: '100%', padding: '14px', backgroundColor: '#6366f1', color: 'white', border: 'none', borderRadius: '12px', fontSize: '16px', fontWeight: '600', cursor: 'pointer' }}>Login</button>
        </form>
      </div>
    );
  }

  if (loading) return <div style={{ ...pageStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>;

  return (
    <div style={{ ...pageStyle, ...theme.page }}>
      <div style={containerStyle}>
        <header style={headerStyle}>
          <div>
            <h1 style={{ ...titleStyle, color: theme.text.main }}>Gemini Dashboard</h1>
            <p style={{ ...subtitleStyle, color: theme.text.sub }}>Real-time proxy intelligence</p>
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button onClick={() => setDarkMode(!darkMode)} style={refreshBtnStyle}> {darkMode ? '☀️' : '🌙'} </button>
            <button onClick={fetchData} style={refreshBtnStyle}> 🔄 </button>
          </div>
        </header>

        <div style={{ ...statusBarStyle, ...theme.statusBar }}>
          <StatusDot ok={health?.status === 'ok'} />
          <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0' }} />
          <StatusEmoji emoji="🚀" label="Total" value={(quota?.globalRequests || 0).toLocaleString()} />
          <StatusEmoji emoji="⏳" label="Latency" value={health?.avgLatency ? `${health.avgLatency}ms` : 'N/A'} />
          <StatusEmoji emoji="⚠️" label="Error" value={health?.errorRate ? `${health.errorRate}%` : '0%'} valueColor={health?.errorRate > 5 ? '#ef4444' : '#22c55e'} />
          <div style={{ width: '1px', height: '24px', backgroundColor: '#e2e8f0' }} />
          <StatusEmoji emoji="🔄" label="Reset" value={formatCountdown(getTimeUntilReset())} mono />
        </div>

        <div style={gridStyle}>
          {modelDistribution.map((d, i) => (
            <div key={i} onClick={() => setSelectedModel(selectedModel === d.label ? null : d.label)} style={{ cursor: 'pointer' }}>
              <ModelCard item={{...d, model: d.label, limit: d.max, used: d.value, percent: (d.value/d.max)*100}} isSelected={selectedModel === d.label} theme={theme} />
            </div>
          ))}
        </div>

        <div style={twoColStyle}>
          <div style={{ ...theme.card, ...cardStyle }}>
            <h2 style={{ ...sectionTitleStyle, marginBottom: '20px' }}>📊 Timeline</h2>
            <SparklineChart data={timeline?.timeline || []} theme={theme} />
          </div>
          <div style={{ ...theme.card, ...cardStyle }}>
            <h2 style={{ ...sectionTitleStyle, marginBottom: '20px' }}>🧬 Model Mix</h2>
            {modelDistribution.map((d, i) => (
              <HorizontalBar key={i} label={d.label} value={d.value} max={d.max} color={d.color} />
            ))}
          </div>
        </div>

        <div style={twoColStyle}>
          <div style={{ ...theme.card, ...cardStyle }}>
            <h2 style={{ ...sectionTitleStyle, marginBottom: '20px' }}>🚨 Error Stream</h2>
            <div style={{ maxHeight: '250px', overflowY: 'auto' }}>
              {errors?.errors?.slice(0, 15).map((e, i) => (
                <div key={i} style={{ ...errorRowStyle, backgroundColor: theme.bgAlt.backgroundColor, border: theme.card.border }}>
                  <span style={{ color: theme.text.muted, fontSize: '12px' }}>{formatTime(e.ts)}</span>
                  <span style={{ color: '#ef4444', fontWeight: 'bold' }}>{e.status}</span>
                  <span style={{ flex: 1, color: theme.text.main, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.model}</span>
                  <span style={{ color: theme.text.muted }}>{e.latency}ms</span>
                </div>
              )) || <EmptyState emoji="✅" text="No errors detected" />}
            </div>
          </div>
          <div style={{ ...theme.card, ...cardStyle }}>
            <h2 style={{ ...sectionTitleStyle, marginBottom: '20px' }}>📜 Recent Logs</h2>
            <div style={{ maxHeight: '250px', overflowY: 'auto' }}>
              {filteredRecent.map((r, i) => (
                <div key={i} style={{ ...errorRowStyle, backgroundColor: theme.bgAlt.backgroundColor, border: theme.card.border }}>
                  <span style={{ color: theme.text.muted, fontSize: '12px' }}>{formatTime(r.ts)}</span>
                  <span style={{ fontWeight: '600', color: theme.text.main }}>{r.model}</span>
                  <span style={{ flex: 1, color: theme.text.muted }}>{r.status}</span>
                  <span style={{ color: theme.text.muted }}>{r.latency}ms</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <footer style={footerStyle}>
          <p>© 2026 Gemini Transparent Proxy • Built for Performance</p>
        </footer>
      </div>
    </div>
  );
}
<<<<<<< HEAD

// ---- Sub-Components ----

function StatusDot({ label, ok, okText, failText }) {
  return (
    <div style={statusItemStyle}>
      <div style={{ ...statusDotStyle, backgroundColor: ok ? '#22c55e' : '#ef4444', boxShadow: ok ? '0 0 8px rgba(34,197,94,0.5)' : '0 0 8px rgba(239,68,68,0.5)' }} />
      <div>
        <div style={statusLabelStyle}>{label}</div>
        <div style={{ ...statusValueStyle, color: ok ? '#166534' : '#991b1b' }}>{ok ? okText : failText}</div>
      </div>
    </div>
  );
}

function StatusEmoji({ emoji, label, value, valueColor, mono }) {
  return (
    <div style={statusItemStyle}>
      <div style={statusEmojiStyle}>{emoji}</div>
      <div>
        <div style={statusLabelStyle}>{label}</div>
        <div style={{ ...statusValueStyle, color: valueColor || '#0f172a', fontFamily: mono ? 'monospace' : undefined, fontSize: mono ? '16px' : undefined, letterSpacing: mono ? '0.05em' : undefined }}>{value}</div>
      </div>
    </div>
  );
}

function ModelCard({ item }) {
  const percent = Math.min(item.percent, 100);
  const isHigh = percent > 90;
  const isMedium = percent > 70;
  const barColor = isHigh ? '#ef4444' : isMedium ? '#f59e0b' : '#6366f1';

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' }}>
        <h3 style={cardModelNameStyle}>{item.model}</h3>
        <span style={cardUsageStyle}>
          {item.used.toLocaleString()} <span style={{ color: '#94a3b8' }}>/ {item.limit.toLocaleString()}</span>
        </span>
      </div>
      <div style={progressTrackStyle}>
        <div style={{ ...progressFillStyle, width: `${percent}%`, background: `linear-gradient(90deg, ${barColor}, ${isHigh ? '#dc2626' : isMedium ? '#d97706' : '#818cf8'})` }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', marginBottom: '14px' }}>
        <span style={{ fontSize: '13px', fontWeight: '600', color: barColor }}>{percent.toFixed(1)}%</span>
        <span style={{ fontSize: '12px', color: '#94a3b8' }}>
          {item.limit - item.used > 0 ? `${(item.limit - item.used).toLocaleString()} remaining` : 'Quota exhausted'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <Tag label="Latency" value={item.avgLatency != null ? `${item.avgLatency}ms` : 'N/A'} color={item.avgLatency != null && item.avgLatency > 3000 ? '#dc2626' : item.avgLatency != null && item.avgLatency > 1500 ? '#d97706' : '#059669'} />
        <Tag label="Errors" value={item.errorRate != null ? `${item.errorRate}%` : '0%'} color={(item.errorRate || 0) > 5 ? '#dc2626' : (item.errorRate || 0) > 1 ? '#d97706' : '#059669'} />
      </div>
    </div>
  );
}

function Tag({ label, value, color }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 10px', borderRadius: '6px', fontSize: '12px', fontFamily: 'monospace', backgroundColor: `${color}11`, color, border: `1px solid ${color}33` }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ fontWeight: '600' }}>{value}</span>
    </span>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div style={{ flex: 1, padding: '12px', borderRadius: '10px', backgroundColor: '#f8fafc', border: '1px solid #f1f5f9', textAlign: 'center' }}>
      <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px', fontWeight: '500' }}>{label}</div>
      <div style={{ fontSize: '18px', fontWeight: '700', color, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

function EmptyState({ emoji, text }) {
  return (
    <div style={emptyStateStyle}>
      <span style={{ fontSize: '24px', marginBottom: '8px' }}>{emoji}</span>
      <span style={{ color: '#94a3b8', fontWeight: '600' }}>{text}</span>
    </div>
  );
}

// ===================== Styles =====================

const pageStyle = { backgroundColor: '#f1f5f9', minHeight: '100vh', padding: '32px 20px', fontFamily: 'Inter, system-ui, -apple-system, sans-serif', color: '#1e293b' };
const centerStyle = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' };
const spinnerStyle = { width: '40px', height: '40px', border: '3px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite' };
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' };
const titleStyle = { fontSize: '28px', fontWeight: '800', color: '#0f172a', margin: 0, letterSpacing: '-0.025em' };
const subtitleStyle = { color: '#64748b', fontSize: '14px', marginTop: '4px', margin: 0 };
const refreshBtnStyle = { width: '40px', height: '40px', borderRadius: '12px', border: '1px solid #e2e8f0', backgroundColor: 'white', fontSize: '20px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6366f1', transition: 'all 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' };

const statusBarStyle = { display: 'flex', alignItems: 'center', backgroundColor: 'white', borderRadius: '16px', padding: '20px 28px', marginBottom: '28px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: '1px solid #e2e8f0', flexWrap: 'wrap' };
const statusItemStyle = { display: 'flex', alignItems: 'center', gap: '12px', padding: '4px 20px' };
const statusDotStyle = { width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0 };
const statusEmojiStyle = { fontSize: '20px', flexShrink: 0 };
const statusDividerStyle = { width: '1px', height: '36px', backgroundColor: '#e2e8f0', flexShrink: 0 };
const statusLabelStyle = { fontSize: '12px', color: '#94a3b8', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.05em' };
const statusValueStyle = { fontSize: '18px', fontWeight: '700', color: '#0f172a' };

const modelGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '16px', marginBottom: '28px' };
const twoColStyle = { 
  display: 'grid', 
  gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', 
  gap: '20px', 
  marginBottom: '28px' 
};

const cardStyle = { backgroundColor: 'white', borderRadius: '16px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: '1px solid #e2e8f0' };
const cardModelNameStyle = { fontSize: '15px', fontWeight: '700', color: '#1e293b', margin: 0, fontFamily: 'monospace' };
const cardUsageStyle = { fontSize: '16px', fontWeight: '700', color: '#6366f1' };
const progressTrackStyle = { backgroundColor: '#f1f5f9', height: '8px', borderRadius: '4px', overflow: 'hidden' };
const progressFillStyle = { height: '100%', borderRadius: '4px', transition: 'width 0.6s ease' };

const sectionCardStyle = { backgroundColor: 'white', borderRadius: '16px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: '1px solid #e2e8f0' };
const sectionHeaderStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' };
const sectionTitleStyle = { fontSize: '18px', fontWeight: '700', color: '#1e293b', margin: 0, display: 'flex', alignItems: 'center' };
const peakBadge = { display: 'inline-flex', alignItems: 'center', padding: '4px 12px', borderRadius: '20px', backgroundColor: '#eef2ff', color: '#6366f1', fontSize: '13px', fontWeight: '600', border: '1px solid #c7d2fe' };
const badgeBase = { display: 'inline-flex', alignItems: 'center', padding: '4px 12px', borderRadius: '20px', fontSize: '13px', fontWeight: '600' };

const errorCountBadge = { ...badgeBase, backgroundColor: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' };
const errorListStyle = { display: 'flex', flexDirection: 'column', gap: '8px' };
const errorRowStyle = { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderRadius: '10px', backgroundColor: '#f8fafc', border: '1px solid #f1f5f9', fontFamily: 'monospace', fontSize: '13px' };
const errorTimeStyle = { color: '#94a3b8', fontSize: '12px', minWidth: '70px' };
const errorStatusBadgeStyle = { padding: '2px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: '700', minWidth: '40px', textAlign: 'center' };
const errorModelStyle = { color: '#475569', fontWeight: '600', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const errorLatencyStyle = { color: '#94a3b8', fontSize: '12px', textAlign: 'right', minWidth: '60px' };

const emptyStateStyle = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px', gap: '8px' };
const footerStyle = { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', paddingTop: '20px', borderTop: '1px solid #e2e8f0' };
const footerLinkStyle = { color: '#6366f1', textDecoration: 'none', fontSize: '13px', fontWeight: '500' };
=======
>>>>>>> 64752ab58f1bfaf0c0875b3b0fe51470ba6cb511
