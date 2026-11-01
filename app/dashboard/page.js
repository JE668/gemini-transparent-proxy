'use client';
// =============================================================================
// Gemini Transparent Proxy — 专业监控控制台（方案 C）
// 视觉语言参考 Grafana / Datadog：固定顶栏 + 左侧导航 + 分区主内容
// 暗色为默认主题（深蓝紫渐变 + 霓虹线条），亮色为清爽专业风
// 图表全部自绘 SVG，无第三方图表依赖（保持项目零 UI 依赖）
// =============================================================================
import React, { useEffect, useState, useCallback, useMemo, Suspense, useRef, useId } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
// 配额重置倒计时 —— 与后端配额日界共用同一份实现
import { getSecondsUntilQuotaReset } from '../../lib/utils';

const REFRESH_INTERVAL = 30000;

// =============================================================================
// 全局样式与动画
// =============================================================================
const ANIM_CSS = `
@keyframes db-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
@keyframes db-slide-up { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes db-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes db-spin { to { transform: rotate(360deg); } }
@keyframes db-pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
@keyframes db-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
@keyframes db-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-7px); } 75% { transform: translateX(7px); } }
@keyframes db-sweep { 0% { transform: translateX(-120%); } 100% { transform: translateX(420%); } }
.db-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.db-scroll::-webkit-scrollbar-track { background: transparent; }
.db-scroll::-webkit-scrollbar-thumb { background: rgba(148,163,184,.28); border-radius: 3px; }
.db-scroll::-webkit-scrollbar-thumb:hover { background: rgba(148,163,184,.5); }
.db-scroll { scrollbar-width: thin; scrollbar-color: rgba(148,163,184,.28) transparent; }
.db-nav { transition: background .16s ease, color .16s ease; }
.db-nav:hover { background: var(--db-hover) !important; }
.db-btn { transition: transform .16s ease, border-color .16s ease, background .16s ease; }
.db-btn:hover { transform: translateY(-1px); }
.db-btn:active { transform: translateY(0); }
.db-row { transition: background .14s ease, border-color .14s ease; }
.db-row:hover { background: var(--db-hover) !important; }
.db-card { animation: db-slide-up .45s cubic-bezier(.4,0,.2,1) both; }
.db-qcard { transition: transform .2s cubic-bezier(.4,0,.2,1), border-color .2s ease, box-shadow .2s ease; }
.db-qcard:hover { transform: translateY(-3px); }
@media (max-width: 1080px) {
  .db-main { margin-left: 0 !important; }
}
@media (max-width: 768px) {
  .db-metrics { grid-template-columns: 1fr 1fr !important; }
  .db-split { grid-template-columns: 1fr !important; }
  .db-topbar { padding: 10px 14px !important; }
  .db-main { padding: 14px 12px 40px !important; }
}
@media (max-width: 480px) {
  .db-quota-grid { grid-template-columns: 1fr !important; }
  .db-hide-xs { display: none !important; }
}
`;

// =============================================================================
// 常量
// =============================================================================
const HTTP_STATUS_DESC = {
  400: '请求格式错误', 401: '认证失败 / 密钥无效', 403: '权限不足',
  404: '资源不存在', 408: '请求超时', 429: '请求过于频繁（限流）',
  500: '服务器内部错误', 502: '网关错误（上游异常）', 503: '服务暂不可用', 504: '网关超时（上游无响应）',
};

const MODEL_COLORS = {
  'gemma-4-31b-it': '#818cf8', 'gemma-4-26b-a4b-it': '#a78bfa',
  'gemini-2.5-flash': '#34d399', 'gemini-2.5-flash-lite': '#6ee7b7',
  'gemini-2.5-flash-preview-tts': '#a7f3d0',
  'gemini-3-flash-preview': '#38bdf8', 'gemini-3.5-flash-lite': '#7dd3fc',
  'gemini-3.1-flash-lite': '#0ea5e9', 'gemini-3.1-flash-tts-preview': '#bae6fd',
  'gemini-3.6-flash': '#22d3ee', 'gemini-3.8-flash': '#2dd4bf',
  'gemini-3.8-flash-tts': '#5eead4', 'gemini-3.8-flash-lite-tts': '#99f6e4',
  'default': '#818cf8',
};
const getModelColor = (id) => MODEL_COLORS[id] || MODEL_COLORS.default;

// =============================================================================
// 工具函数
// =============================================================================
const formatTime = (iso) => {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return String(iso ?? ''); }
};
const shortModel = (id) => String(id || '').replace('models/', '');
const getStatusLabel = (code) => {
  if (!code) return { text: '未知', color: '#94a3b8' };
  if (code >= 500) return { text: '服务端', color: '#f87171' };
  if (code >= 400) return { text: '客户端', color: '#fbbf24' };
  return { text: '成功', color: '#4ade80' };
};
const formatDuration = (minutes) => {
  if (minutes == null || !isFinite(minutes)) return '—';
  if (minutes < 1) return '< 1 分钟';
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h >= 24) return `${(h / 24).toFixed(1)} 天`;
  return m > 0 ? `${h} 时 ${m} 分` : `${h} 小时`;
};
const getTimeUntilReset = () => {
  const total = getSecondsUntilQuotaReset();
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
};
const formatCountdown = (cd) =>
  String(cd.hours).padStart(2, '0') + ':' + String(cd.minutes).padStart(2, '0') + ':' + String(cd.seconds).padStart(2, '0');

const parseUserAgent = (ua) => {
  if (!ua || ua === 'unknown') return { type: '未知', icon: '🔌' };
  if (ua.includes('Postman')) return { type: 'Postman', icon: '🔌' };
  if (ua.includes('curl')) return { type: 'curl', icon: '💻' };
  if (ua.includes('python-requests')) return { type: 'Python', icon: '🐍' };
  if (ua.includes('node-fetch')) return { type: 'Node.js', icon: '🟢' };
  if (ua.includes('axios')) return { type: 'Axios', icon: '📦' };
  if (ua.includes('Go-http-client')) return { type: 'Go', icon: '🔵' };
  if (ua.includes('Java')) return { type: 'Java', icon: '☕' };
  if (ua.includes('Mozilla/5.0')) {
    if (ua.includes('Chrome')) return { type: 'Chrome', icon: '🌐' };
    if (ua.includes('Firefox')) return { type: 'Firefox', icon: '🦊' };
    if (ua.includes('Safari')) return { type: 'Safari', icon: '🧭' };
  }
  return { type: '其他', icon: '🔌' };
};

const predictQuotaExhaustion = (used, limit, hoursElapsed) => {
  if (!used || !limit || hoursElapsed <= 0) return null;
  const rate = used / hoursElapsed;
  if (rate <= 0) return null;
  const remaining = limit - used;
  if (remaining <= 0) return { exhausted: true, minutes: 0, rate, remaining: 0 };
  return { exhausted: false, minutes: (remaining / rate) * 60, rate, remaining };
};

const exportToCSV = (rows, filename) => {
  if (!rows || rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => {
      const v = r[h];
      return (typeof v === 'string' && (v.includes(',') || v.includes('"'))) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',')),
  ].join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
};

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : String(n ?? '—'));
const fmtK = (n) => {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
};
const pctOf = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

