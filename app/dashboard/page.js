'use client';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

// =============================================================================
// 工具函数
// =============================================================================
const REFRESH_INTERVAL = 30000;

const HTTP_STATUS_DESC = {
  400: '请求格式错误', 401: '认证失败/密钥无效', 403: '权限不足',
  404: '资源不存在', 408: '请求超时', 429: '请求过于频繁（限流）',
  500: '服务器内部错误', 502: '网关错误（上游异常）', 503: '服务暂不可用', 504: '网关超时（上游无响应）',
};

const MODEL_COLORS = {
  'gemma-4-31b-it': '#6366f1', 'gemma-4-26b-a4b-it': '#8b5cf6',
  'gemma-3-27b-it': '#a78bfa', 'gemma-3-12b-it': '#c4b5fd',
  'gemini-2.5-pro': '#ec4899', 'gemini-2.5-flash': '#10b981', 'default': '#6366f1'
};

const getModelColor = (id) => MODEL_COLORS[id] || MODEL_COLORS.default;

const formatTime = (iso) => {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return iso; }
};

const formatDate = (iso) => {
  try { return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }); }
  catch { return iso; }
};

const shortModel = (id) => id.replace('models/', '');
const getStatusDesc = (code) => HTTP_STATUS_DESC[code] || '';
const getStatusLabel = (code) => {
  if (!code) return { text: '未知', color: '#94a3b8' };
  if (code >= 500) return { text: '服务器错误', color: '#ef4444' };
  if (code >= 400) return { text: '客户端错误', color: '#f59e0b' };
  return { text: '成功', color: '#22c55e' };
};

const getTimeUntilReset = () => {
  const now = new Date();
  const reset = new Date(now); reset.setUTCHours(7, 0, 0, 0);
  if (now >= reset) reset.setUTCDate(reset.getUTCDate() + 1);
  const diffMs = reset - now;
  const totalSeconds = Math.floor(diffMs / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60
  };
};

const formatCountdown = (cd) =>
  String(cd.hours).padStart(2, '0') + ':' + String(cd.minutes).padStart(2, '0') + ':' + String(cd.seconds).padStart(2, '0');

// 数字格式化动画辅助
const formatNumber = (num) => num?.toLocaleString?.() ?? String(num);

// 格式化时间段（如 "2 小时 30 分"）
const formatDuration = (minutes) => {
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${Math.round(minutes)}分钟`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hours >= 24) {
    const days = (hours / 24).toFixed(1);
    return `${days}天`;
  }
  return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
};

// 计算配额耗尽预测（基于当前使用速率）
const predictQuotaExhaustion = (used, limit, hoursElapsed) => {
  if (!used || !limit || hoursElapsed <= 0) return null;
  const hourlyRate = used / hoursElapsed;
  if (hourlyRate <= 0) return null;
  const remaining = limit - used;
  if (remaining <= 0) return { exhausted: true, minutes: 0, rate: hourlyRate };
  const hoursUntilExhaustion = remaining / hourlyRate;
  const minutesUntilExhaustion = hoursUntilExhaustion * 60;
  return {
    exhausted: false,
    minutes: minutesUntilExhaustion,
    rate: hourlyRate,
    remaining,
  };
};

// 导出 CSV 数据
const exportToCSV = (data, filename) => {
  if (!data || data.length === 0) return;
  const headers = Object.keys(data[0]);
  const csvContent = [
    headers.join(','),
    ...data.map(row => headers.map(field => {
      const value = row[field];
      // 处理包含逗号或引号的字符串
      if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }).join(','))
  ].join('\n');
  
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
};

// =============================================================================
// 主题
// =============================================================================
const getTheme = (dark) => ({
  page: { 
    backgroundColor: dark ? '#0b1121' : '#f0f5ff', 
    color: dark ? '#e2e8f0' : '#0f172a',
    backgroundGradient: dark 
      ? 'radial-gradient(circle at 20% 30%, rgba(99,102,241,0.08) 0%, transparent 50%), radial-gradient(circle at 80% 70%, rgba(139,92,246,0.06) 0%, transparent 50%)'
      : 'radial-gradient(circle at 20% 30%, rgba(99,102,241,0.04) 0%, transparent 50%), radial-gradient(circle at 80% 70%, rgba(139,92,246,0.03) 0%, transparent 50%)'
  },
  card: {
    backgroundColor: dark ? '#131c31' : 'white',
    border: dark ? '1px solid rgba(99,102,241,0.15)' : '1px solid rgba(99,102,241,0.1)',
    boxShadow: dark ? '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)' : '0 4px 24px rgba(99,102,241,0.06), inset 0 1px 0 rgba(255,255,255,0.8)',
  },
  text: { main: dark ? '#f1f5f9' : '#0f172a', sub: dark ? '#94a3b8' : '#475569', muted: dark ? '#64748b' : '#94a3b8' },
  bar: { bg: dark ? '#1e293b' : '#f1f5f9' },
  input: { backgroundColor: dark ? '#0f172a' : 'white', border: dark ? '1px solid #1e293b' : '1px solid #e2e8f0', color: dark ? '#f1f5f9' : '#0f172a' },
  glow: dark ? '0 0 20px rgba(99,102,241,0.12)' : '0 0 20px rgba(99,102,241,0.08)',
  neonGlow: dark ? '0 0 8px rgba(99,102,241,0.4), 0 0 16px rgba(99,102,241,0.2)' : '0 0 8px rgba(99,102,241,0.2), 0 0 16px rgba(99,102,241,0.1)',
});

// =============================================================================
// SparklineChart — 带 tooltip 交互的折线图
// =============================================================================
function SparklineChart({ data, width = 700, height = 180, theme }) {
  const [hover, setHover] = useState(null);
  const t = theme || { text: { sub: '#94a3b8' }, card: { backgroundColor: '#1e293b' } };

  if (!data || data.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.text.sub, fontSize: '14px' }}>
        📊 暂无数据
      </div>
    );
  }

  const maxVal = Math.max(...data.map(d => d.count), 1);
  const padX = 50, padY = 28, rPad = 20;
  const chartW = width - padX - rPad;
  const chartH = height - padY * 2;
  const stepX = chartW / (Math.max(data.length - 1, 1));
  const points = data.map((d, i) => ({
    x: padX + i * stepX, y: padY + chartH - (d.count / maxVal) * chartH, ...d
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x},${padY + chartH} L${points[0].x},${padY + chartH} Z`;

  // Y 轴刻度
  const yTicks = 5;
  const yStep = chartH / yTicks;
  const yValues = [];
  for (let i = 0; i <= yTicks; i++) {
    yValues.push(Math.round((maxVal / yTicks) * (yTicks - i)));
  }

  // Tooltip
  const tip = hover !== null ? points[hover] : null;
  const tipW = 160, tipH = 64;
  const tipX = tip ? Math.min(Math.max(tip.x - tipW / 2, 4), width - tipW - 4) : 0;
  const tipY = tip ? Math.max(tip.y - tipH - 20, 4) : 0;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}
        style={{ display: 'block' }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const scaleX = width / rect.width;
          const mx = (e.clientX - rect.left) * scaleX;
          let closest = 0, minDist = Infinity;
          points.forEach((p, i) => { const d = Math.abs(p.x - mx); if (d < minDist) { minDist = d; closest = i; } });
          if (hover !== closest) setHover(closest);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0.02" />
          </linearGradient>
          <filter id="glowFilter">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Y 轴网格 */}
        {yValues.map((v, i) => (
          <g key={i}>
            <line x1={padX} y1={padY + i * yStep} x2={width - rPad} y2={padY + i * yStep}
              stroke={t.bar?.bg || '#e2e8f0'} strokeWidth="1" strokeDasharray="4 3" />
            <text x={padX - 8} y={padY + i * yStep + 4} textAnchor="end"
              fill={t.text?.sub || '#94a3b8'} fontSize="11" fontFamily="monospace">
              {v.toLocaleString()}
            </text>
          </g>
        ))}

        {/* 面积 */}
        <path d={areaPath} fill="url(#lineGrad)" />

        {/* 折线 */}
        <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" filter="url(#glowFilter)" />

        {/* X 轴标签 */}
        {points.filter((_, i) => i % 3 === 0 || i === data.length - 1).map((p, i) => (
          <text key={i} x={p.x} y={height - 4} textAnchor="middle"
            fill={t.text?.muted || '#94a3b8'} fontSize="10" fontFamily="monospace">{p.label}</text>
        ))}

        {/* 数据点 */}
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={hover === i ? 6 : 3}
            fill={hover === i ? '#4f46e5' : '#6366f1'}
            stroke={hover === i ? '#fff' : 'none'}
            strokeWidth="2"
            style={{ transition: 'r 0.15s, fill 0.15s', cursor: 'crosshair' }} />
        ))}

        {/* 当前小时高亮线 */}
        {(() => {
          const now = new Date();
          const curHour = (now.getUTCHours() + 8) % 24;
          const idx = data.findIndex(d => d.hour === curHour);
          if (idx >= 0) {
            const p = points[idx];
            return (
              <line x1={p.x} y1={padY} x2={p.x} y2={padY + chartH}
                stroke="#6366f1" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
            );
          }
          return null;
        })()}

        {/* Tooltip */}
        {tip && (
          <g>
            <rect x={tipX} y={tipY} width={tipW} height={tipH} rx="8"
              fill={darkCheck(t)} opacity="0.95" />
            <text x={tipX + tipW / 2} y={tipY + 18} textAnchor="middle"
              fill="#e2e8f0" fontSize="12" fontWeight="600">{tip.label}</text>
            <text x={tipX + tipW / 2} y={tipY + 36} textAnchor="middle"
              fill="#a5b4fc" fontSize="20" fontWeight="700" fontFamily="monospace">
              {tip.count.toLocaleString()}
            </text>
            <text x={tipX + tipW / 2} y={tipY + 52} textAnchor="middle"
              fill="#94a3b8" fontSize="10">次请求</text>
          </g>
        )}
      </svg>
    </div>
  );
}

