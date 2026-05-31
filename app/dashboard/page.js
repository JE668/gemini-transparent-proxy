'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';

const REFRESH_INTERVAL = 30000;

// ---- HTTP 状态码中文解释 ----
const HTTP_STATUS_DESC = {
  400: '请求格式错误',
  401: '认证失败/密钥无效',
  403: '权限不足/访问被拒',
  404: '资源不存在',
  408: '请求超时',
  429: '请求过于频繁(限流)',
  500: '服务器内部错误',
  502: '网关错误(上游异常)',
  503: '服务暂不可用',
  504: '网关超时(上游无响应)',
};

function getStatusDesc(code) {
  return HTTP_STATUS_DESC[code] || '';
}

// ---- 配额重置倒计时 ----
function getTimeUntilReset() {
 // Gemini API 配额在太平洋时间午夜重置（即 UTC 07:00 PST / UTC 08:00 PDT）
 // 简化处理：固定以 UTC 07:00 为重置点（PST），夏令时期间偏差 1h 可接受
 const now = new Date();
 // 计算下一个重置时刻（UTC 07:00）
 const reset = new Date(now);
 reset.setUTCHours(7, 0, 0, 0);
 // 如果当前已过今天的重置点，则目标为明天
 if (now >= reset) {
 reset.setUTCDate(reset.getUTCDate() + 1);
 }
 const diffMs = reset - now;
 const totalSeconds = Math.floor(diffMs / 1000);
 const hours = Math.floor(totalSeconds / 3600);
 const minutes = Math.floor((totalSeconds % 3600) / 60);
 const seconds = totalSeconds % 60;
 return { hours, minutes, seconds };
}

function formatCountdown(cd) {
  return `${String(cd.hours).padStart(2, '0')}:${String(cd.minutes).padStart(2, '0')}:${String(cd.seconds).padStart(2, '0')}`;
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return iso; }
}