// =============================================================================
// 主题（暗色为默认：深蓝紫渐变 + 霓虹线条）
// =============================================================================
function buildTheme(dark) {
  if (dark) {
    return {
      dark: true,
      body: { background: 'linear-gradient(160deg,#0b1020 0%,#0f172a 34%,#151433 68%,#1b1746 100%)', color: '#cbd5e1' },
      hover: 'rgba(148,163,184,0.07)',
      topbar: { background: 'rgba(9,13,27,0.86)', borderBottom: '1px solid rgba(148,163,184,0.12)' },
      sidebar: { background: 'rgba(9,13,27,0.62)', borderRight: '1px solid rgba(148,163,184,0.1)' },
      card: {
        background: 'linear-gradient(155deg,rgba(30,41,59,.72),rgba(13,20,38,.78))',
        border: '1px solid rgba(148,163,184,.12)',
        boxShadow: '0 10px 30px rgba(2,6,23,.5), inset 0 1px 0 rgba(255,255,255,.045)',
      },
      inset: { background: 'rgba(2,6,23,.5)', border: '1px solid rgba(148,163,184,.09)' },
      text: { hi: '#f1f5f9', main: '#dbe3ef', sub: '#94a3b8', muted: '#64748b' },
      grid: 'rgba(148,163,184,.1)',
      axis: 'rgba(148,163,184,.22)',
      tipBg: 'rgba(2,6,23,.96)',
      accent: '#818cf8', accent2: '#22d3ee', accent3: '#a78bfa',
      ok: '#4ade80', warn: '#fbbf24', err: '#f87171',
      ring: 'rgba(148,163,184,.14)', heatOff: 'rgba(148,163,184,.07)',
      heroBg: 'linear-gradient(150deg,rgba(34,211,238,.1),rgba(99,102,241,.07) 45%,rgba(167,139,250,.11))',
      heroBorder: '1px solid rgba(129,140,248,.26)',
    };
  }
  return {
    dark: false,
    body: { background: 'linear-gradient(160deg,#f5f8ff 0%,#eef2ff 42%,#f6f4ff 74%,#eef2ff 100%)', color: '#334155' },
    hover: 'rgba(99,102,241,0.06)',
    topbar: { background: 'rgba(255,255,255,.88)', borderBottom: '1px solid rgba(99,102,241,.14)' },
    sidebar: { background: 'rgba(255,255,255,.72)', borderRight: '1px solid rgba(99,102,241,.12)' },
    card: {
      background: 'rgba(255,255,255,.92)',
      border: '1px solid rgba(99,102,241,.14)',
      boxShadow: '0 6px 22px rgba(79,70,229,.08), 0 1px 2px rgba(15,23,42,.04)',
    },
    inset: { background: '#f7f9ff', border: '1px solid rgba(99,102,241,.1)' },
    text: { hi: '#0f172a', main: '#1e293b', sub: '#475569', muted: '#94a3b8' },
    grid: 'rgba(99,102,241,.11)',
    axis: 'rgba(99,102,241,.24)',
    tipBg: 'rgba(15,23,42,.96)',
    accent: '#6366f1', accent2: '#0891b2', accent3: '#7c3aed',
    ok: '#16a34a', warn: '#d97706', err: '#dc2626',
    ring: 'rgba(99,102,241,.12)', heatOff: 'rgba(99,102,241,.07)',
    heroBg: 'linear-gradient(150deg,rgba(34,211,238,.09),rgba(99,102,241,.07) 45%,rgba(139,92,246,.09))',
    heroBorder: '1px solid rgba(99,102,241,.24)',
  };
}

// =============================================================================
// Hooks
// =============================================================================
function useResponsive() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    setIsMobile(mq.matches);
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

// =============================================================================
// 图表组件（自绘 SVG）
// =============================================================================