const darkCheck = (t) => {
  const bg = t?.card?.backgroundColor || '#1e293b';
  return bg === '#1e293b' || bg === '#131c31' || bg.includes('13');
};

// =============================================================================
// 小组件
// =============================================================================
function MetricCard({ icon, label, value, sub, color, onClick, selected, theme }) {
  const isDark = darkCheck(theme);
  return (
    <div onClick={onClick}
      style={{
        background: selected ? `linear-gradient(135deg, ${color}15, ${color}08)` : theme.card.backgroundColor,
        border: selected ? `1.5px solid ${color}` : theme.card.border,
        borderRadius: '16px', padding: '18px 20px',
        boxShadow: selected ? `0 0 24px ${color}20, 0 4px 24px rgba(0,0,0,0.2)` : theme.card.boxShadow,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        position: 'relative', overflow: 'hidden',
      }}
      onMouseEnter={e => { 
        if (!selected) { 
          e.currentTarget.style.transform = 'translateY(-4px) scale(1.02)'; 
          e.currentTarget.style.boxShadow = theme.glow; 
          e.currentTarget.style.borderColor = `${color}60`;
        } 
      }}
      onMouseLeave={e => { 
        if (!selected) { 
          e.currentTarget.style.transform = 'translateY(0) scale(1)'; 
          e.currentTarget.style.boxShadow = theme.card.boxShadow; 
          e.currentTarget.style.borderColor = theme.card.border;
        } 
      }}
    >
      {/* 顶部装饰条 */}
      {selected && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', backgroundColor: color, borderRadius: '16px 16px 0 0' }} />}
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: '24px', opacity: 0.9, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.2))' }}>{icon}</span>
        <span style={{
          fontSize: '26px', fontWeight: '800', color, fontFamily: 'monospace', letterSpacing: '-0.03em',
          textShadow: selected ? `0 0 20px ${color}40` : 'none',
          transition: 'all 0.3s ease'
        }}>{value}</span>
      </div>
      <div style={{ marginTop: '8px', fontSize: '13px', fontWeight: '600', color: theme.text.main }}>{label}</div>
      {sub && <div style={{ fontSize: '11px', color: theme.text.muted, marginTop: '3px' }}>{sub}</div>}
    </div>
  );
}

function ProgressBar({ label, value, max, color, theme }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ marginBottom: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '13px' }}>
        <span style={{ fontWeight: '600', color: theme.text.main, letterSpacing: '0.02em' }}>{label}</span>
        <span style={{ fontFamily: 'monospace', color: theme.text.sub, fontWeight: '500' }}>{value.toLocaleString()}</span>
      </div>
      <div style={{ 
        backgroundColor: theme.bar.bg, 
        height: '8px', 
        borderRadius: '4px', 
        overflow: 'hidden',
        boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.1)',
      }}>
        <div style={{ 
          height: '100%', 
          width: `${pct}%`, 
          backgroundColor: color, 
          borderRadius: '4px', 
          transition: 'width 0.8s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: `0 0 10px ${color}60`,
          position: 'relative'
        }}>
          {/* 进度条高光效果 */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
            animation: 'shimmer 2s infinite',
          }} />
        </div>
      </div>
    </div>
  );
}

function LogRow({ time, badge, label, sub, color, badgeColor, theme }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px',
      borderRadius: '10px', backgroundColor: theme.bar.bg,
      fontSize: '12px', fontFamily: 'monospace', marginBottom: '6px',
      transition: 'all 0.2s ease',
      border: `1px solid transparent`,
    }}
    onMouseEnter={e => {
      e.currentTarget.style.borderColor = `${color}30`;
      e.currentTarget.style.backgroundColor = `${color}08`;
    }}
    onMouseLeave={e => {
      e.currentTarget.style.borderColor = 'transparent';
      e.currentTarget.style.backgroundColor = theme.bar.bg;
    }}
    >
      <span style={{ color: theme.text.muted, fontSize: '11px', minWidth: '70px', flexShrink: 0, fontFamily: 'monospace' }}>{time}</span>
      <span style={{
        padding: '2px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: '700',
        backgroundColor: (badgeColor || color) + '18',
        color: badgeColor || color, border: '1px solid ' + (badgeColor || color) + '40',
        minWidth: '36px', textAlign: 'center', flexShrink: 0,
        boxShadow: '0 0 8px ' + (badgeColor || color) + '30',
      }}>{badge}</span>
      <span style={{ color: theme.text.main, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '500' }}>{label}</span>
      {sub && <span style={{ color: theme.text.muted, textAlign: 'right', flexShrink: 0, fontFamily: 'monospace' }}>{sub}</span>}
    </div>
  );
}