// ---- SVG 折线图 ----
function SparklineChart({ data, width = 700, height = 160 }) {
  const [hovered, setHovered] = useState(null);
  if (!data || data.length === 0) return null;
  const maxVal = Math.max(...data.map(d => d.count), 1);
  const padX = 40, padY = 20;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;
  const stepX = chartW / (data.length - 1);
  const points = data.map((d, i) => ({ x: padX + i * stepX, y: padY + chartH - (d.count / maxVal) * chartH, ...d }));
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x},${padY + chartH} L${points[0].x},${padY + chartH} Z`;
  const currentBjHour = (new Date().getUTCHours() + 8) % 24;

  // Tooltip 定位
  const tipW = 130, tipH = 48, tipR = 8;
  const tipX = hovered != null ? Math.min(Math.max(points[hovered].x - tipW / 2, 4), width - tipW - 4) : 0;
  const tipY = hovered != null ? Math.max(points[hovered].y - tipH - 16, 2) : 0;

  return (
  <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', cursor: 'crosshair' }}
  onMouseMove={(e) => {
  const svg = e.currentTarget;
  const rect = svg.getBoundingClientRect();
  const scaleX = width / rect.width;
  const mx = (e.clientX - rect.left) * scaleX;
  let closest = 0, minDist = Infinity;
  points.forEach((p, i) => { const d = Math.abs(p.x - mx); if (d < minDist) { minDist = d; closest = i; } });
  if (hovered !== closest) setHovered(closest);
  }}
  onMouseLeave={() => setHovered(null)}
  >
      {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => {
        const y = padY + chartH - ratio * chartH;
        return (
          <g key={i}>
            <line x1={padX} y1={y} x2={width - padX} y2={y} stroke="#f1f5f9" strokeWidth="1" />
            <text x={padX - 8} y={y + 4} textAnchor="end" fill="#94a3b8" fontSize="10" fontFamily="monospace">{Math.round(maxVal * ratio)}</text>
          </g>
        );
      })}
      <path d={areaPath} fill="url(#areaGrad)" opacity="0.3" />
      <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6366f1" /><stop offset="100%" stopColor="#6366f1" stopOpacity="0" /></linearGradient></defs>
      <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

      {/* 悬浮垂直辅助线 */}
      {hovered != null && (
        <line x1={points[hovered].x} y1={padY} x2={points[hovered].x} y2={padY + chartH} stroke="#6366f1" strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />
      )}

      {/* 数据点 */}
      {points.map((p, i) => {
      const isCurrent = p.hour === currentBjHour;
      const isHovered = hovered === i;
      return (
      <g key={i}>
      <circle cx={p.x} cy={p.y} r={isHovered ? 6 : isCurrent ? 4.5 : 3} fill={isHovered ? '#4f46e5' : isCurrent ? '#6366f1' : '#fff'} stroke="#6366f1" strokeWidth={isHovered ? 3 : isCurrent ? 2.5 : 2} style={{ transition: 'r 0.15s ease' }} />
      {(i % 3 === 0 || i === data.length - 1) && (
      <text x={p.x} y={height - 2} textAnchor="middle" fill="#94a3b8" fontSize="10" fontFamily="monospace">{p.label}</text>
      )}
      </g>
      );
      })}

      {/* Tooltip */}
      {hovered != null && (
      <g pointerEvents="none">
          <rect x={tipX} y={tipY} width={tipW} height={tipH} rx={tipR} fill="#1e293b" opacity="0.92" />
          <text x={tipX + tipW / 2} y={tipY + 18} textAnchor="middle" fill="#e2e8f0" fontSize="12" fontWeight="600">
            {points[hovered].label}
          </text>
          <text x={tipX + tipW / 2} y={tipY + 36} textAnchor="middle" fill="#a5b4fc" fontSize="14" fontWeight="700" fontFamily="monospace">
            {points[hovered].count} 次请求
          </text>
        </g>
      )}
    </svg>
  );
}

// ---- 水平条形图 ----
function HorizontalBar({ label, value, max, color = '#6366f1' }) {
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

export default function DashboardPage() {
 const [quota, setQuota] = useState(null);
 const [health, setHealth] = useState(null);
 const [errors, setErrors] = useState(null);
 const [timeline, setTimeline] = useState(null);
 const [clients, setClients] = useState(null);
 const [recent, setRecent] = useState(null);
 const [lastUpdate, setLastUpdate] = useState(null);
 const [loading, setLoading] = useState(true);
 const [countdown, setCountdown] = useState(getTimeUntilReset());
 // 认证状态
 const [authed, setAuthed] = useState(false);
 const [password, setPassword] = useState('');
 const [authError, setAuthError] = useState('');

 // 从 localStorage 恢复密码
 useEffect(() => {
 const saved = localStorage.getItem('dashboard_token');
 if (saved) {
 setPassword(saved);
 setAuthed(true);
 }
 }, []);

 const handleLogin = async (e) => {
 e?.preventDefault();
 setAuthError('');
 try {
 const res = await fetch('/api/quota', {
 headers: { 'Authorization': `Bearer ${password}` }
 });
 if (res.status === 401) {
 setAuthError('密码错误，请重新输入');
 return;
 }
 // 认证成功
 localStorage.setItem('dashboard_token', password);
 setAuthed(true);
 } catch {
 setAuthError('连接失败，请检查网络');
 }
 };

 // 带认证的 fetch 封装
 const authFetch = useCallback(async (url) => {
 const res = await fetch(url, {
 headers: { 'Authorization': `Bearer ${password}` }
 });
 if (res.status === 401) {
 // 密码失效，退回登录
 localStorage.removeItem('dashboard_token');
 setAuthed(false);
 setPassword('');
 setAuthError('认证已过期，请重新输入密码');
 return null;
 }
 return res;
 }, [password]);

  useEffect(() => {
    const timer = setInterval(() => setCountdown(getTimeUntilReset()), 1000);
    return () => clearInterval(timer);
  }, []);

  const fetchData = useCallback(async () => {
  if (!authed) return;
  try {
  const [quotaRes, healthRes, errorsRes, timelineRes, clientsRes, recentRes] = await Promise.all([
  authFetch('/api/quota').then(r => r?.json()),
  authFetch('/api/health').then(r => r?.json()).catch(() => null),
  authFetch('/api/errors').then(r => r?.json()).catch(() => null),
  authFetch('/api/timeline').then(r => r?.json()).catch(() => null),
  authFetch('/api/clients').then(r => r?.json()).catch(() => null),
  authFetch('/api/recent').then(r => r?.json()).catch(() => null),
  ]);
  // 任一返回 null 说明 401 已处理
  if (!quotaRes && !healthRes && !errorsRes && !timelineRes && !clientsRes && !recentRes) return;
  setQuota(quotaRes);
  setHealth(healthRes);
  setErrors(errorsRes);
  setTimeline(timelineRes);
  setClients(clientsRes);
  setRecent(recentRes);
  setLastUpdate(new Date());
  } catch (e) {
  console.error('Fetch error:', e);
  } finally {
  setLoading(false);
  }
  }, [authed, authFetch]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchData]);

  // 模型分布：从 quota 数据聚合
  const modelDistribution = useMemo(() => {
    if (!quota?.data) return [];
    const maxUsed = Math.max(...quota.data.map(d => d.used), 1);
    const colors = ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#818cf8'];
    return quota.data
      // 只显示 Gemma 4 系列模型
      .filter(d => d.model && d.model.startsWith('gemma-4'))
      .map((d, i) => ({ label: d.model, value: d.used, max: maxUsed, color: colors[i % colors.length] }))
      .sort((a, b) => b.value - a.value);
  }, [quota]);

  const globalStats = quota?.data ? quota.data.reduce((acc, item) => {
    acc.totalUsed += item.used;
    acc.totalLimit += item.limit;
    if (item.avgLatency) acc.latencies.push(item.avgLatency);
    acc.errorRate = Math.max(acc.errorRate, item.errorRate || 0);
    return acc;
  }, { totalUsed: 0, totalLimit: 0, latencies: [], errorRate: 0 }) : null;

  const globalAvgLatency = globalStats?.latencies.length
    ? Math.round(globalStats.latencies.reduce((a, b) => a + b, 0) / globalStats.latencies.length)
    : null;

  // 未认证：显示密码输入框
 if (!authed) {
 return (
 <div style={pageStyle}>
 <div style={centerStyle}>
 <div style={{ textAlign: 'center', maxWidth: '360px', width: '100%' }}>
 <div style={{ fontSize: '48px', marginBottom: '16px' }}>&#x1F512;</div>
 <h2 style={{ color: '#1e293b', marginBottom: '8px', fontSize: '22px' }}>Dashboard 认证</h2>
 <p style={{ color: '#64748b', marginBottom: '24px', fontSize: '14px' }}>请输入访问密码</p>
 <form onSubmit={handleLogin}>
 <input
 type="password"
 value={password}
 onChange={e => setPassword(e.target.value)}
 placeholder="输入密码"
 autoFocus
 style={{
 width: '100%',
 padding: '12px 16px',
 border: '2px solid #e2e8f0',
 borderRadius: '8px',
 fontSize: '15px',
 outline: 'none',
 boxSizing: 'border-box',
 transition: 'border-color 0.2s',
 borderColor: authError ? '#ef4444' : '#e2e8f0',
 }}
 onFocus={e => e.target.style.borderColor = '#6366f1'}
 onBlur={e => e.target.style.borderColor = authError ? '#ef4444' : '#e2e8f0'}
 />
 {authError && (
 <p style={{ color: '#ef4444', fontSize: '13px', marginTop: '8px' }}>{authError}</p>
 )}
 <button
 type="submit"
 style={{
 width: '100%',
 marginTop: '16px',
 padding: '12px',
 backgroundColor: '#6366f1',
 color: '#fff',
 border: 'none',
 borderRadius: '8px',
 fontSize: '15px',
 fontWeight: '600',
 cursor: 'pointer',
 transition: 'background-color 0.2s',
 }}
 onMouseOver={e => e.target.style.backgroundColor = '#4f46e5'}
 onMouseOut={e => e.target.style.backgroundColor = '#6366f1'}
 >
 登 录
 </button>
 </form>
 </div>
 </div>
 </div>
 );
 }

 if (loading) {
    return (
      <div style={pageStyle}>
        <div style={centerStyle}>
          <div style={spinnerStyle} />
          <p style={{ color: '#64748b', marginTop: '16px' }}>正在加载控制台...</p>
        </div>
      </div>
    );
  }

  const systemOk = health?.status === 'ok' || health?.status === 'degraded';
 const geminiOk = health?.gemini?.status === 'ok';
 const redisOk = health?.redis?.status === 'ok' || health?.redis?.status === 'warn';
  const hasErrors = errors?.errors?.length > 0;
  const hasTimeline = timeline?.timeline?.length > 0;
  const hasClients = clients?.clients?.length > 0;
  const hasRecent = recent?.recent?.length > 0;
  const totalRetries = recent?.retries || 0;
  const peakHour = hasTimeline
    ? timeline.timeline.reduce((max, d) => d.count > max.count ? d : max, { count: 0 })
    : null;
  const clientMax = hasClients ? Math.max(...clients.clients.map(c => c.requests), 1) : 1;

  return (
    <div style={pageStyle} className="dashboard-page">
    <div style={{ maxWidth: '1440px', margin: '0 auto' }} className="dashboard-container">

    {/* Header */}
    <header style={headerStyle} className="dashboard-header">
          <div>
            <h1 style={titleStyle} className="dashboard-title">Gemini 代理 <span style={{ color: '#6366f1' }}>控制台</span></h1>
            <p style={subtitleStyle} className="dashboard-subtitle">
              {lastUpdate
                ? `最近更新: ${lastUpdate.toLocaleTimeString('zh-CN', { hour12: false })} | 自动刷新: ${REFRESH_INTERVAL / 1000}秒`
                : '监控代理状态与配额使用情况'}
            </p>
          </div>
          <button onClick={fetchData} style={refreshBtnStyle} title="立即刷新">&#x21bb;</button>
        </header>

        {/* Global Status Bar */}
        <div style={statusBarStyle} className="dashboard-status-bar">
        <StatusDot label="系统状态" ok={systemOk} okText="在线" failText="离线" />
        <div style={statusDividerStyle} className="dashboard-status-divider" />
        <StatusEmoji emoji="&#x1F4C8;" label="总请求数" value={(quota?.globalRequests || 0).toLocaleString()} />
        <div style={statusDividerStyle} className="dashboard-status-divider" />
        <StatusEmoji emoji="&#x23F1;" label="平均延迟" value={globalAvgLatency != null ? `${globalAvgLatency}ms` : '暂无'} />
        <div style={statusDividerStyle} className="dashboard-status-divider" />
        <StatusEmoji emoji="&#x26A0;" label="错误率" value={globalStats ? `${globalStats.errorRate}%` : '暂无'} valueColor={(globalStats?.errorRate || 0) > 5 ? '#dc2626' : '#166534'} />
        <div style={statusDividerStyle} className="dashboard-status-divider" />
        <StatusEmoji emoji="&#x1F504;" label="重试次数" value={totalRetries.toLocaleString()} valueColor={totalRetries > 10 ? '#dc2626' : totalRetries > 0 ? '#d97706' : '#166534'} />
        <div style={statusDividerStyle} className="dashboard-status-divider" />
        <StatusEmoji emoji="&#x23F0;" label="配额重置" value={formatCountdown(countdown)} mono />
        <div style={statusDividerStyle} className="dashboard-status-divider" />
        <StatusEmoji emoji="&#x1F916;" label="Gemini" value={geminiOk ? '正常' : '异常'} valueColor={geminiOk ? '#166534' : '#dc2626'} />
        <div style={statusDividerStyle} className="dashboard-status-divider" />
        <StatusEmoji emoji="&#x1F5C4;" label="Redis" value={redisOk ? '正常' : '异常'} valueColor={redisOk ? '#166534' : '#dc2626'} />
        </div>

        {/* Model Cards */}
        <div style={modelGridStyle} className="dashboard-model-grid">
          {quota?.data?.filter(item => item.model && item.model.startsWith('gemma-4')).map((item, i) => <ModelCard key={i} item={item} />)}
        </div>

        {/* Row: Timeline + Model Distribution */}
        <div style={twoColStyle} className="dashboard-two-col">
          {/* Request Timeline */}
          {hasTimeline && (
            <div style={sectionCardStyle} className="dashboard-section">
              <div style={sectionHeaderStyle} className="dashboard-section-header">
                <h2 style={sectionTitleStyle}>
                  <span style={{ marginRight: '8px' }}>&#x1F4CA;</span>请求时间线
                  <span style={{ fontSize: '13px', fontWeight: '400', color: '#94a3b8', marginLeft: '12px' }}>UTC+8 {timeline.date}</span>
                </h2>
                {peakHour && peakHour.count > 0 && (
                  <span style={peakBadge} className="dashboard-peak-badge">峰值: {peakHour.label} ({peakHour.count})</span>
                )}
              </div>
              <SparklineChart data={timeline.timeline} />
            </div>
          )}

          {/* Model Distribution */}
          {modelDistribution.length > 0 && (
            <div style={sectionCardStyle} className="dashboard-section">
              <div style={sectionHeaderStyle} className="dashboard-section-header">
                <h2 style={sectionTitleStyle}>
                  <span style={{ marginRight: '8px' }}>&#x1F4CB;</span>模型路由分布
                  <span style={{ fontSize: '13px', fontWeight: '400', color: '#94a3b8', marginLeft: '12px' }}>今日</span>
                </h2>
                <span style={peakBadge} className="dashboard-peak-badge">{quota.data.reduce((s, d) => s + d.used, 0).toLocaleString()} 次总计</span>
              </div>
              {modelDistribution.map((d, i) => (
                <HorizontalBar key={i} label={d.label} value={d.value} max={d.max} color={d.color} />
              ))}
            </div>
          )}
        </div>

        {/* Row: Clients + Retries */}
        <div style={twoColStyle} className="dashboard-two-col">
          {/* Client Source Top 10 */}
          <div style={sectionCardStyle} className="dashboard-section">
            <div style={sectionHeaderStyle} className="dashboard-section-header">
              <h2 style={sectionTitleStyle}>
                <span style={{ marginRight: '8px' }}>&#x1F511;</span>来源统计
                <span style={{ fontSize: '13px', fontWeight: '400', color: '#94a3b8', marginLeft: '12px' }}>
                  {clients?.totalClients || 0} 个密钥
                </span>
              </h2>
              {clients?.totalRequests > 0 && (
                <span style={peakBadge} className="dashboard-peak-badge">{clients.totalRequests.toLocaleString()} 次请求</span>
              )}
            </div>
            {hasClients ? (
              clients.clients.map((c, i) => (
                <HorizontalBar
                  key={i}
                  label={c.fingerprint}
                  value={c.requests}
                  max={clientMax}
                  color={['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#818cf8', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#312e81'][i % 10]}
                />
              ))
            ) : (
              <EmptyState emoji="&#x1F512;" text="暂无来源数据" />
            )}
          </div>

          {/* Retry Events */}
          <div style={sectionCardStyle} className="dashboard-section">
            <div style={sectionHeaderStyle} className="dashboard-section-header">
              <h2 style={sectionTitleStyle}>
                <span style={{ marginRight: '8px' }}>&#x1F504;</span>重试事件追踪
              </h2>
              <span style={{
                ...badgeBase,
                backgroundColor: totalRetries > 10 ? '#fef2f2' : totalRetries > 0 ? '#fffbeb' : '#f0fdf4',
                color: totalRetries > 10 ? '#dc2626' : totalRetries > 0 ? '#d97706' : '#059669',
                border: `1px solid ${totalRetries > 10 ? '#fecaca' : totalRetries > 0 ? '#fde68a' : '#bbf7d0'}`,
              }}>
                今日 {totalRetries} 次
              </span>
            </div>

            {/* 重试摘要 */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }} className="dashboard-retry-stats">
              <MiniStat label="总重试次数" value={totalRetries} color={totalRetries > 0 ? '#d97706' : '#059669'} />
              <MiniStat label="重试率" value={quota?.globalRequests > 0 ? `${((totalRetries / quota.globalRequests) * 100).toFixed(2)}%` : '0%'} color="#6366f1" />
              <MiniStat label="状态" value={totalRetries > 10 ? '性能下降' : totalRetries > 0 ? '需关注' : '正常'} color={totalRetries > 10 ? '#dc2626' : totalRetries > 0 ? '#d97706' : '#059669'} />
            </div>

            {/* 最近有重试的请求 */}
            {hasRecent && (
              <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '8px', fontWeight: '600' }}>
                最近重试请求
              </div>
            )}
            <div style={errorListStyle}>
              {recent.recent
                .filter(r => r.retries > 0)
                .slice(0, 10)
                .map((r, i) => (
                  <div key={i} style={errorRowStyle} className="dashboard-error-row">
                    <span style={errorTimeStyle}>{formatTime(r.ts)}</span>
                    <span style={{ ...errorStatusBadgeStyle, backgroundColor: '#fffbeb', color: '#d97706', border: '1px solid #fde68a' }}>
                      {r.retries}次重试
                    </span>
                    <span style={errorModelStyle}>{r.model}</span>
                     <span style={errorLatencyStyle}>{r.latency}ms</span>
                     </div>
                     ))}
                    {recent.recent.filter(r => r.retries > 0).length === 0 && (
                <EmptyState emoji="&#x2705;" text="今日无重试" />
              )}
            </div>
          </div>
        </div>

        {/* Row: Error Stream + Recent Requests */}
        <div style={twoColStyle} className="dashboard-two-col">
          {/* Error Stream */}
          <div style={sectionCardStyle} className="dashboard-section">
            <div style={sectionHeaderStyle} className="dashboard-section-header">
              <h2 style={sectionTitleStyle}>
                <span style={{ marginRight: '8px' }}>&#x1F534;</span>实时错误日志
              </h2>
              {errors?.count > 0 && <span style={errorCountBadge}>今日 {errors.count} 条</span>}
            </div>
            {hasErrors ? (
              <div style={errorListStyle}>
                {errors.errors.slice(0, 15).map((entry, i) => (
                  <div key={i} style={errorRowStyle} className="dashboard-error-row">
                    <span style={errorTimeStyle}>{formatTime(entry.ts)}</span>
                    <span style={{
                      ...errorStatusBadgeStyle,
                      backgroundColor: entry.status >= 500 ? '#fef2f2' : '#fffbeb',
                      color: entry.status >= 500 ? '#dc2626' : '#d97706',
                      border: `1px solid ${entry.status >= 500 ? '#fecaca' : '#fde68a'}`,
                    }}>{entry.status}</span>
                    {getStatusDesc(entry.status) && (
                      <span style={{ fontSize: '12px', color: entry.status >= 500 ? '#b91c1c' : '#92400e', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={getStatusDesc(entry.status)}>
                        {getStatusDesc(entry.status)}
                      </span>
                    )}
                    <span style={errorModelStyle}>{entry.model}</span>
                    <span style={errorLatencyStyle}>{entry.latency}ms</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState emoji="&#x2705;" text="今日无错误" />
            )}
          </div>

          {/* Recent Requests */}
          <div style={sectionCardStyle} className="dashboard-section">
            <div style={sectionHeaderStyle} className="dashboard-section-header">
              <h2 style={sectionTitleStyle}>
                <span style={{ marginRight: '8px' }}>&#x1F4E5;</span>最近请求快照
              </h2>
              <span style={peakBadge} className="dashboard-peak-badge">最近 30 条</span>
            </div>
            {hasRecent ? (
              <div style={errorListStyle}>
                {recent.recent.slice(0, 20).map((r, i) => (
                  <div key={i} style={errorRowStyle} className="dashboard-error-row">
                    <span style={errorTimeStyle}>{formatTime(r.ts)}</span>
                    <span style={{
                      ...errorStatusBadgeStyle,
                      backgroundColor: r.status >= 400 ? '#fef2f2' : '#f0fdf4',
                      color: r.status >= 400 ? '#dc2626' : '#059669',
                      border: `1px solid ${r.status >= 400 ? '#fecaca' : '#bbf7d0'}`,
                    }}>{r.status}</span>
                    {r.status >= 400 && getStatusDesc(r.status) && (
                      <span style={{ fontSize: '12px', color: r.status >= 500 ? '#b91c1c' : '#92400e', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={getStatusDesc(r.status)}>
                        {getStatusDesc(r.status)}
                      </span>
                    )}
                    <span style={errorModelStyle}>{r.model}</span>
                     <span style={errorLatencyStyle}>{r.latency}ms</span>
                     {r.retries > 0 && (
                      <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', backgroundColor: '#fffbeb', color: '#d97706', border: '1px solid #fde68a' }}>
                        {r.retries}次重试
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState emoji="&#x1F4ED;" text="暂无请求记录" />
            )}
          </div>
        </div>

        {/* HTTP 状态码速查表 */}
        <div style={sectionCardStyle} className="dashboard-section">
          <div style={sectionHeaderStyle} className="dashboard-section-header">
            <h2 style={sectionTitleStyle}>
              <span style={{ marginRight: '8px' }}>&#x1F4D6;</span>HTTP 状态码速查
            </h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '10px' }} className="dashboard-http-grid">
            {Object.entries(HTTP_STATUS_DESC).map(([code, desc]) => (
              <div key={code} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '8px', backgroundColor: '#f8fafc', border: '1px solid #f1f5f9' }}>
                <span style={{
                  padding: '2px 10px',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: '700',
                  fontFamily: 'monospace',
                  minWidth: '36px',
                  textAlign: 'center',
                  backgroundColor: parseInt(code) >= 500 ? '#fef2f2' : parseInt(code) >= 400 ? '#fffbeb' : '#f0fdf4',
                  color: parseInt(code) >= 500 ? '#dc2626' : parseInt(code) >= 400 ? '#d97706' : '#059669',
                  border: `1px solid ${parseInt(code) >= 500 ? '#fecaca' : parseInt(code) >= 400 ? '#fde68a' : '#bbf7d0'}`,
                }}>{code}</span>
                <span style={{ fontSize: '13px', color: '#475569' }}>{desc}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <footer style={footerStyle}>
        <a href="https://github.com/JE668/gemini-transparent-proxy" target="_blank" rel="noopener noreferrer" style={footerLinkStyle}>GitHub</a>
        <span style={{ color: '#cbd5e1' }}>|</span>
        <span style={{ color: '#94a3b8', fontSize: '13px' }}>Gemini 透明代理 &middot; Vercel Edge</span>
        </footer>
        </div>

        {/* 移动端响应式媒体查询 — 注入全局 CSS */}
        <style>{`
        @media (max-width: 768px) {
        .dashboard-page { padding: 16px 10px !important; }
        .dashboard-container { max-width: 100% !important; }
        .dashboard-status-bar { padding: 14px 12px !important; gap: 4px !important; }
        .dashboard-status-item { padding: 4px 8px !important; }
        .dashboard-status-divider { display: none !important; }
        .dashboard-status-value { font-size: 14px !important; }
        .dashboard-title { font-size: 22px !important; }
        .dashboard-subtitle { font-size: 12px !important; }
        .dashboard-two-col { grid-template-columns: 1fr !important; }
        .dashboard-model-grid { grid-template-columns: 1fr !important; }
        .dashboard-card { padding: 16px !important; }
        .dashboard-section { padding: 16px !important; }
        .dashboard-error-row { flex-wrap: wrap !important; gap: 6px !important; }
         .dashboard-error-time { min-width: auto !important; }
        .dashboard-section-header { flex-direction: column !important; align-items: flex-start !important; gap: 8px !important; }
        .dashboard-retry-stats { flex-wrap: wrap !important; }
        .dashboard-http-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)) !important; }
        .dashboard-header { margin-bottom: 16px !important; }
        .dashboard-peak-badge { font-size: 11px !important; padding: 3px 8px !important; }
        }
        @media (max-width: 480px) {
        .dashboard-status-bar { flex-direction: column !important; align-items: flex-start !important; }
        .dashboard-status-item { width: 100% !important; padding: 6px 8px !important; }
        .dashboard-title { font-size: 20px !important; }
        .dashboard-model-grid { gap: 10px !important; }
        .dashboard-http-grid { grid-template-columns: 1fr !important; }
        }
        `}</style>
        </div>
        );
}

// ---- Sub-Components ----

function StatusDot({ label, ok, okText, failText }) {
 return (
 <div style={statusItemStyle} className="dashboard-status-item">
 <div style={{ ...statusDotStyle, backgroundColor: ok ? '#22c55e' : '#ef4444', boxShadow: ok ? '0 0 8px rgba(34,197,94,0.5)' : '0 0 8px rgba(239,68,68,0.5)' }} />
 <div>
 <div style={statusLabelStyle}>{label}</div>
 <div style={{ ...statusValueStyle, color: ok ? '#166534' : '#991b1b' }} className="dashboard-status-value">{ok ? okText : failText}</div>
 </div>
 </div>
 );
}

function StatusEmoji({ emoji, label, value, valueColor, mono }) {
 return (
 <div style={statusItemStyle} className="dashboard-status-item">
 <div style={statusEmojiStyle}>{emoji}</div>
 <div>
 <div style={statusLabelStyle}>{label}</div>
 <div style={{ ...statusValueStyle, color: valueColor || '#0f172a', fontFamily: mono ? 'monospace' : undefined, fontSize: mono ? '16px' : undefined, letterSpacing: mono ? '0.05em' : undefined }} className="dashboard-status-value">{value}</div>
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
    <div style={cardStyle} className="dashboard-card">
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
          {item.limit - item.used > 0 ? `剩余 ${(item.limit - item.used).toLocaleString()}` : '配额已耗尽'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <Tag label="延迟" value={item.avgLatency != null ? `${item.avgLatency}ms` : '暂无'} color={item.avgLatency != null && item.avgLatency > 3000 ? '#dc2626' : item.avgLatency != null && item.avgLatency > 1500 ? '#d97706' : '#059669'} />
        <Tag label="错误率" value={item.errorRate != null ? `${item.errorRate}%` : '0%'} color={(item.errorRate || 0) > 5 ? '#dc2626' : (item.errorRate || 0) > 1 ? '#d97706' : '#059669'} />
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

const pageStyle = { backgroundColor: '#f1f5f9', minHeight: '100vh', padding: '32px 20px', fontFamily: 'Inter, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif', color: '#1e293b' };
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
const statusLabelStyle = { fontSize: '12px', color: '#94a3b8', fontWeight: '500', letterSpacing: '0.05em' };
const statusValueStyle = { fontSize: '18px', fontWeight: '700', color: '#0f172a' };

const modelGridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: '16px', marginBottom: '28px' };
const twoColStyle = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '28px' };

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
const errorModelStyle = { color: '#475569', fontWeight: '600', whiteSpace: 'nowrap' };
const errorLatencyStyle = { color: '#94a3b8', fontSize: '12px', textAlign: 'right', minWidth: '60px' };

const emptyStateStyle = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px', gap: '8px' };
const footerStyle = { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', paddingTop: '20px', borderTop: '1px solid #e2e8f0' };
const footerLinkStyle = { color: '#6366f1', textDecoration: 'none', fontSize: '13px', fontWeight: '500' };