// 数字滚动动画
function AnimatedNumber({ value, duration = 900, color, suffix = '' }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const target = Number(value);
    if (!isFinite(target)) { setDisplay(0); return; }
    if (Math.abs(target) < 5) { setDisplay(target); return; }
    const start = performance.now();
    let raf;
    const tick = (now) => {
      const p = Math.min((now - start) / duration, 1);
      setDisplay(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span style={color ? { color } : undefined}>{display.toLocaleString()}{suffix}</span>;
}

// 时间序列面积图（今天 vs 昨天），带十字准星与 tooltip
function TimeSeriesChart({ data, height = 210, theme }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [hover, setHover] = useState(null);
  const W = 760, H = height, padL = 46, padR = 16, padT = 16, padB = 26;

  if (!data || data.length === 0) {
    return <EmptyHint icon="📉" text="暂无时间线数据" theme={theme} height={height} />;
  }

  const maxVal = Math.max(...data.map(d => d.today || 0), ...data.map(d => d.yesterday || 0), 1);
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const stepX = chartW / Math.max(data.length - 1, 1);
  const px = (i) => padL + i * stepX;
  const py = (v) => padT + chartH - (Math.max(v || 0, 0) / maxVal) * chartH;

  const pts = data.map((d, i) => ({ ...d, x: px(i), y: py(d.today) }));
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${(padT + chartH).toFixed(1)} L${padL},${(padT + chartH).toFixed(1)} Z`;
  const yLine = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(d.yesterday).toFixed(1)}`).join(' ');

  const yTicks = 4;
  const tip = hover != null ? pts[hover] : null;
  const tipW = 168, tipH = 82;
  const tipX = tip ? Math.min(Math.max(tip.x - tipW / 2, 4), W - tipW - 4) : 0;
  const tipY = tip ? Math.max(tip.y - tipH - 14, 2) : 0;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', overflow: 'visible' }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const mx = (e.clientX - rect.left) * (W / rect.width);
          let best = 0, dist = Infinity;
          pts.forEach((p, i) => { const d = Math.abs(p.x - mx); if (d < dist) { dist = d; best = i; } });
          if (hover !== best) setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`area-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={theme.accent} stopOpacity="0.34" />
            <stop offset="100%" stopColor={theme.accent} stopOpacity="0.01" />
          </linearGradient>
          <linearGradient id={`stroke-${uid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={theme.accent2} />
            <stop offset="55%" stopColor={theme.accent} />
            <stop offset="100%" stopColor={theme.accent3} />
          </linearGradient>
        </defs>

        {Array.from({ length: yTicks + 1 }).map((_, i) => {
          const y = padT + (chartH / yTicks) * i;
          const v = Math.round((maxVal / yTicks) * (yTicks - i));
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke={theme.grid} strokeWidth="1" strokeDasharray={i === yTicks ? '0' : '3 4'} />
              <text x={padL - 9} y={y + 3.5} textAnchor="end" fill={theme.text.muted} fontSize="10" fontFamily="ui-monospace,monospace">
                {fmtK(v)}
              </text>
            </g>
          );
        })}

        <path d={area} fill={`url(#area-${uid})`} />
        {data.some(d => (d.yesterday || 0) > 0) && (
          <path d={yLine} fill="none" stroke={theme.text.muted} strokeWidth="1.6" strokeDasharray="5 5" opacity="0.6" />
        )}
        <path d={line} fill="none" stroke={`url(#stroke-${uid})`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />

        {/* 当前小时指示线 */}
        {(() => {
          const nowHour = new Date().getHours();
          const idx = data.findIndex(d => d.hour === nowHour);
          if (idx < 0) return null;
          return (
            <g>
              <line x1={pts[idx].x} y1={padT} x2={pts[idx].x} y2={padT + chartH} stroke={theme.accent} strokeWidth="1" strokeDasharray="2 3" opacity="0.55" />
              <circle cx={pts[idx].x} cy={padT - 4} r="2.6" fill={theme.accent} />
            </g>
          );
        })()}

        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={hover === i ? 5 : 0}
            fill={theme.dark ? '#0b1020' : '#fff'} stroke={theme.accent} strokeWidth="2.2" />
        ))}

        {data.map((d, i) => (i % 3 === 0 || i === data.length - 1) ? (
          <text key={i} x={px(i)} y={H - 8} textAnchor="middle" fill={theme.text.muted} fontSize="9.5" fontFamily="ui-monospace,monospace">
            {String(d.hour).padStart(2, '0')}
          </text>
        ) : null)}

        {tip && (
          <g style={{ pointerEvents: 'none' }}>
            <line x1={tip.x} y1={padT} x2={tip.x} y2={padT + chartH} stroke={theme.accent} strokeWidth="1" opacity="0.4" />
            <rect x={tipX} y={tipY} width={tipW} height={tipH} rx="9" fill={theme.tipBg} stroke={theme.accent + '55'} strokeWidth="1" />
            <text x={tipX + tipW / 2} y={tipY + 19} textAnchor="middle" fill="#cbd5e1" fontSize="11" fontWeight="600">{tip.label}</text>
            <text x={tipX + tipW / 2} y={tipY + 43} textAnchor="middle" fill="#e0e7ff" fontSize="20" fontWeight="700" fontFamily="ui-monospace,monospace">
              {fmt(tip.today)}
            </text>
            <text x={tipX + tipW / 2} y={tipY + 60} textAnchor="middle" fill="#94a3b8" fontSize="10">
              昨日 {fmt(tip.yesterday || 0)}
            </text>
            <text x={tipX + tipW / 2} y={tipY + 74} textAnchor="middle"
              fill={(tip.change || 0) >= 0 ? '#4ade80' : '#f87171'} fontSize="10" fontFamily="ui-monospace,monospace">
              {(tip.change || 0) >= 0 ? '▲' : '▼'} {Math.abs(tip.change || 0)}% 同比
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// 环形进度
function Ring({ percent, size = 68, stroke = 6, color, children }) {
  const r = size / 2 - stroke / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (Math.min(Math.max(percent, 0), 100) / 100) * circ;
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.strokeDashoffset = circ;
    const id = requestAnimationFrame(() => { el.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)'; el.style.strokeDashoffset = offset; });
    return () => cancelAnimationFrame(id);
  }, [offset, circ]);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(148,163,184,0.15)" strokeWidth={stroke} />
        <circle ref={ref} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ}
          style={{ filter: `drop-shadow(0 0 4px ${color}66)` }} />
      </svg>
      {children && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1.1 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// 状态构成（2xx / 4xx / 5xx）水平堆叠条
function StatusBar({ counts, theme }) {
  const total = counts.ok + counts.client + counts.server;
  if (total <= 0) return null;
  const parts = [
    { k: '成功', v: counts.ok, c: theme.ok },
    { k: '客户端', v: counts.client, c: theme.warn },
    { k: '服务端', v: counts.server, c: theme.err },
  ];
  return (
    <div>
      <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', gap: 2, background: theme.ring }}>
        {parts.filter(p => p.v > 0).map(p => (
          <div key={p.k} title={`${p.k} ${p.v}`} style={{
            width: `${(p.v / total) * 100}%`, background: p.c, borderRadius: 3,
            transition: 'width .8s cubic-bezier(.4,0,.2,1)', boxShadow: `0 0 8px ${p.c}55`,
          }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 9, flexWrap: 'wrap' }}>
        {parts.map(p => (
          <div key={p.k} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: p.c, boxShadow: `0 0 6px ${p.c}77` }} />
            <span style={{ color: theme.text.muted }}>{p.k}</span>
            <span style={{ color: theme.text.main, fontFamily: 'ui-monospace,monospace', fontWeight: 700 }}>{fmt(p.v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// 多维热力图：行（状态码/延迟桶/模型）× 24 小时矩阵
// 数据来自 /api/heat（由 telemetry.js 写入 heat:{dim}:{date}:h{hour} Hash）
// =============================================================================
function HeatMatrix({ dim, data, theme }) {
  // dim: 'status' | 'latency' | 'models' | 'clients' | 'tokens'
  const matrix = data?.[dim];
  if (!matrix || !matrix.rows || matrix.rows.length === 0) return null;
  const rows = matrix.rows;
  const hours = matrix.hours || Array.from({ length: 24 }, (_, i) => i);
  // 全局最大值（用于归一化颜色深度）
  const maxVal = Math.max(...rows.flatMap(r => r.values), 1);
  const cellSize = 13;

  // 维度配色：状态用红/黄/绿语义色，延迟用蓝/紫梯度，模型用模型色，
  // 来源用分类色（curl/Python/Node/Postman/浏览器/其他），token 用分桶梯度色
  const rowColor = (row) => {
    if (dim === 'status') {
      const code = Number(row.id);
      if (!code) return theme.text.muted;
      if (code >= 500) return theme.err;
      if (code >= 400) return theme.warn;
      return theme.ok;
    }
    if (dim === 'latency') {
      return row.id === 'critical' ? theme.err : row.id === 'slow' ? theme.warn : row.id === 'mid' ? theme.accent : theme.accent2;
    }
    if (dim === 'clients') {
      const map = {
        curl: '#22d3ee', python: '#fbbf24', node: '#4ade80',
        postman: '#fb923c', browser: '#818cf8', other: '#94a3b8',
      };
      return map[row.id] || theme.text.muted;
    }
    if (dim === 'tokens') {
      const map = {
        none: '#94a3b8', tiny: '#22d3ee', small: '#38bdf8',
        medium: '#a78bfa', large: '#f87171',
      };
      return map[row.id] || theme.text.muted;
    }
    return getModelColor(row.id);
  };

  const rowLabel = (row) => {
    if (dim === 'models') return shortModel(row.label || row.id);
    return row.label || row.id;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {rows.map(row => {
        const color = rowColor(row);
        const total = row.values.reduce((s, v) => s + (v || 0), 0);
        return (
          <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 46, flexShrink: 0, fontSize: 10.5, color: theme.text.sub,
              textAlign: 'right', fontFamily: 'ui-monospace,monospace', whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
            }} title={rowLabel(row)}>{rowLabel(row)}</span>
            <div style={{ display: 'flex', gap: 2.5, flex: 1 }}>
              {hours.map((h, i) => {
                const v = row.values[i] || 0;
                const t = v / maxVal;
                const alphaHex = Math.round((0.22 + t * 0.72) * 255).toString(16).padStart(2, '0');
                const bg = v === 0 ? theme.heatOff : `${color}${alphaHex}`;
                return (
                  <div key={h} title={`${rowLabel(row)} · ${String(h).padStart(2, '0')}:00 · ${v} 次`}
                    style={{ width: cellSize, height: cellSize, borderRadius: 3, background: bg, cursor: 'default', flexShrink: 0 }} />
                );
              })}
            </div>
            <span style={{ width: 34, flexShrink: 0, fontSize: 10, color: theme.text.muted, textAlign: 'right', fontFamily: 'ui-monospace,monospace' }}>
              {fmtK(total)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// 热力图底部小时刻度
function HeatHourAxis({ data, theme }) {
  const matrix = data?.status || data?.latency || data?.models;
  const hours = matrix?.hours || Array.from({ length: 24 }, (_, i) => i);
  return (
    <div style={{ display: 'flex', gap: 2.5, marginTop: 4, paddingLeft: 54 }}>
      {hours.map((h, i) => (
        <span key={h} style={{
          flex: 1, flexShrink: 0, textAlign: 'center', fontSize: 8.5, color: theme.text.muted,
          fontFamily: 'ui-monospace,monospace',
        }}>{i % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>
      ))}
    </div>
  );
}

// 空态
function EmptyHint({ icon, text, sub, theme, height = 140 }) {
  return (
    <div style={{ minHeight: height, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '18px 12px' }}>
      <div style={{ fontSize: 34, opacity: 0.75, animation: 'db-float 3.4s ease-in-out infinite' }}>{icon}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text.sub }}>{text}</div>
      {sub && <div style={{ fontSize: 11, color: theme.text.muted, textAlign: 'center', maxWidth: 300, lineHeight: 1.6 }}>{sub}</div>}
    </div>
  );
}

// =============================================================================
// 布局与基础 UI 组件
// =============================================================================

// 分区卡片外壳
function Panel({ id, icon, title, meta, actions, children, theme, accent, style }) {
  return (
    <section id={`sec-${id}`} className="db-card" style={{
      ...theme.card, borderRadius: 16, padding: '16px 18px', scrollMarginTop: 84, ...style,
    }}>
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        flexWrap: 'wrap', marginBottom: 15, paddingBottom: 12,
        borderBottom: `1px solid ${theme.grid}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{
            width: 27, height: 27, borderRadius: 8, flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
            background: `linear-gradient(135deg,${accent || theme.accent}30,${accent || theme.accent}0d)`,
            border: `1px solid ${accent || theme.accent}40`,
          }}>{icon}</span>
          <h2 className="db-sec-title" style={{ fontSize: 15, fontWeight: 700, color: theme.text.hi, margin: 0, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
            {title}
          </h2>
          {meta && <span className="db-hide-xs" style={{ fontSize: 11, color: theme.text.muted, fontFamily: 'ui-monospace,monospace' }}>{meta}</span>}
        </div>
        {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
      </header>
      {children}
    </section>
  );
}

// 小徽标
function Chip({ children, tone = 'neutral', theme, dot }) {
  const palette = {
    neutral: { bg: theme.ring, fg: theme.text.sub, bd: theme.grid },
    ok: { bg: theme.ok + '1f', fg: theme.ok, bd: theme.ok + '44' },
    warn: { bg: theme.warn + '1f', fg: theme.warn, bd: theme.warn + '44' },
    err: { bg: theme.err + '1f', fg: theme.err, bd: theme.err + '44' },
    info: { bg: theme.accent + '1f', fg: theme.accent, bd: theme.accent + '44' },
  }[tone] || {};
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
      padding: '3px 9px', borderRadius: 20, whiteSpace: 'nowrap',
      background: palette.bg, color: palette.fg, border: `1px solid ${palette.bd}`,
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: palette.fg, boxShadow: `0 0 6px ${palette.fg}` }} />}
      {children}
    </span>
  );
}

// 顶部指标卡（大数字 + 趋势）
function StatCard({ icon, label, value, unit, foot, color, theme, badge, spark, onClick, active }) {
  return (
    <div className="db-qcard" onClick={onClick} style={{
      position: 'relative', overflow: 'hidden',
      background: active ? `linear-gradient(150deg,${color}1f,${color}08)` : theme.card.background,
      border: active ? `1px solid ${color}88` : theme.card.border,
      borderRadius: 14, padding: '15px 16px',
      boxShadow: theme.card.boxShadow,
      cursor: onClick ? 'pointer' : 'default',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: `linear-gradient(90deg,transparent,${color},${color}00)`, opacity: active ? 0.95 : 0.45,
      }} />
      {badge > 0 && (
        <span style={{
          position: 'absolute', top: 11, right: 11, minWidth: 18, height: 18, padding: '0 5px',
          borderRadius: 9, background: theme.err, color: '#fff', fontSize: 10, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 10px ${theme.err}99`,
        }}>{badge > 99 ? '99+' : badge}</span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <span style={{ fontSize: 13, opacity: 0.9 }}>{icon}</span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: theme.text.sub, letterSpacing: '0.02em' }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3, fontFamily: 'ui-monospace,SFMono-Regular,monospace' }}>
        <span style={{ fontSize: 27, fontWeight: 800, color: color, letterSpacing: '-0.03em', lineHeight: 1, textShadow: theme.dark ? `0 0 18px ${color}44` : 'none' }}>
          {value}
        </span>
        {unit && <span style={{ fontSize: 12, fontWeight: 600, color: theme.text.muted }}>{unit}</span>}
      </div>
      {spark && <div style={{ marginTop: 9, opacity: 0.9 }}>{spark}</div>}
      {foot && <div style={{ marginTop: 8, fontSize: 10.5, color: theme.text.muted, lineHeight: 1.5 }}>{foot}</div>}
    </div>
  );
}

// 迷你趋势条（指标卡内嵌）
function MiniBars({ series, color, theme }) {
  if (!series || series.length === 0) return null;
  const max = Math.max(...series.map(s => s.v), 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 22 }}>
      {series.map((s, i) => (
        <div key={i} title={`${String(s.h).padStart(2, '0')}:00 · ${s.v}`} style={{
          flex: 1, minWidth: 2, borderRadius: 1.5,
          height: `${Math.max((s.v / max) * 100, s.v > 0 ? 12 : 4)}%`,
          background: s.v > 0 ? color : theme.ring, opacity: s.v > 0 ? 0.5 + (s.v / max) * 0.5 : 1,
        }} />
      ))}
    </div>
  );
}

// 日志行（最近请求 / 慢请求 / 错误）
function LogRow({ time, badge, badgeColor, label, meta, theme }) {
  return (
    <div className="db-row" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', marginBottom: 5,
      borderRadius: 9, background: theme.inset.background, border: theme.inset.border, fontSize: 12,
    }}>
      <span style={{ color: theme.text.muted, fontSize: 11, fontFamily: 'ui-monospace,monospace', minWidth: 62, flexShrink: 0 }}>{time}</span>
      <span style={{
        padding: '2px 8px', borderRadius: 5, fontSize: 10.5, fontWeight: 700, minWidth: 34, textAlign: 'center', flexShrink: 0,
        fontFamily: 'ui-monospace,monospace', background: badgeColor + '20', color: badgeColor, border: `1px solid ${badgeColor}44`,
      }}>{badge}</span>
      <span style={{ color: theme.text.main, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>{label}</span>
      {meta && <span className="db-hide-xs" style={{ color: theme.text.muted, fontSize: 11, fontFamily: 'ui-monospace,monospace', flexShrink: 0 }}>{meta}</span>}
    </div>
  );
}

// 骨架屏
function Skeleton({ w = '60%', h = 12, theme, r = 6 }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: r,
      background: `linear-gradient(90deg,${theme.ring},${theme.dark ? 'rgba(148,163,184,.14)' : 'rgba(99,102,241,.06)'},${theme.ring})`,
      backgroundSize: '200% 100%', animation: 'db-shimmer 1.5s ease-in-out infinite',
    }} />
  );
}

function SkeletonPanel({ theme, rows = 4 }) {
  return (
    <div style={{ ...theme.card, borderRadius: 16, padding: '16px 18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Skeleton w="140px" h={15} theme={theme} />
        <Skeleton w="70px" h={13} theme={theme} />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 9 }}>
          <Skeleton w="52px" h={10} theme={theme} />
          <Skeleton w="38px" h={16} theme={theme} />
          <Skeleton w="50%" h={11} theme={theme} />
        </div>
      ))}
    </div>
  );
}