function EmptyCard({ emoji, text, theme }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '40px', color: theme.text.muted, gap: '8px'
    }}>
      <span style={{ fontSize: '28px' }}>{emoji}</span>
      <span style={{ fontSize: '13px' }}>{text}</span>
    </div>
  );
}

// =============================================================================
// 主组件
// =============================================================================
export default function DashboardPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  
  const [dark, setDark] = useState(() => {
    // 优先从 URL 恢复，其次从 localStorage
    const fromUrl = searchParams.get('dark');
    if (fromUrl === '1') return true;
    const saved = localStorage.getItem('dashboard_dark');
    return saved === 'true';
  });
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
  const [authError, setAuthError] = useState('');
  const [countdown, setCountdown] = useState(getTimeUntilReset());
  const [collapsedSections, setCollapsedSections] = useState(() => {
    const fromUrl = searchParams.get('collapsed');
    if (fromUrl) {
      try { return JSON.parse(fromUrl); } catch { return {}; }
    }
    return {};
  });
  const [exporting, setExporting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState(null);
  const [refreshProgress, setRefreshProgress] = useState(0);

  const theme = getTheme(dark);

  // 倒计时每秒更新
  useEffect(() => {
    const timer = setInterval(() => setCountdown(getTimeUntilReset()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 刷新进度条（30 秒倒计时）
  useEffect(() => {
    if (!authed) return;
    let progress = 0;
    const interval = REFRESH_INTERVAL / 100; // 100 步
    const timer = setInterval(() => {
      progress += 1;
      setRefreshProgress(Math.min(progress, 100));
      if (progress >= 100) {
        progress = 0;
      }
    }, interval);
    return () => clearInterval(timer);
  }, [authed]);

  // 从 localStorage 恢复暗色模式和密码（仅当 URL 没有时）
  useEffect(() => {
    const saved = localStorage.getItem('dashboard_token');
    if (saved && !searchParams.get('authed')) { setPassword(saved); setAuthed(true); }
    // dark 已经从 useState 初始化时处理了
  }, [searchParams]);

  // 同步状态到 URL（暗色模式、折叠状态）
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    
    // 同步 dark
    if (dark) params.set('dark', '1');
    else params.delete('dark');
    
    // 同步 collapsedSections
    const hasCollapsed = Object.values(collapsedSections).some(v => v);
    if (hasCollapsed) {
      params.set('collapsed', JSON.stringify(collapsedSections));
    } else {
      params.delete('collapsed');
    }
    
    // 只有当 URL 真正变化时才 replace
    const newSearch = params.toString();
    if (window.location.search !== newSearch) {
      router.replace(`?${newSearch}`, { scroll: false });
    }
  }, [dark, collapsedSections, router, searchParams]);

  const handleLogin = async (e) => {
    e?.preventDefault();
    setAuthError('');
    try {
      const res = await fetch('/api/quota', { headers: { Authorization: `Bearer ${password}` } });
      if (res.ok) { localStorage.setItem('dashboard_token', password); setAuthed(true); }
      else { setAuthError('密码错误'); }
    } catch { setAuthError('连接失败'); }
  };

  const authFetch = useCallback(async (url) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${password}` } });
    if (res.status === 401) { localStorage.removeItem('dashboard_token'); setAuthed(false); return null; }
    return res;
  }, [password]);

  const fetchData = useCallback(async () => {
    if (!authed) return;
    setRefreshing(true);
    setLastRefreshTime(new Date());
    try {
      const [q, h, e, t, c, r] = await Promise.all([
        authFetch('/api/quota').then(r => r?.json()),
        authFetch('/api/health').then(r => r?.json()).catch(() => null),
        authFetch('/api/errors').then(r => r?.json()).catch(() => null),
        authFetch('/api/timeline').then(r => r?.json()).catch(() => null),
        authFetch('/api/clients').then(r => r?.json()).catch(() => null),
        authFetch('/api/recent').then(r => r?.json()).catch(() => null),
      ]);
      if (!q && !h && !e && !t && !c && !r) return;
      setQuota(q); setHealth(h); setErrors(e); setTimeline(t); setClients(c); setRecent(r);
    } catch (err) { console.error(err); }
    finally { setRefreshing(false); setLoading(false); }
  }, [authed, authFetch]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchData]);

  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    localStorage.setItem('dashboard_dark', next);
  };

  const toggleSection = (key) => {
    setCollapsedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // 导出数据功能
  const handleExport = useCallback((type) => {
    setExporting(true);
    setShowExportMenu(false);
    
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      
      if (type === 'quota') {
        // 导出配额数据
        const exportData = quota?.data?.map(d => ({
          model: shortModel(d.model),
          used: d.used,
          limit: d.limit,
          percent: d.percent.toFixed(2) + '%',
          avgLatency: d.avgLatency ? `${d.avgLatency}ms` : 'N/A',
        })) || [];
        exportToCSV(exportData, `配额数据_${timestamp}.csv`);
      } else if (type === 'timeline') {
        // 导出时间线数据
        const exportData = timeline?.timeline?.map(d => ({
          hour: d.label,
          requests: d.count,
        })) || [];
        exportToCSV(exportData, `时间线_${timestamp}.csv`);
      } else if (type === 'errors') {
        // 导出错误日志
        const exportData = errors?.errors?.slice(0, 100).map(e => ({
          time: formatTime(e.ts),
          status: e.status,
          model: shortModel(e.model),
          message: e.message || '',
          latency: e.latency ? `${e.latency}ms` : 'N/A',
        })) || [];
        exportToCSV(exportData, `错误日志_${timestamp}.csv`);
      } else if (type === 'all') {
        // 导出所有数据（JSON 格式）
        const exportData = {
          exportTime: new Date().toISOString(),
          quotaData: quota?.data?.map(d => ({
            model: shortModel(d.model),
            used: d.used,
            limit: d.limit,
            percent: d.percent,
            avgLatency: d.avgLatency,
          })),
          timelineData: timeline?.timeline,
          errorStats: {
            totalErrors: errors?.count,
            errors: errors?.errors?.slice(0, 100),
          },
          clientStats: clients?.clients,
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `完整数据_${timestamp}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
      }
    } catch (err) {
      console.error('导出失败:', err);
    } finally {
      setExporting(false);
    }
  }, [quota, timeline, errors, clients]);

  // 派生数据
  const modelDistribution = useMemo(() => {
    if (!quota?.data) return [];
    return quota.data.map((d, i) => ({
      label: shortModel(d.model), value: d.used, max: Math.max(...quota.data.map(x => x.used), 1),
      color: getModelColor(d.model), rawModel: d.model, avgLatency: d.avgLatency, percent: d.percent, limit: d.limit
    })).sort((a, b) => b.value - a.value);
  }, [quota]);

  // 配额预测（基于当前使用速率）
  const quotaPredictions = useMemo(() => {
    if (!quota?.data) return {};
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const quotaDate = today.split('-').slice(1).join(''); // MMDD
    // 计算从今天 00:00 到现在经过了多少小时
    const startOfDay = new Date(today + 'T00:00:00');
    const hoursElapsed = Math.max((now - startOfDay) / (1000 * 60 * 60), 0.5); // 至少按 0.5 小时算
    
    const predictions = {};
    quota.data.forEach(d => {
      const prediction = predictQuotaExhaustion(d.used, d.limit, hoursElapsed);
      if (prediction) {
        predictions[d.model] = {
          ...prediction,
          formatted: formatDuration(prediction.minutes),
          exhausted: prediction.exhausted || prediction.remaining <= 0,
        };
      }
    });
    return predictions;
  }, [quota]);

  const filteredRecent = useMemo(() => {
    if (!selectedModel || !recent?.recent) return recent?.recent || [];
    return recent.recent.filter(r => shortModel(r.model) === selectedModel || r.model === selectedModel);
  }, [selectedModel, recent]);

  const retryCount = recent?.retries || 0;
  const globalRequests = quota?.globalRequests || 0;
  const errorCount = errors?.count || 0;
  const errorRate = globalRequests > 0 ? ((errorCount / globalRequests) * 100).toFixed(2) : '0.00';
  const avgLatency = health?.avgLatency || quota?.data?.reduce((s, d) => s + (d.avgLatency || 0), 0) / Math.max(quota?.data?.length || 1, 1) || null;

  const peakHour = timeline?.timeline?.length
    ? timeline.timeline.reduce((a, b) => b.count > a.count ? b : a, { count: 0 }) : null;

  const successCount = globalRequests - errorCount;

  // ============= 登录页 =============
  if (!authed) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(135deg, #0b1121 0%, #1a1f3a 30%, #0f172a 70%, #0b1121 100%)',
        position: 'relative', overflow: 'hidden'
      }}>
        {/* 背景装饰光晕 */}
        <div style={{
          position: 'absolute', top: '-30%', right: '-20%', width: '800px', height: '800px',
          borderRadius: '50%', background: 'radial-gradient(circle, rgba(99,102,241,0.15) 0%, transparent 60%)',
          pointerEvents: 'none', animation: 'pulse-glow 8s ease-in-out infinite'
        }} />
        <div style={{
          position: 'absolute', bottom: '-40%', left: '-10%', width: '600px', height: '600px',
          borderRadius: '50%', background: 'radial-gradient(circle, rgba(139,92,246,0.12) 0%, transparent 60%)',
          pointerEvents: 'none', animation: 'pulse-glow 6s ease-in-out infinite reverse'
        }} />
        
        {/* 网格背景 */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `
            linear-gradient(rgba(99,102,241,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(99,102,241,0.03) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
          pointerEvents: 'none',
          maskImage: 'radial-gradient(circle at center, black 0%, transparent 70%)'
        }} />
        
        <div style={{
          background: 'rgba(19,28,49,0.8)', backdropFilter: 'blur(24px)',
          padding: '56px 48px', borderRadius: '24px', border: '1px solid rgba(99,102,241,0.3)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6), 0 0 40px rgba(99,102,241,0.1), inset 0 1px 0 rgba(255,255,255,0.1)',
          width: '100%', maxWidth: '400px',
          position: 'relative', zIndex: 1,
          animation: 'slide-up 0.6s ease-out'
        }}>
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <div style={{ 
              fontSize: '48px', marginBottom: '12px', 
              filter: 'drop-shadow(0 0 20px rgba(99,102,241,0.4))',
              animation: 'float 3s ease-in-out infinite'
            }}>🛡️</div>
            <h2 style={{ color: '#f1f5f9', margin: 0, fontSize: '24px', fontWeight: '700', letterSpacing: '-0.02em' }}>代理监控控制台</h2>
            <p style={{ color: '#64748b', fontSize: '14px', marginTop: '8px', fontWeight: '500' }}>Gemini Transparent Proxy</p>
            <div style={{ 
              fontSize: '11px', color: '#475569', marginTop: '12px', 
              padding: '4px 12px', borderRadius: '20px',
              backgroundColor: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)',
              display: 'inline-block'
            }}>
              🔒 安全访问
            </div>
          </div>
          <form onSubmit={handleLogin}>
            <div style={{ position: 'relative', marginBottom: '12px' }}>
              <input 
                type="password" 
                value={password} 
                onChange={e => setPassword(e.target.value)}
                placeholder="输入访问密码" 
                autoFocus
                style={{
                  width: '100%', padding: '14px 18px',
                  borderRadius: '12px', border: '1px solid rgba(99,102,241,0.3)',
                  background: 'rgba(15,23,42,0.6)', color: '#f1f5f9',
                  fontSize: '14px', outline: 'none', boxSizing: 'border-box',
                  transition: 'all 0.2s ease',
                  boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.3)',
                }}
                onFocus={e => {
                  e.target.style.borderColor = '#6366f1';
                  e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.15), inset 0 1px 3px rgba(0,0,0,0.3)';
                }}
                onBlur={e => {
                  e.target.style.borderColor = 'rgba(99,102,241,0.3)';
                  e.target.style.boxShadow = 'inset 0 1px 3px rgba(0,0,0,0.3)';
                }}
              />
            </div>
            {authError && (
              <div style={{ 
                color: '#ef4444', fontSize: '13px', marginBottom: '12px',
                padding: '8px 12px', borderRadius: '8px',
                backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                display: 'flex', alignItems: 'center', gap: '6px',
                animation: 'shake 0.4s ease-in-out'
              }}>
                <span>⚠️</span> {authError}
              </div>
            )}
            <button type="submit"
              style={{
                width: '100%', padding: '14px', border: 'none', borderRadius: '12px',
                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #6366f1 100%)',
                backgroundSize: '200% 100%',
                color: 'white', fontSize: '15px', fontWeight: '600', cursor: 'pointer',
                transition: 'all 0.3s ease',
                boxShadow: '0 4px 16px rgba(99,102,241,0.4), 0 0 20px rgba(99,102,241,0.2)',
                letterSpacing: '0.02em',
              }}
              onMouseEnter={e => {
                e.target.style.backgroundPosition = 'right center';
                e.target.style.transform = 'translateY(-2px)';
                e.target.style.boxShadow = '0 6px 20px rgba(99,102,241,0.5), 0 0 30px rgba(99,102,241,0.3)';
              }}
              onMouseLeave={e => {
                e.target.style.backgroundPosition = 'left center';
                e.target.style.transform = 'translateY(0)';
                e.target.style.boxShadow = '0 4px 16px rgba(99,102,241,0.4), 0 0 20px rgba(99,102,241,0.2)';
              }}
            >
              进入控制台 ✨
            </button>
          </form>
          <div style={{
            marginTop: '20px', paddingTop: '16px', borderTop: '1px solid rgba(99,102,241,0.15)',
            textAlign: 'center', fontSize: '12px', color: '#475569'
          }}>
            <span>实时监控 · 智能分析 · 配额管理</span>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ ...theme.page, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: '40px', height: '40px', margin: '0 auto 16px',
            border: '3px solid rgba(99,102,241,0.2)', borderTopColor: '#6366f1',
            borderRadius: '50%', animation: 'spin 0.8s linear infinite'
          }} />
          <p style={{ color: theme.text.sub }}>正在加载控制台…</p>
        </div>
      </div>
    );
  }

  // ============= 主界面 =============
  return (
    <div style={{
      ...theme.page, 
      minHeight: '100vh',
      padding: '0', 
      fontFamily: '"Inter", system-ui, -apple-system, "PingFang SC", sans-serif',
      backgroundImage: theme.page.backgroundGradient,
      backgroundAttachment: 'fixed',
    }}>
      {/* 背景装饰 - 保留但简化 */}
      <div style={{
        position: 'fixed', top: '-50%', right: '-20%', width: '600px', height: '600px',
        borderRadius: '50%', background: 'radial-gradient(circle, rgba(99,102,241,0.05) 0%, transparent 70%)',
        pointerEvents: 'none', zIndex: 0
      }} />
      <div style={{
        position: 'fixed', bottom: '-30%', left: '-10%', width: '400px', height: '400px',
        borderRadius: '50%', background: 'radial-gradient(circle, rgba(139,92,246,0.04) 0%, transparent 70%)',
        pointerEvents: 'none', zIndex: 0
      }} />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: '1360px', margin: '0 auto', padding: '28px 24px' }}>
        {/* ====== 顶部导航 ====== */}
        <header style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: '28px', paddingBottom: '20px',
          borderBottom: `1px solid ${dark ? 'rgba(99,102,241,0.1)' : 'rgba(99,102,241,0.08)'}`,
          position: 'relative'
        }}>
          {/* 刷新进度条 */}
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: '2px',
            backgroundColor: theme.bar.bg,
            borderRadius: '2px',
            overflow: 'hidden'
          }}>
            <div style={{
              width: `${refreshProgress}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
              transition: 'width 0.3s linear',
            }} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{
                width: '10px', height: '10px', borderRadius: '50%',
                backgroundColor: health?.status === 'ok' ? '#22c55e' : '#ef4444',
                boxShadow: `0 0 12px ${health?.status === 'ok' ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)'}`,
                animation: health?.status === 'ok' ? 'pulse-glow 2s ease-in-out infinite' : 'none'
              }} />
              <h1 style={{ fontSize: '28px', fontWeight: '800', margin: 0, color: theme.text.main, letterSpacing: '-0.03em' }}>
                Gemini <span style={{ 
                  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text'
                }}>代理</span>
              </h1>
            </div>
            <p style={{ color: theme.text.muted, fontSize: '13px', margin: '4px 0 0', fontWeight: '500' }}>
              实时监控 · 智能分析 · 配额管理
            </p>
            {lastRefreshTime && (
              <p style={{ color: theme.text.muted, fontSize: '11px', margin: '6px 0 0', fontFamily: 'monospace' }}>
                上次刷新：{lastRefreshTime.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ 
              fontSize: '12px', 
              color: theme.text.muted, 
              fontFamily: 'monospace',
              padding: '6px 10px',
              borderRadius: '8px',
              backgroundColor: theme.bar.bg,
              border: `1px solid ${dark ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.1)'}`,
            }}>
              {new Date().toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
            <button onClick={toggleDark} title={dark ? '切换亮色模式' : '切换暗色模式'}
              style={{
                width: '38px', height: '38px', borderRadius: '12px',
                border: theme.card.border, backgroundColor: theme.card.backgroundColor,
                cursor: 'pointer', fontSize: '18px', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.2s ease',
                boxShadow: theme.card.boxShadow,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.transform = 'scale(1.1)';
                e.currentTarget.style.boxShadow = theme.glow;
              }}
              onMouseLeave={e => {
                e.currentTarget.style.transform = 'scale(1)';
                e.currentTarget.style.boxShadow = theme.card.boxShadow;
              }}
            >{dark ? '☀️' : '🌙'}</button>
            <button onClick={fetchData} title={refreshing ? '刷新中...' : '刷新数据'}
              style={{
                width: '38px', height: '38px', borderRadius: '12px',
                border: theme.card.border, backgroundColor: theme.card.backgroundColor,
                cursor: refreshing ? 'not-allowed' : 'pointer', fontSize: '18px', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.2s ease',
                boxShadow: theme.card.boxShadow,
                opacity: refreshing ? 0.6 : 1,
                animation: refreshing ? 'spin 1s linear infinite' : 'none',
              }}
              onMouseEnter={e => {
                if (!refreshing) {
                  e.currentTarget.style.transform = 'scale(1.1) rotate(180deg)';
                  e.currentTarget.style.boxShadow = theme.glow;
                }
              }}
              onMouseLeave={e => {
                if (!refreshing) {
                  e.currentTarget.style.transform = 'scale(1) rotate(0deg)';
                  e.currentTarget.style.boxShadow = theme.card.boxShadow;
                }
              }}
            >{refreshing ? '⏳' : '⟳'}</button>
            
            {/* 导出按钮 */}
            <div style={{ position: 'relative' }}>
              <button 
                onClick={() => setShowExportMenu(!showExportMenu)}
                disabled={exporting}
                title="导出数据"
                style={{
                  width: '38px', height: '38px', borderRadius: '12px',
                  border: theme.card.border, 
                  backgroundColor: exporting ? theme.bar.bg : theme.card.backgroundColor,
                  cursor: exporting ? 'not-allowed' : 'pointer', 
                  fontSize: '18px', 
                  display: 'flex',
                  alignItems: 'center', 
                  justifyContent: 'center',
                  transition: 'all 0.2s ease',
                  boxShadow: theme.card.boxShadow,
                  opacity: exporting ? 0.6 : 1,
                }}
                onMouseEnter={e => {
                  if (!exporting) {
                    e.currentTarget.style.transform = 'scale(1.1)';
                    e.currentTarget.style.boxShadow = theme.glow;
                  }
                }}
                onMouseLeave={e => {
                  if (!exporting) {
                    e.currentTarget.style.transform = 'scale(1)';
                    e.currentTarget.style.boxShadow = theme.card.boxShadow;
                  }
                }}
              >
                {exporting ? '⏳' : '📥'}
              </button>
              
              {/* 导出菜单 */}
              {showExportMenu && (
                <div style={{
                  position: 'absolute',
                  top: '48px',
                  right: 0,
                  zIndex: 100,
                  minWidth: '180px',
                  backgroundColor: theme.card.backgroundColor,
                  border: theme.card.border,
                  borderRadius: '12px',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.2), ' + theme.glow,
                  padding: '8px',
                  animation: 'slide-up 0.2s ease-out',
                }}>
                  <div style={{ 
                    fontSize: '11px', 
                    fontWeight: '700', 
                    color: theme.text.muted, 
                    padding: '8px 12px 6px',
                    borderBottom: `1px solid ${theme.bar.bg}`,
                    marginBottom: '4px',
                  }}>导出数据</div>
                  {[
                    { type: 'quota', label: '配额数据', icon: '📊' },
                    { type: 'timeline', label: '时间线', icon: '📈' },
                    { type: 'errors', label: '错误日志', icon: '⚠️' },
                    { type: 'all', label: '完整数据 (JSON)', icon: '💾' },
                  ].map(item => (
                    <button
                      key={item.type}
                      onClick={() => handleExport(item.type)}
                      disabled={exporting}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '10px 12px',
                        margin: '4px 0',
                        border: 'none',
                        borderRadius: '8px',
                        backgroundColor: 'transparent',
                        color: theme.text.main,
                        fontSize: '13px',
                        cursor: exporting ? 'not-allowed' : 'pointer',
                        transition: 'all 0.2s ease',
                        textAlign: 'left',
                      }}
                      onMouseEnter={e => {
                        if (!exporting) {
                          e.currentTarget.style.backgroundColor = theme.bar.bg;
                          e.currentTarget.style.transform = 'translateX(4px)';
                        }
                      }}
                      onMouseLeave={e => {
                        if (!exporting) {
                          e.currentTarget.style.backgroundColor = 'transparent';
                          e.currentTarget.style.transform = 'translateX(0)';
                        }
                      }}
                    >
                      <span style={{ fontSize: '16px' }}>{item.icon}</span>
                      <span style={{ flex: 1 }}>{item.label}</span>
                      {exporting && <span style={{ fontSize: '12px', color: theme.text.muted }}>⏳</span>}
                    </button>
                  ))}
                  <button
                    onClick={() => setShowExportMenu(false)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      marginTop: '4px',
                      border: 'none',
                      borderRadius: '8px',
                      backgroundColor: 'transparent',
                      color: theme.text.muted,
                      fontSize: '12px',
                      cursor: 'pointer',
                      textAlign: 'center',
                    }}
                    onMouseEnter={e => e.currentTarget.style.color = theme.text.main}
                    onMouseLeave={e => e.currentTarget.style.color = theme.text.muted}
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* ====== 核心指标行 ====== */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '14px', marginBottom: '24px'
        }}>
          <MetricCard icon="📡" label="总请求数" value={formatNumber(globalRequests)}
            sub={`今日累计`} color="#6366f1" theme={theme} />
          <MetricCard icon="✅" label="成功请求" value={formatNumber(successCount)}
            sub={`成功率 ${successCount > 0 ? ((successCount / globalRequests) * 100).toFixed(1) : '100'}%`}
            color="#22c55e" theme={theme} />
          <MetricCard icon="⚠️" label="错误数" value={formatNumber(errorCount)}
            sub={`错误率 ${errorRate}%`}
            color={errorCount > 0 ? '#ef4444' : '#22c55e'} 
            theme={theme} 
            style={errorCount > 0 && errorRate > 5 ? { animation: 'pulse-glow 2s ease-in-out infinite' } : {}}
          />
          <MetricCard icon="⏱️" label="平均延迟" value={avgLatency ? `${Math.round(avgLatency)}ms` : '—'}
            sub="所有模型综合" color="#f59e0b" theme={theme} />
          <MetricCard icon="🔄" label="配额重置" value={formatCountdown(countdown)}
            sub="UTC+8 07:00 重置" color="#8b5cf6" theme={theme} />
        </div>

        {/* ====== 双列布局 ====== */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>

          {/* 请求时间线 */}
          <div style={{ borderRadius: '16px', padding: '20px', ...theme.card }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: '700', color: theme.text.main, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                📊 请求时间线
                {timeline?.date && <span style={{ fontSize: '11px', fontWeight: '400', color: theme.text.muted }}>{timeline.date}</span>}
              </h2>
              {peakHour && peakHour.count > 0 && (
                <span style={{
                  fontSize: '11px', padding: '3px 10px', borderRadius: '20px',
                  backgroundColor: '#6366f118', color: '#6366f1', border: '1px solid #6366f130',
                  fontWeight: '600'
                }}>
                  峰值 {peakHour.label} · {peakHour.count}次
                </span>
              )}
            </div>
            <SparklineChart data={timeline?.timeline || []} theme={theme} />
            <div style={{ display: 'flex', gap: '16px', marginTop: '12px', fontSize: '12px', color: theme.text.muted }}>
              <span>📈 最大流量: {peakHour?.count?.toLocaleString() || 0} 次/h</span>
              <span>📉 今日总计: {(timeline?.timeline?.reduce((s, d) => s + d.count, 0) || 0).toLocaleString()} 次</span>
            </div>
          </div>

          {/* 模型分布 */}
          <div style={{ borderRadius: '16px', padding: '20px', ...theme.card }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: '700', color: theme.text.main, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                🧬 模型路由分布
                {quota?.data && <span style={{ fontSize: '11px', fontWeight: '400', color: theme.text.muted }}>共 {quota.data.length} 个模型</span>}
              </h2>
            </div>
            <div style={{ maxHeight: '280px', overflowY: 'auto', paddingRight: '4px', scrollbarWidth: 'thin' }}>
              {modelDistribution.length > 0 ? modelDistribution.map((d, i) => (
                <ProgressBar key={i} label={d.label} value={d.value} max={d.max} color={d.color} theme={theme} />
              )) : <EmptyCard emoji="📭" text="暂无模型数据" theme={theme} />}
            </div>
            {quota?.globalErrorRate > 0 && (
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${theme.bar.bg}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: theme.text.muted }}>
                  <span>🌐 全局错误率</span>
                  <span style={{ fontWeight: '600', color: quota.globalErrorRate > 5 ? '#ef4444' : '#22c55e' }}>
                    {quota.globalErrorRate}%
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ====== 模型配额监控 ====== */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: '700', color: theme.text.main, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              ⚡ 模型配额监控
              {quota?.data?.some(m => m.percent > 90) && (
                <span style={{
                  fontSize: '10px', padding: '2px 8px', borderRadius: '12px',
                  backgroundColor: 'rgba(239,68,68,0.15)', color: '#ef4444',
                  border: '1px solid rgba(239,68,68,0.3)', fontWeight: '700',
                  display: 'flex', alignItems: 'center', gap: '4px',
                  animation: 'pulse-glow 2s ease-in-out infinite'
                }}>
                  ⚠ 配额告警
                </span>
              )}
            </h2>
            {selectedModel && (
              <button onClick={() => setSelectedModel(null)}
                style={{
                  fontSize: '12px', padding: '4px 12px', borderRadius: '20px',
                  border: `1px solid ${theme.text.muted}40`, background: 'transparent',
                  color: theme.text.muted, cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={e => {
                  e.target.style.background = theme.bar.bg;
                  e.target.style.borderColor = theme.text.muted;
                }}
                onMouseLeave={e => {
                  e.target.style.background = 'transparent';
                  e.target.style.borderColor = `${theme.text.muted}40`;
                }}
              >清除筛选 ✕</button>
            )}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '12px'
          }}>
            {quota?.data?.map((item, i) => {
              const color = getModelColor(item.model);
              const pct = Math.min(item.percent, 100);
              const isSelected = selectedModel === shortModel(item.model);
              const isHigh = pct > 90;
              const isMedium = pct > 70;
              const barColor = isHigh ? '#ef4444' : isMedium ? '#f59e0b' : color;
              const warningLevel = isHigh ? 'critical' : isMedium ? 'warning' : 'normal';
              return (
                <div key={i}
                  onClick={() => setSelectedModel(isSelected ? null : shortModel(item.model))}
                  style={{
                    borderRadius: '16px', padding: '18px', cursor: 'pointer',
                    background: isSelected ? `linear-gradient(135deg, ${color}12, ${color}06)` : theme.card.backgroundColor,
                    border: isSelected 
                      ? `2px solid ${color}` 
                      : isHigh 
                        ? `2px solid rgba(239,68,68,0.4)` 
                        : theme.card.border,
                    boxShadow: isSelected 
                      ? `0 0 24px ${color}12` 
                      : isHigh
                        ? `0 0 20px rgba(239,68,68,0.2), 0 4px 24px rgba(0,0,0,0.2)`
                        : theme.card.boxShadow,
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    position: 'relative',
                  }}
                  onMouseEnter={e => { 
                    if (!isSelected) { 
                      e.currentTarget.style.transform = 'translateY(-4px) scale(1.02)'; 
                      e.currentTarget.style.borderColor = isHigh ? '#ef4444' : `${color}60`; 
                    } 
                  }}
                  onMouseLeave={e => { 
                    if (!isSelected) { 
                      e.currentTarget.style.transform = 'translateY(0) scale(1)'; 
                      e.currentTarget.style.borderColor = isHigh ? 'rgba(239,68,68,0.4)' : theme.card.border; 
                    } 
                  }}
                >
                  {/* 配额告警角标 */}
                  {isHigh && (
                    <div style={{
                      position: 'absolute', top: '10px', right: '10px',
                      width: '8px', height: '8px', borderRadius: '50%',
                      backgroundColor: '#ef4444',
                      boxShadow: '0 0 12px rgba(239,68,68,0.6)',
                      animation: 'pulse-glow 1s ease-in-out infinite'
                    }} />
                  )}
                  {isSelected && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', background: `linear-gradient(90deg, ${color}, ${color}60)`, borderRadius: '16px 16px 0 0' }} />}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <div style={{ fontSize: '13px', fontWeight: '700', color: theme.text.main, fontFamily: 'monospace' }}>
                      {shortModel(item.model)}
                    </div>
                    <div style={{
                      fontSize: '20px', fontWeight: '800',
                      color: barColor, fontFamily: 'monospace', letterSpacing: '-0.02em'
                    }}>
                      {pct.toFixed(1)}<span style={{ fontSize: '12px', fontWeight: '600' }}>%</span>
                    </div>
                  </div>
                  <div style={{
                    backgroundColor: theme.bar.bg, height: '6px', borderRadius: '3px',
                    overflow: 'hidden', marginBottom: '10px'
                  }}>
                    <div style={{
                      height: '100%', width: `${pct}%`,
                      background: `linear-gradient(90deg, ${barColor}, ${isHigh ? '#dc2626' : isMedium ? '#d97706' : `${color}80`})`,
                      borderRadius: '3px', transition: 'width 0.8s ease'
                    }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: theme.text.muted }}>
                    <span>{(item.used || 0).toLocaleString()} / {(item.limit || '∞').toLocaleString()}</span>
                    <span>{item.limit - (item.used || 0) > 0 ? `余 ${(item.limit - (item.used || 0)).toLocaleString()}` : '已耗尽'}</span>
                  </div>
                  
                  {/* 配额预测 */}
                  {quotaPredictions[item.model] && !quotaPredictions[item.model].exhausted && (
                    <div style={{
                      marginTop: '8px',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      backgroundColor: quotaPredictions[item.model].minutes < 120 
                        ? 'rgba(239,68,68,0.1)' 
                        : quotaPredictions[item.model].minutes < 240
                          ? 'rgba(245,158,11,0.1)'
                          : 'rgba(34,197,94,0.1)',
                      border: `1px solid ${
                        quotaPredictions[item.model].minutes < 120 
                          ? 'rgba(239,68,68,0.3)' 
                          : quotaPredictions[item.model].minutes < 240
                            ? 'rgba(245,158,11,0.3)'
                            : 'rgba(34,197,94,0.3)'
                      }`,
                      fontSize: '11px',
                      color: quotaPredictions[item.model].minutes < 120 
                        ? '#ef4444' 
                        : quotaPredictions[item.model].minutes < 240
                          ? '#f59e0b'
                          : '#22c55e',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}>
                      <span>🔮</span>
                      <span style={{ fontWeight: '600' }}>预计耗尽:</span>
                      <span>{quotaPredictions[item.model].formatted}</span>
                    </div>
                  )}
                  {quotaPredictions[item.model]?.exhausted && (
                    <div style={{
                      marginTop: '8px',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      backgroundColor: 'rgba(239,68,68,0.15)',
                      border: '1px solid rgba(239,68,68,0.3)',
                      fontSize: '11px',
                      color: '#ef4444',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontWeight: '700',
                    }}>
                      <span>⚠️</span>
                      <span>配额已耗尽或今日无法用完</span>
                    </div>
                  )}
                  
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: '3px',
                      padding: '2px 8px', borderRadius: '4px', fontSize: '11px',
                      backgroundColor: `${color}12`, color, border: `1px solid ${color}25`
                    }}>
                      📡 {(item.used || 0).toLocaleString()}
                    </span>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: '3px',
                      padding: '2px 8px', borderRadius: '4px', fontSize: '11px',
                      backgroundColor: '#f59e0b12', color: item.avgLatency > 3000 ? '#ef4444' : '#f59e0b',
                      border: `1px solid ${item.avgLatency > 3000 ? '#ef444425' : '#f59e0b25'}`
                    }}>
                      ⏱ {item.avgLatency ? `${item.avgLatency}ms` : '—'}
                    </span>
                    {item.errorRate > 0 && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '3px',
                        padding: '2px 8px', borderRadius: '4px', fontSize: '11px',
                        backgroundColor: '#ef444412', color: '#ef4444', border: '1px solid #ef444425'
                      }}>
                        ⚠ {(item.errorRate || 0)}%
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ====== 底部双列：来源 + 重试/请求 ====== */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
          {/* 来源统计 */}
          <div style={{ borderRadius: '16px', padding: '20px', ...theme.card }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: '700', color: theme.text.main, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                🔑 来源统计
              </h2>
              <span style={{ fontSize: '11px', color: theme.text.muted }}>
                {clients?.totalClients || 0} 个密钥 / {clients?.totalRequests?.toLocaleString() || 0} 次
              </span>
            </div>
            <div style={{ maxHeight: '280px', overflowY: 'auto', paddingRight: '4px', scrollbarWidth: 'thin' }}>
              {clients?.clients?.length > 0 ? clients.clients.map((c, i) => (
                <ProgressBar key={i} label={c.fingerprint?.length > 30 ? c.fingerprint.slice(0, 30) + '…' : c.fingerprint || 'unknown'}
                  value={c.requests}
                  max={Math.max(...clients.clients.map(x => x.requests), 1)}
                  color={['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#818cf8', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#312e81'][i % 10]}
                  theme={theme} />
              )) : <EmptyCard emoji="🔒" text="暂无来源数据" theme={theme} />}
            </div>
          </div>

          {/* 最近请求 + 重试 */}
          <div style={{ borderRadius: '16px', padding: '20px', ...theme.card }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: '700', color: theme.text.main, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                📋 最近请求
                {selectedModel && <span style={{ fontSize: '11px', fontWeight: '400', color: '#6366f1' }}>筛选: {selectedModel}</span>}
              </h2>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {retryCount > 0 && (
                  <span style={{
                    fontSize: '11px', padding: '3px 10px', borderRadius: '20px',
                    backgroundColor: '#f59e0b18', color: '#f59e0b',
                    border: '1px solid #f59e0b30', fontWeight: '600'
                  }}>
                    重试 {retryCount} 次
                  </span>
                )}
              </div>
            </div>
            <div style={{ maxHeight: '300px', overflowY: 'auto', scrollbarWidth: 'thin' }}>
              {(selectedModel ? filteredRecent : recent?.recent)?.length > 0
                ? (selectedModel ? filteredRecent : recent?.recent).slice(0, 20).map((r, i) => {
                    const label = getStatusLabel(r.status);
                    return (
                      <LogRow key={i} time={formatTime(r.ts)} badge={r.status}
                        label={shortModel(r.model)}
                        badgeColor={label.color}
                        sub={r.latency != null ? `${r.latency}ms` : undefined}
                        color={label.color} theme={theme} />
                    );
                  })
                : <EmptyCard emoji={selectedModel ? "🔍" : "📭"} text={selectedModel ? '该模型暂无请求记录' : '暂无请求记录'} theme={theme} />}
            </div>
          </div>
        </div>

        {/* ====== 双列：错误日志 + status 码 ====== */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
          {/* 错误日志 */}
          <div style={{ borderRadius: '16px', padding: '20px', ...theme.card }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: '700', color: theme.text.main, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                🚨 错误日志
              </h2>
              {errorCount > 0 && (
                <span style={{
                  fontSize: '11px', padding: '3px 10px', borderRadius: '20px',
                  backgroundColor: '#ef444418', color: '#ef4444',
                  border: '1px solid #ef444430', fontWeight: '600'
                }}>今日 {errorCount} 条</span>
              )}
            </div>
            <div style={{ maxHeight: '280px', overflowY: 'auto', scrollbarWidth: 'thin' }}>
              {errors?.errors?.length > 0
                ? errors.errors.slice(0, 20).map((e, i) => {
                    const label = getStatusLabel(e.status);
                    return (
                      <LogRow key={i} time={formatTime(e.ts)} badge={e.status}
                        label={`${shortModel(e.model)}${e.message ? ` · ${e.message}` : ''}`}
                        badgeColor={label.color}
                        sub={e.latency != null ? `${e.latency}ms` : undefined}
                        color={label.color} theme={theme} />
                    );
                  })
                : <EmptyCard emoji="✅" text="今日无错误，一切正常" theme={theme} />}
            </div>
          </div>

          {/* HTTP 状态码速查 + Gemini/Redis 状态 */}
          <div style={{ borderRadius: '16px', padding: '20px', ...theme.card }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: '700', color: theme.text.main, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                🔗 系统状态
              </h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
              <div style={{
                padding: '14px', borderRadius: '10px',
                backgroundColor: theme.bar.bg,
                border: health?.redis?.status === 'ok' ? '1px solid #22c55e30' : '1px solid #ef444430'
              }}>
                <div style={{ fontSize: '11px', color: theme.text.muted, marginBottom: '4px' }}>Gemini API</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{
                    width: '8px', height: '8px', borderRadius: '50%',
                    backgroundColor: health?.gemini?.status === 'ok' ? '#22c55e' : '#ef4444',
                    boxShadow: `0 0 6px ${health?.gemini?.status === 'ok' ? '#22c55e60' : '#ef444460'}`
                  }} />
                  <span style={{ fontSize: '13px', fontWeight: '600', color: theme.text.main }}>
                    {health?.gemini?.status === 'ok' ? '正常' : '异常'}
                  </span>
                  {health?.gemini?.latency && (
                    <span style={{ fontSize: '11px', color: theme.text.muted }}>
                      {health.gemini.latency}ms
                    </span>
                  )}
                </div>
                {health?.gemini?.message && (
                  <div style={{ fontSize: '11px', color: theme.text.muted, marginTop: '4px' }}>{health.gemini.message}</div>
                )}
              </div>
              <div style={{
                padding: '14px', borderRadius: '10px',
                backgroundColor: theme.bar.bg,
                border: health?.redis?.status === 'ok' ? '1px solid #22c55e30' : health?.redis?.status === 'warn' ? '1px solid #f59e0b30' : '1px solid #ef444430'
              }}>
                <div style={{ fontSize: '11px', color: theme.text.muted, marginBottom: '4px' }}>Redis</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{
                    width: '8px', height: '8px', borderRadius: '50%',
                    backgroundColor: health?.redis?.status === 'ok' ? '#22c55e' : health?.redis?.status === 'warn' ? '#f59e0b' : '#ef4444',
                    boxShadow: `0 0 6px ${health?.redis?.status === 'ok' ? '#22c55e60' : health?.redis?.status === 'warn' ? '#f59e0b60' : '#ef444460'}`
                  }} />
                  <span style={{ fontSize: '13px', fontWeight: '600', color: theme.text.main }}>
                    {health?.redis?.status === 'ok' ? '正常' : health?.redis?.status === 'warn' ? '异常' : '离线'}
                  </span>
                  {health?.redis?.latency && (
                    <span style={{ fontSize: '11px', color: theme.text.muted }}>
                      {health.redis.latency}ms
                    </span>
                  )}
                </div>
                {health?.redis?.message && (
                  <div style={{ fontSize: '11px', color: theme.text.muted, marginTop: '4px' }}>{health.redis.message}</div>
                )}
              </div>
            </div>

            {/* HTTP 状态码 */}
            <div style={{ fontSize: '13px', fontWeight: '600', color: theme.text.main, marginBottom: '10px' }}>
              📖 HTTP 状态码速查
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '6px'
            }}>
              {Object.entries(HTTP_STATUS_DESC).map(([code, desc]) => {
                const c = parseInt(code);
                const color = c >= 500 ? '#ef4444' : c >= 400 ? '#f59e0b' : '#22c55e';
                return (
                  <div key={code} style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '6px 10px', borderRadius: '6px',
                    backgroundColor: theme.bar.bg, fontSize: '12px'
                  }}>
                    <span style={{
                      padding: '1px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '700',
                      fontFamily: 'monospace', backgroundColor: `${color}18`, color,
                      border: `1px solid ${color}30`
                    }}>{code}</span>
                    <span style={{ color: theme.text.sub }}>{desc}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ====== Footer ====== */}
        <footer style={{
          display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '16px',
          paddingTop: '24px', marginTop: '8px',
          borderTop: `1px solid ${dark ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.06)'}`,
          color: theme.text.muted, fontSize: '12px'
        }}>
          <a href="https://github.com/JE668/gemini-transparent-proxy" target="_blank" rel="noopener noreferrer"
            style={{ color: '#6366f1', textDecoration: 'none', fontWeight: '500' }}>
            GitHub
          </a>
          <span>·</span>
          <span>Gemini 透明代理</span>
          <span>·</span>
          <span>Vercel Edge</span>
        </footer>

        {/* 全局 CSS */}
        <style>{`
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes shimmer { 
            0% { transform: translateX(-100%); } 
            100% { transform: translateX(100%); } 
          }
          @keyframes pulse-glow { 
            0%, 100% { opacity: 0.5; transform: scale(1); } 
            50% { opacity: 0.8; transform: scale(1.1); } 
          }
          @keyframes float { 
            0%, 100% { transform: translateY(0); } 
            50% { transform: translateY(-10px); } 
          }
          @keyframes slide-up { 
            from { opacity: 0; transform: translateY(30px); } 
            to { opacity: 1; transform: translateY(0); } 
          }
          @keyframes shake { 
            0%, 100% { transform: translateX(0); } 
            25% { transform: translateX(-8px); } 
            75% { transform: translateX(8px); } 
          }
          ::-webkit-scrollbar { width: 6px; height: 6px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { 
            background: ${darkCheck(theme)} ? '#334155' : '#cbd5e1'; 
            border-radius: 3px;
            transition: background 0.2s ease;
          }
          ::-webkit-scrollbar-thumb:hover { 
            background: ${darkCheck(theme)} ? '#475569' : '#94a3b8'; 
          }
          @media (max-width: 768px) {
            body > div > div > div { padding: 16px 12px !important; }
          }
          @media (max-width: 860px) {
            [style*="grid-template-columns: 1fr 1fr"] {
              grid-template-columns: 1fr !important;
            }
          }
        `}</style>
      </div>
    </div>
  );
}