// 顶栏按钮
function IconButton({ onClick, title, children, theme, spinning, disabled, wide }) {
  return (
    <button className="db-btn" onClick={onClick} title={title} disabled={disabled} style={{
      height: 34, minWidth: wide ? undefined : 34, padding: wide ? '0 12px' : 0,
      borderRadius: 9, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      background: theme.inset.background, border: theme.inset.border, color: theme.text.sub,
      opacity: disabled ? 0.55 : 1, animation: spinning ? 'db-spin 1s linear infinite' : 'none',
    }}>{children}</button>
  );
}

// =============================================================================
// 入口
// =============================================================================
export default function DashboardPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0b1020', color: '#64748b', fontFamily: 'ui-monospace,monospace', fontSize: 13 }}>
        正在初始化控制台…
      </div>
    }>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [dark, setDark] = useState(() => {
    // 新 UI 默认暗色；仅在明确存储过亮色偏好时才用亮色
    if (searchParams.get('dark') === '0') return false;
    if (searchParams.get('dark') === '1') return true;
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('dashboard_dark');
    return saved === null ? true : saved === 'true';
  });
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [quota, setQuota] = useState(null);
  const [health, setHealth] = useState(null);
  const [errors, setErrors] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [recent, setRecent] = useState(null);
  const [heat, setHeat] = useState(null);
  const [selectedModel, setSelectedModel] = useState(null);
  const [authError, setAuthError] = useState('');
  const [countdown, setCountdown] = useState(getTimeUntilReset());
  const [exporting, setExporting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState(null);
  const [refreshProgress, setRefreshProgress] = useState(0);
  const [unreadErrors, setUnreadErrors] = useState(0);
  const [now, setNow] = useState(() => new Date());

  const isMobile = useResponsive();
  const theme = useMemo(() => buildTheme(dark), [dark]);

  // 每秒：配额重置倒计时 + 顶栏时钟
  useEffect(() => {
    const timer = setInterval(() => { setCountdown(getTimeUntilReset()); setNow(new Date()); }, 1000);
    return () => clearInterval(timer);
  }, []);

  // 自动刷新进度条
  useEffect(() => {
    if (!authed) return;
    let step = 0;
    const timer = setInterval(() => {
      step = (step + 1) % 100;
      setRefreshProgress(step);
    }, REFRESH_INTERVAL / 100);
    return () => clearInterval(timer);
  }, [authed]);

  // 恢复登录态
  useEffect(() => {
    const saved = localStorage.getItem('dashboard_token');
    if (saved && !searchParams.get('authed')) { setPassword(saved); setAuthed(true); }
  }, [searchParams]);

  // 同步主题到 URL
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    if (dark) { params.set('dark', '1'); } else { params.set('dark', '0'); }
    const next = params.toString();
    if (window.location.search !== next) router.replace(`${pathname}?${next}`, { scroll: false });
  }, [dark, router, pathname, searchParams]);

  const handleLogin = async (e) => {
    e?.preventDefault();
    setAuthError('');
    if (!password) { setAuthError('请输入访问密码'); return; }
    try {
      const res = await fetch('/api/quota', { headers: { Authorization: `Bearer ${password}` } });
      if (res.ok) {
        localStorage.setItem('dashboard_token', password);
        setAuthed(true);
        return;
      }
      if (res.status === 503) setAuthError('服务端未配置 DASHBOARD_PASSWORD，请到部署平台设置后重新部署');
      else if (res.status === 401) setAuthError('密码错误，请重试');
      else if (res.status === 404) setAuthError('接口不存在（请确认访问的是 Vercel 部署，而非 Cloudflare Worker）');
      else setAuthError(`登录失败（HTTP ${res.status}）`);
    } catch {
      setAuthError('连接失败，请检查网络后重试');
    }
  };

  const logout = useCallback(() => {
    localStorage.removeItem('dashboard_token');
    setAuthed(false); setPassword(''); setQuota(null); setHealth(null); setErrors(null);
    setTimeline(null); setRecent(null); setLoading(true);
  }, []);

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
      const [q, h, e, t, r, hm] = await Promise.all([
        authFetch('/api/quota').then(res => res?.json()),
        authFetch('/api/health').then(res => res?.json()).catch(() => null),
        authFetch('/api/errors').then(res => res?.json()).catch(() => null),
        authFetch('/api/timeline').then(res => res?.json()).catch(() => null),
        authFetch('/api/recent').then(res => res?.json()).catch(() => null),
        authFetch('/api/heat').then(res => res?.json()).catch(() => null),
      ]);
      if (!q && !h && !e && !t && !r && !hm) return;
      setQuota(q); setHealth(h); setErrors(e); setTimeline(t); setRecent(r); setHeat(hm);
    } catch (err) {
      console.error('刷新数据失败:', err);
    } finally {
      setRefreshing(false); setLoading(false);
    }
  }, [authed, authFetch]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchData]);

  // 未读错误角标
  useEffect(() => {
    if (errors?.count > 0) {
      setUnreadErrors(prev => (prev === 0 ? errors.count : prev));
      const timer = setTimeout(() => setUnreadErrors(0), 6000);
      return () => clearTimeout(timer);
    }
  }, [errors?.count]);

  const toggleDark = useCallback(() => {
    setDark(prev => { localStorage.setItem('dashboard_dark', String(!prev)); return !prev; });
  }, []);

  // 快捷键：R 刷新 / D 主题 / E 导出 / Q 退出
  useEffect(() => {
    if (!authed) return;
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === 'r') { e.preventDefault(); fetchData(); }
      else if (k === 'd') { e.preventDefault(); toggleDark(); }
      else if (k === 'e') { e.preventDefault(); setShowExportMenu(p => !p); }
      else if (k === 'q') { e.preventDefault(); logout(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [authed, fetchData, toggleDark, logout]);

  // 注入全局样式
  useEffect(() => {
    const id = 'db-console-styles';
    if (!document.getElementById(id)) {
      const el = document.createElement('style');
      el.id = id;
      el.textContent = ANIM_CSS;
      document.head.appendChild(el);
    }
  }, []);

  const goTo = useCallback((id) => {
    const el = document.getElementById(`sec-${id}`);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 78, behavior: 'smooth' });
  }, []);

  // 导出
  const handleExport = useCallback((type) => {
    setExporting(true);
    setShowExportMenu(false);
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      if (type === 'quota') {
        exportToCSV((quota?.data || []).map(d => ({
          model: shortModel(d.model), used: d.used, limit: d.limit,
          percent: d.percent.toFixed(2) + '%',
          tpmUsed: d.tpmUsed ?? 0, tpmLimit: d.tpmLimit ?? 'N/A',
          tpmPercent: d.tpmPercent != null ? d.tpmPercent + '%' : 'N/A',
          avgLatency: d.avgLatency != null ? d.avgLatency + 'ms' : 'N/A',
        })), `配额数据_${ts}.csv`);
      } else if (type === 'timeline') {
        exportToCSV((timeline?.timeline || []).map(d => ({
          hour: d.label, today: d.today, yesterday: d.yesterday, change_percent: d.change,
        })), `时间线_${ts}.csv`);
      } else if (type === 'errors') {
        exportToCSV((errors?.errors || []).slice(0, 200).map(x => ({
          time: formatTime(x.ts), status: x.status, model: shortModel(x.model),
          message: x.message || '', latency: x.latency != null ? x.latency + 'ms' : 'N/A',
          ip: x.ip || '',
        })), `错误日志_${ts}.csv`);
      } else if (type === 'all') {
        const payload = {
          exportTime: new Date().toISOString(),
          quota: quota?.data, summary: quota && { globalRequests: quota.globalRequests, globalErrorRate: quota.globalErrorRate },
          timeline: timeline?.timeline, timelineSummary: timeline?.summary,
          errorCount: errors?.count, errors: (errors?.errors || []).slice(0, 200),
          recent: (recent?.recent || []).slice(0, 60), slowRequests: recent?.slowRequests || [],
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `完整数据_${ts}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (err) {
      console.error('导出失败:', err);
    } finally {
      setExporting(false);
    }
  }, [quota, timeline, errors, recent]);

  // ===========================================================================
  // 派生数据
  // ===========================================================================
  const modelStats = useMemo(() => {
    if (!quota?.data) return [];
    const maxUsed = Math.max(...quota.data.map(x => x.used || 0), 1);
    return quota.data.map(d => ({
      model: d.model,
      label: shortModel(d.model),
      color: getModelColor(d.model),
      used: d.used || 0,
      limit: d.limit,
      percent: d.percent || 0,
      share: pctOf(d.used || 0, maxUsed),
      avgLatency: d.avgLatency,
      tpmUsed: d.tpmUsed, tpmLimit: d.tpmLimit, tpmPercent: d.tpmPercent,
    })).sort((a, b) => b.used - a.used);
  }, [quota]);

  // 配额耗尽预测：按今日已用速率线性外推
  const predictions = useMemo(() => {
    const out = {};
    if (!quota?.data) return out;
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const hoursElapsed = Math.max((now - startOfDay) / 3600000, 0.5);
    quota.data.forEach(d => {
      const p = predictQuotaExhaustion(d.used, d.limit, hoursElapsed);
      if (p) out[d.model] = p;
    });
    return out;
  }, [quota]);

  // HTTP 状态分布：优先用 recent 明细统计，回退到 quota 的全局错误率
  const statusCounts = useMemo(() => {
    const rows = recent?.recent || [];
    const counts = { ok: 0, client: 0, server: 0 };
    rows.forEach(r => {
      if (r.status >= 500) counts.server++;
      else if (r.status >= 400) counts.client++;
      else if (r.status) counts.ok++;
    });
    if (counts.ok + counts.client + counts.server === 0) {
      const total = quota?.globalRequests || 0;
      const bad = errors?.count || 0;
      if (total > 0) { counts.ok = Math.max(total - bad, 0); counts.client = bad; }
    }
    return counts;
  }, [recent, quota, errors]);

  const hourlySpark = useMemo(() => (timeline?.timeline || []).map(d => ({ h: d.hour, v: d.today || 0 })), [timeline]);

  const latencySpark = useMemo(() => {
    const rows = recent?.recent || [];
    if (rows.length === 0) return null;
    const buckets = new Array(12).fill(null).map(() => ({ sum: 0, n: 0 }));
    const now = Date.now();
    rows.forEach(r => {
      if (r.latency == null) return;
      const ageMin = (now - new Date(r.ts).getTime()) / 60000;
      const idx = 11 - Math.min(Math.floor(ageMin / 5), 11);
      buckets[idx].sum += r.latency; buckets[idx].n++;
    });
    return buckets.map((b, i) => ({ h: i, v: b.n ? Math.round(b.sum / b.n) : 0 }));
  }, [recent]);

  const filteredRecent = useMemo(() => {
    const rows = recent?.recent || [];
    if (!selectedModel) return rows;
    return rows.filter(r => shortModel(r.model) === selectedModel || r.model === selectedModel);
  }, [selectedModel, recent]);

  const retryCount = recent?.retries || 0;
  const globalRequests = quota?.globalRequests || 0;
  const errorCount = errors?.count || 0;
  const errorRate = quota?.globalErrorRate != null
    ? Number(quota.globalErrorRate).toFixed(2)
    : (globalRequests > 0 ? ((errorCount / globalRequests) * 100).toFixed(2) : '0.00');
  const avgLatency = useMemo(() => {
    const rows = (quota?.data || []).filter(d => d.avgLatency != null);
    if (rows.length === 0) return null;
    return Math.round(rows.reduce((s, d) => s + d.avgLatency, 0) / rows.length);
  }, [quota]);
  const successCount = Math.max(globalRequests - errorCount, 0);
  const successRate = globalRequests > 0 ? ((successCount / globalRequests) * 100).toFixed(1) : '100.0';
  const alertLevel = quota?.errorAlert?.level || 'normal';
  const nearLimit = modelStats.filter(m => m.percent > 90);
  const topModel = modelStats[0];
  const timelineSummary = timeline?.summary || null;

  // ===========================================================================
  // 登录页
  // ===========================================================================
  if (!authed) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        background: 'linear-gradient(160deg,#0b1020 0%,#0f172a 36%,#151433 70%,#1b1746 100%)',
        position: 'relative', overflow: 'hidden', fontFamily: 'Inter,system-ui,-apple-system,"PingFang SC",sans-serif',
      }}>
        <style>{ANIM_CSS}</style>
        <div style={{
          position: 'fixed', inset: 0, pointerEvents: 'none',
          backgroundImage: 'linear-gradient(rgba(129,140,248,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(129,140,248,.055) 1px,transparent 1px)',
          backgroundSize: '44px 44px', animation: 'db-shimmer 40s linear infinite',
          maskImage: 'radial-gradient(ellipse 70% 60% at 50% 45%,#000 20%,transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 45%,#000 20%,transparent 80%)',
        }} />
        <div style={{ position: 'fixed', top: '-18%', right: '-8%', width: 620, height: 620, borderRadius: '50%', background: 'radial-gradient(circle,rgba(34,211,238,.13),transparent 68%)', pointerEvents: 'none', animation: 'db-pulse 9s ease-in-out infinite' }} />
        <div style={{ position: 'fixed', bottom: '-24%', left: '-10%', width: 520, height: 520, borderRadius: '50%', background: 'radial-gradient(circle,rgba(167,139,250,.13),transparent 68%)', pointerEvents: 'none', animation: 'db-pulse 12s ease-in-out infinite 2s' }} />

        <form onSubmit={handleLogin} className="db-card" style={{
          position: 'relative', zIndex: 1, width: '100%', maxWidth: 396, padding: '44px 38px',
          background: 'rgba(11,16,32,.78)', backdropFilter: 'blur(22px)',
          border: '1px solid rgba(129,140,248,.24)', borderRadius: 18,
          boxShadow: '0 24px 60px rgba(2,6,23,.7), inset 0 1px 0 rgba(255,255,255,.06)',
        }}>
          <div style={{ position: 'absolute', top: 0, left: 22, right: 22, height: 1.5, background: 'linear-gradient(90deg,transparent,#22d3ee,#818cf8,#a78bfa,transparent)' }} />
          <div style={{ textAlign: 'center', marginBottom: 30 }}>
            <div style={{
              width: 64, height: 64, margin: '0 auto 15px', borderRadius: 18,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30,
              background: 'linear-gradient(135deg,#22d3ee,#818cf8,#a78bfa)',
              boxShadow: '0 12px 32px rgba(99,102,241,.45), 0 0 40px rgba(34,211,238,.22)',
              animation: 'db-float 3.6s ease-in-out infinite',
            }}>🛡️</div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em' }}>监控控制台</h1>
            <p style={{ margin: '7px 0 0', fontSize: 12.5, color: '#64748b', fontFamily: 'ui-monospace,monospace' }}>Gemini Transparent Proxy</p>
          </div>
          <input
            type="password" value={password} autoFocus
            onChange={e => setPassword(e.target.value)}
            placeholder="访问密码"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '13px 15px', borderRadius: 10, fontSize: 14,
              background: 'rgba(2,6,23,.6)', border: '1px solid rgba(129,140,248,.28)', color: '#f1f5f9',
              outline: 'none', transition: 'border-color .18s ease, box-shadow .18s ease',
            }}
            onFocus={e => { e.target.style.borderColor = '#818cf8'; e.target.style.boxShadow = '0 0 0 3px rgba(129,140,248,.16)'; }}
            onBlur={e => { e.target.style.borderColor = 'rgba(129,140,248,.28)'; e.target.style.boxShadow = 'none'; }}
          />
          {authError && (
            <div style={{
              marginTop: 12, padding: '9px 12px', borderRadius: 9, fontSize: 12.5, color: '#fca5a5',
              background: 'rgba(248,113,113,.11)', border: '1px solid rgba(248,113,113,.32)',
              animation: 'db-shake .4s ease-in-out',
            }}>⚠️ {authError}</div>
          )}
          <button type="submit" className="db-btn" style={{
            width: '100%', marginTop: 16, padding: '13px', border: 'none', borderRadius: 10, cursor: 'pointer',
            background: 'linear-gradient(135deg,#6366f1,#818cf8,#a78bfa)', color: '#fff',
            fontSize: 14.5, fontWeight: 700, letterSpacing: '0.01em',
            boxShadow: '0 6px 20px rgba(99,102,241,.42)',
          }}>进入控制台</button>
          <div style={{ marginTop: 20, paddingTop: 15, borderTop: '1px solid rgba(148,163,184,.1)', textAlign: 'center', fontSize: 11, color: '#475569', fontFamily: 'ui-monospace,monospace' }}>
            实时监控 · 配额管理 · 错误分析
          </div>
        </form>
      </div>
    );
  }

  // ===========================================================================
  // 主界面
  // ===========================================================================
  const loadingSkeleton = loading && authed;

  return (
    <div style={{
      ...theme.body, minHeight: '100vh', position: 'relative',
      fontFamily: 'Inter,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
      WebkitFontSmoothing: 'antialiased',
    }}>
      <style>{ANIM_CSS}</style>

      {/* 背景光晕 */}
      <div style={{ position: 'fixed', top: '-16%', right: '-6%', width: 660, height: 660, borderRadius: '50%', background: `radial-gradient(circle,${theme.glowLayer},transparent 66%)`, pointerEvents: 'none', zIndex: 0, animation: 'db-pulse 11s ease-in-out infinite' }} />
      <div style={{ position: 'fixed', bottom: '-22%', left: '-10%', width: 540, height: 540, borderRadius: '50%', background: `radial-gradient(circle,${theme.glowLayer2},transparent 66%)`, pointerEvents: 'none', zIndex: 0, animation: 'db-pulse 14s ease-in-out infinite 3s' }} />

      {/* ============ 固定顶栏 ============ */}
      <header className="db-topbar" style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 60, height: 58,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: '0 20px',
        ...theme.topbar, backdropFilter: 'blur(16px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'linear-gradient(135deg,#22d3ee,#818cf8,#a78bfa)', fontSize: 16,
            boxShadow: theme.dark ? '0 0 18px rgba(34,211,238,.4)' : '0 3px 10px rgba(99,102,241,.35)',
          }}>🛡️</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14.5, fontWeight: 800, color: theme.text.hi, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
                Gemini <span style={{ color: theme.accent }}>Proxy</span>
              </span>
              <span className="db-hide-xs" style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: health?.status === 'ok' ? theme.ok : theme.err,
                boxShadow: `0 0 8px ${health?.status === 'ok' ? theme.ok : theme.err}`,
                animation: health?.status === 'ok' ? 'db-pulse 2.2s ease-in-out infinite' : 'none',
              }} />
            </div>
            <div className="db-hide-xs" style={{ fontSize: 10.5, color: theme.text.muted, fontFamily: 'ui-monospace,monospace' }}>
              Operations Console
            </div>
          </div>
        </div>

        <div className="db-topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="db-hide-xs" style={{
            fontSize: 11, color: theme.text.sub, fontFamily: 'ui-monospace,monospace',
            padding: '5px 10px', borderRadius: 8, background: theme.inset.background, border: theme.inset.border,
          }}>
            {now.toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
          <span className="db-hide-xs" style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: theme.text.sub,
            fontFamily: 'ui-monospace,monospace', padding: '5px 10px', borderRadius: 8,
            background: theme.inset.background, border: theme.inset.border,
          }}>
            <span style={{
              width: 22, height: 3, borderRadius: 2, background: theme.ring, position: 'relative', overflow: 'hidden', display: 'inline-block',
            }}>
              <span style={{
                position: 'absolute', inset: 0, width: `${refreshProgress}%`,
                background: `linear-gradient(90deg,${theme.accent2},${theme.accent})`, transition: 'width .3s linear',
              }} />
            </span>
            {lastRefreshTime ? formatTime(lastRefreshTime.toISOString()) : '--:--:--'}
          </span>
          <IconButton theme={theme} onClick={toggleDark} title="切换主题 (D)">{dark ? '☀️' : '🌙'}</IconButton>
          <div style={{ position: 'relative' }}>
            <IconButton theme={theme} onClick={() => setShowExportMenu(p => !p)} title="导出数据 (E)" disabled={exporting}>
              {exporting ? '⏳' : '📥'}
            </IconButton>
            {showExportMenu && (
              <>
                <div onClick={() => setShowExportMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 70 }} />
                <div className="db-card" style={{
                  position: 'absolute', top: 42, right: 0, zIndex: 80, minWidth: 190, padding: 6,
                  ...theme.card, borderRadius: 12, backdropFilter: 'blur(18px)',
                }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: theme.text.muted, padding: '7px 10px 8px', letterSpacing: '0.06em' }}>导出数据</div>
                  {[
                    { t: 'quota', i: '⚡', l: '模型配额 (CSV)' },
                    { t: 'timeline', i: '📈', l: '时间线 (CSV)' },
                    { t: 'errors', i: '🚨', l: '错误日志 (CSV)' },
                    { t: 'all', i: '💾', l: '完整快照 (JSON)' },
                  ].map(item => (
                    <button key={item.t} className="db-nav" onClick={() => handleExport(item.t)} disabled={exporting} style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px',
                      border: 'none', borderRadius: 8, background: 'transparent', cursor: exporting ? 'not-allowed' : 'pointer',
                      color: theme.text.main, fontSize: 12.5, textAlign: 'left', opacity: exporting ? 0.6 : 1,
                    }}>
                      <span style={{ fontSize: 14 }}>{item.i}</span>{item.l}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <IconButton theme={theme} onClick={fetchData} title="立即刷新 (R)" spinning={refreshing}>⟳</IconButton>
          <IconButton theme={theme} onClick={logout} title="退出登录 (Q)">⏏</IconButton>
        </div>
      </header>

      {/* ============ 主内容区 ============ */}
      <main className="db-main" style={{ marginLeft: 0, paddingTop: 58, position: 'relative', zIndex: 1, padding: '74px 22px 48px' }}>
        <div style={{ maxWidth: 1420, margin: '0 auto' }}>

          {/* 告警条 */}
          {alertLevel !== 'normal' && (
            <div className="db-card" style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16, padding: '12px 16px',
              borderRadius: 13, background: alertLevel === 'critical' ? `${theme.err}14` : `${theme.warn}14`,
              border: `1px solid ${alertLevel === 'critical' ? theme.err : theme.warn}44`,
            }}>
              <span style={{ fontSize: 16 }}>{alertLevel === 'critical' ? '🚨' : '⚠️'}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: alertLevel === 'critical' ? theme.err : theme.warn }}>
                {quota?.errorAlert?.message || '错误率异常'}
              </span>
              <span style={{ fontSize: 11.5, color: theme.text.sub, fontFamily: 'ui-monospace,monospace' }}>
                今日 {fmt(quota?.errorAlert?.totalRequests)} 次请求 · {fmt(quota?.errorAlert?.totalErrors)} 次失败
              </span>
              <a href="#sec-errors" onClick={(e) => { e.preventDefault(); goTo('errors'); }}
                style={{ marginLeft: 'auto', fontSize: 11.5, color: theme.accent, textDecoration: 'none', fontWeight: 600 }}>
                查看明细 →
              </a>
            </div>
          )}

          {/* ============ 核心指标网格 (Overview) ============ */}
          <div id="sec-overview" style={{ scrollMarginTop: 78 }}>
            <div className="db-metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14, marginBottom: 20 }}>
              {loadingSkeleton ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} style={{ ...theme.card, borderRadius: 14, padding: '16px' }}>
                    <Skeleton w="40%" h={12} theme={theme} style={{ marginBottom: 12 }} />
                    <Skeleton w="70%" h={26} theme={theme} style={{ marginBottom: 8 }} />
                    <Skeleton w="50%" h={10} theme={theme} />
                  </div>
                ))
              ) : (
                <>
                  <StatCard icon="📡" label="总请求数" value={<AnimatedNumber value={globalRequests} />} unit="次"
                    foot={`今日累计 · 相比昨日`} color={theme.accent} theme={theme}
                    spark={<MiniBars series={hourlySpark} color={theme.accent} theme={theme} />} />
                  <StatCard icon="✅" label="成功率" value={successRate} unit="%"
                    foot={`成功 ${fmt(successCount)} / 失败 ${fmt(errorCount)}`} color={theme.ok} theme={theme}
                    spark={<MiniBars series={hourlySpark} color={theme.ok} theme={theme} />} />
                  <StatCard icon="⚠️" label="错误与拦截" value={<AnimatedNumber value={errorCount} />} unit="个"
                    foot={`全局错误率 ${errorRate}%`} color={errorCount > 0 ? theme.err : theme.ok} theme={theme}
                    badge={unreadErrors} />
                  <StatCard icon="⏱️" label="平均延迟" value={avgLatency != null ? avgLatency : '—'} unit="ms"
                    foot="所有活跃模型综合加权" color={theme.warn} theme={theme}
                    spark={latencySpark ? <MiniBars series={latencySpark} color={theme.warn} theme={theme} /> : null} />
                  <StatCard icon="🔄" label="配额重置倒计时" value={formatCountdown(countdown)}
                    foot="UTC+8 每日 07:00 自动清零" color={theme.accent3} theme={theme} />
                </>
              )}
            </div>

            {/* 时间线大图 */}
            <Panel id="overview-chart" icon="📈" title="24 小时请求趋势" meta={timeline?.date ? `统计日期: ${timeline.date}` : ''}
              actions={
                timelineSummary && (
                  <Chip tone={timelineSummary.overallChange > 20 ? 'err' : timelineSummary.overallChange > 0 ? 'warn' : 'ok'} theme={theme}>
                    {timelineSummary.overallChange >= 0 ? '▲' : '▼'} {Math.abs(timelineSummary.overallChange)}% vs 昨天
                  </Chip>
                )
              } theme={theme} accent={theme.accent}>
              {loadingSkeleton ? (
                <div style={{ height: 210, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Skeleton w="100%" h={180} theme={theme} />
                </div>
              ) : (
                <>
                  <TimeSeriesChart data={timeline?.timeline} height={210} theme={theme} />
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${theme.grid}` }}>
                    <div>
                      <div style={{ fontSize: 10.5, color: theme.text.muted }}>今日总计</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: theme.text.hi, fontFamily: 'ui-monospace,monospace' }}>
                        {fmt(timelineSummary?.todayTotal)} <span style={{ fontSize: 11, fontWeight: 400, color: theme.text.muted }}>次</span>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10.5, color: theme.text.muted }}>昨日同期</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: theme.text.hi, fontFamily: 'ui-monospace,monospace' }}>
                        {fmt(timelineSummary?.yesterdayTotal)} <span style={{ fontSize: 11, fontWeight: 400, color: theme.text.muted }}>次</span>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10.5, color: theme.text.muted }}>峰值时段</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: theme.accent, fontFamily: 'ui-monospace,monospace' }}>
                        {String(timelineSummary?.peakHour ?? 0).padStart(2, '0')}:00 <span style={{ fontSize: 11, fontWeight: 400, color: theme.text.muted }}>({fmt(timelineSummary?.peakCount)} 次)</span>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </Panel>
          </div>

          {/* ============ 模型配额监控 (Quota) ============ */}
          <div style={{ marginTop: 22 }} id="sec-quota" style={{ scrollMarginTop: 78 }}>
            <Panel id="quota" icon="⚡" title="模型配额监控" meta={`共 ${modelStats.length} 个模型`}
              actions={
                selectedModel ? (
                  <button className="db-btn" onClick={() => setSelectedModel(null)} style={{
                    fontSize: 11.5, padding: '4px 11px', borderRadius: 14, cursor: 'pointer',
                    background: theme.inset.background, border: theme.inset.border, color: theme.text.sub,
                  }}>
                    清除筛选: {selectedModel} ✕
                  </button>
                ) : null
              } theme={theme} accent={theme.accent2}>
              {loadingSkeleton ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 14 }}>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} style={{ ...theme.card, borderRadius: 14, padding: 16, display: 'flex', gap: 14 }}>
                      <Skeleton w="64px" h={64} r="50%" theme={theme} />
                      <div style={{ flex: 1 }}>
                        <Skeleton w="80%" h={13} theme={theme} style={{ marginBottom: 8 }} />
                        <Skeleton w="60%" h={11} theme={theme} style={{ marginBottom: 10 }} />
                        <Skeleton w="40%" h={16} theme={theme} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : modelStats.length === 0 ? (
                <EmptyHint icon="📭" text="暂无模型配额数据" sub="模型在首次 API 请求触发后会自动录入并显示在此处" theme={theme} />
              ) : (
                <div className="db-quota-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 14 }}>
                  {modelStats.map((m) => {
                    const isSelected = selectedModel === m.label;
                    const isHigh = m.percent >= 90;
                    const isWarn = m.percent >= 70 && !isHigh;
                    const ringColor = isHigh ? theme.err : isWarn ? theme.warn : m.color;
                    const pred = predictions[m.model];
                    return (
                      <div key={m.model} className="db-qcard" onClick={() => setSelectedModel(isSelected ? null : m.label)} style={{
                        borderRadius: 14, padding: '16px', cursor: 'pointer',
                        background: isSelected ? `linear-gradient(135deg,${m.color}22,${m.color}07)` : theme.card.background,
                        border: isSelected ? `2px solid ${m.color}` : isHigh ? `1.5px solid ${theme.err}66` : theme.card.border,
                        boxShadow: isSelected ? `0 0 24px ${m.color}33` : theme.card.boxShadow,
                        position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 14,
                      }}>
                        <Ring percent={m.percent} size={66} stroke={6} color={ringColor}>
                          <span style={{ fontSize: 13, fontWeight: 800, color: ringColor, fontFamily: 'ui-monospace,monospace' }}>
                            {Math.round(m.percent)}%
                          </span>
                        </Ring>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: theme.text.hi, fontFamily: 'ui-monospace,monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {m.label}
                            </span>
                            {isHigh && <Chip tone="err" theme={theme}>超 90%</Chip>}
                          </div>
                          <div style={{ fontSize: 11.5, color: theme.text.sub, fontFamily: 'ui-monospace,monospace', marginBottom: 8 }}>
                            <strong style={{ color: ringColor, fontWeight: 700 }}>{fmt(m.used)}</strong> / {fmt(m.limit)}
                          </div>

                          {m.tpmLimit != null && (
                            <div style={{ marginBottom: 6 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: theme.text.muted, fontFamily: 'ui-monospace,monospace', marginBottom: 2 }}>
                                <span>TPM (每分钟 Token)</span>
                                <span style={{ color: m.tpmPercent > 80 ? theme.err : theme.text.sub }}>
                                  {fmtK(m.tpmUsed)} / {fmtK(m.tpmLimit)} ({m.tpmPercent}%)
                                </span>
                              </div>
                              <div style={{ height: 4, borderRadius: 2, background: theme.ring, overflow: 'hidden' }}>
                                <div style={{
                                  width: `${Math.min(m.tpmPercent, 100)}%`, height: '100%', borderRadius: 2,
                                  background: m.tpmPercent > 80 ? theme.err : m.tpmPercent > 60 ? theme.warn : theme.ok,
                                  transition: 'width .6s ease',
                                }} />
                              </div>
                            </div>
                          )}

                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {m.avgLatency != null && (
                              <span style={{ fontSize: 10.5, color: theme.text.muted, fontFamily: 'ui-monospace,monospace' }}>
                                ⚡ {m.avgLatency}ms
                              </span>
                            )}
                            {pred && !pred.exhausted && (
                              <span style={{ fontSize: 10.5, color: pred.minutes < 120 ? theme.err : theme.warn, fontFamily: 'ui-monospace,monospace' }}>
                                ⏳ 约 {formatDuration(pred.minutes)} 后耗尽
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          </div>

          {/* ============ 流量分析 + 请求日志 + 错误分析 + 系统状态 (p8) ============ */}
          <div style={{ marginTop: 22 }} id="sec-traffic" style={{ scrollMarginTop: 78 }}>
            <div className="db-split" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
              
              {/* 流量分析 */}
              <Panel id="traffic" icon="🧬" title="模型流量与状态" meta={`总请求数 ${fmt(globalRequests)}`} theme={theme} accent={theme.accent3}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.text.sub, marginBottom: 8 }}>模型用量排行与占比</div>
                    {modelStats.length === 0 ? (
                      <EmptyHint icon="📊" text="暂无分布数据" theme={theme} height={90} />
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {modelStats.slice(0, 5).map(m => (
                          <div key={m.model} style={{ padding: '8px 10px', borderRadius: 10, background: theme.inset.background, border: theme.inset.border }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                              <span style={{ fontWeight: 600, color: theme.text.hi, fontFamily: 'ui-monospace,monospace' }}>{m.label}</span>
                              <span style={{ color: theme.text.sub, fontFamily: 'ui-monospace,monospace' }}>{fmt(m.used)} 次 ({m.percent.toFixed(1)}%)</span>
                            </div>
                            <div style={{ height: 6, borderRadius: 3, background: theme.ring, overflow: 'hidden' }}>
                              <div style={{
                                width: `${Math.min(m.percent, 100)}%`, height: '100%', borderRadius: 3,
                                background: m.color, transition: 'width .8s ease',
                              }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ paddingTop: 12, borderTop: `1px solid ${theme.grid}` }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.text.sub, marginBottom: 9 }}>HTTP 响应状态构成</div>
                    <StatusBar counts={statusCounts} theme={theme} />
                  </div>
                </div>
              </Panel>

              {/* 请求日志 (Recent + Slow) */}
              <div id="sec-logs" style={{ scrollMarginTop: 78 }}>
                <Panel id="logs" icon="📋" title="最近请求与慢请求" meta={`重试: ${retryCount} 次`} theme={theme} accent={theme.accent}>
                  <div style={{ maxHeight: 380, overflowY: 'auto', paddingRight: 4 }} className="db-scroll">
                    {filteredRecent.length === 0 ? (
                      <EmptyHint icon="📭" text={selectedModel ? `模型 ${selectedModel} 暂无请求` : '暂无请求日志'} sub="向代理发送 API 请求后，实时记录将展示在这里" theme={theme} height={160} />
                    ) : (
                      filteredRecent.slice(0, 24).map((r, i) => {
                        const lbl = getStatusLabel(r.status);
                        const ua = parseUserAgent(r.ua);
                        return (
                          <LogRow key={i} time={formatTime(r.ts)} badge={r.status || '200'} badgeColor={lbl.color}
                            label={`${shortModel(r.model)} · ${ua.icon} ${ua.type}`}
                            meta={r.latency != null ? `${r.latency}ms` : undefined} theme={theme} />
                        );
                      })
                    )}
                  </div>
                </Panel>
              </div>

            </div>
          </div>

          {/* 错误分析 + 系统状态 */}
          <div style={{ marginTop: 22 }} id="sec-errors" style={{ scrollMarginTop: 78 }}>
            <div className="db-split" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
              
              {/* 错误分析 */}
              <Panel id="errors" icon="🚨" title="错误日志与时序分布" meta={`今日错误数: ${errorCount}`} theme={theme} accent={theme.err}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* 多维热力图：状态 / 延迟 / 模型 / 来源 / token × 24 小时 */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.text.sub, marginBottom: 6 }}>状态码 × 小时热力图 (24h)</div>
                      <HeatMatrix dim="status" data={heat} theme={theme} />
                      <HeatHourAxis data={heat} theme={theme} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.text.sub, marginBottom: 6 }}>延迟 × 小时热力图 (24h)</div>
                      <HeatMatrix dim="latency" data={heat} theme={theme} />
                      <HeatHourAxis data={heat} theme={theme} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.text.sub, marginBottom: 6 }}>模型 × 小时热力图 (24h)</div>
                      <HeatMatrix dim="models" data={heat} theme={theme} />
                      <HeatHourAxis data={heat} theme={theme} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.text.sub, marginBottom: 6 }}>调用来源 × 小时热力图 (24h)</div>
                      <HeatMatrix dim="clients" data={heat} theme={theme} />
                      <HeatHourAxis data={heat} theme={theme} />
                    </div>
                    <div>
                      <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.text.sub, marginBottom: 6 }}>输入 Token × 小时热力图 (24h)</div>
                      <HeatMatrix dim="tokens" data={heat} theme={theme} />
                      <HeatHourAxis data={heat} theme={theme} />
                    </div>
                  </div>
                  {/* 原始单条错误列表 */}
                  <div style={{ maxHeight: 240, overflowY: 'auto', paddingRight: 4 }} className="db-scroll">
                    {errors?.errors?.length === 0 ? (
                      <EmptyHint icon="✨" text="今日零错误，系统运行稳健" sub="任何 API 拦截或 upstream 4xx/5xx 会实时记录在此" theme={theme} height={110} />
                    ) : (
                      errors?.errors?.slice(0, 15).map((e, i) => {
                        const lbl = getStatusLabel(e.status);
                        return (
                          <LogRow key={i} time={formatTime(e.ts)} badge={e.status || 'Err'} badgeColor={lbl.color}
                            label={`${shortModel(e.model)}: ${e.message || '未知错误'}`}
                            meta={e.ip || undefined} theme={theme} />
                        );
                      })
                    )}
                  </div>
                </div>
              </Panel>

              {/* 系统状态 */}
              <div id="sec-system" style={{ scrollMarginTop: 78 }}>
                <Panel id="system" icon="🔗" title="系统健康与状态速查" meta="Vercel + Cloudflare" theme={theme} accent={theme.accent2}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                    <div style={{ padding: 12, borderRadius: 12, background: theme.inset.background, border: theme.inset.border }}>
                      <div style={{ fontSize: 11, color: theme.text.muted, marginBottom: 4 }}>Gemini API 上游</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, color: theme.text.hi }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: health?.gemini?.status === 'ok' ? theme.ok : theme.err, boxShadow: `0 0 6px ${health?.gemini?.status === 'ok' ? theme.ok : theme.err}` }} />
                        {health?.gemini?.status === 'ok' ? '正常' : '异常'}
                        {health?.gemini?.latency && <span style={{ fontSize: 11, fontWeight: 400, color: theme.text.muted }}>({health.gemini.latency}ms)</span>}
                      </div>
                    </div>
                    <div style={{ padding: 12, borderRadius: 12, background: theme.inset.background, border: theme.inset.border }}>
                      <div style={{ fontSize: 11, color: theme.text.muted, marginBottom: 4 }}>Upstash Redis</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, color: theme.text.hi }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: health?.redis?.status === 'ok' ? theme.ok : theme.err, boxShadow: `0 0 6px ${health?.redis?.status === 'ok' ? theme.ok : theme.err}` }} />
                        {health?.redis?.status === 'ok' ? '正常' : '离线 / 未配置'}
                        {health?.redis?.latency && <span style={{ fontSize: 11, fontWeight: 400, color: theme.text.muted }}>({health.redis.latency}ms)</span>}
                      </div>
                    </div>
                  </div>

                  <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.text.sub, marginBottom: 8 }}>HTTP 状态码速查</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 6 }}>
                    {Object.entries(HTTP_STATUS_DESC).map(([c, desc]) => {
                      const code = parseInt(c);
                      const col = code >= 500 ? theme.err : code >= 400 ? theme.warn : theme.ok;
                      return (
                        <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px', borderRadius: 6, background: theme.inset.background, fontSize: 11 }}>
                          <span style={{ padding: '1px 6px', borderRadius: 4, fontFamily: 'ui-monospace,monospace', fontWeight: 700, background: col + '1f', color: col, border: `1px solid ${col}33` }}>{c}</span>
                          <span style={{ color: theme.text.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{desc}</span>
                        </div>
                      );
                    })}
                  </div>
                </Panel>
              </div>

            </div>
          </div>

          {/* ============ Footer ============ */}
          <footer style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16,
            paddingTop: 28, marginTop: 16, borderTop: `1px solid ${theme.grid}`,
            color: theme.text.muted, fontSize: 12, fontFamily: 'ui-monospace,monospace',
          }}>
            <a href="https://github.com/JE668/gemini-transparent-proxy" target="_blank" rel="noopener noreferrer" style={{ color: theme.accent, textDecoration: 'none', fontWeight: 600 }}>
              GitHub 仓库
            </a>
            <span>·</span>
            <span>Gemini 透明代理 (Vercel + CF Workers)</span>
            <span>·</span>
            <span>方案 C 监控大屏</span>
          </footer>

        </div>
      </main>
    </div>
  );
}
