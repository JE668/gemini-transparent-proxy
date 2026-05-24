'use client';
import { useEffect, useState, useCallback } from 'react';

const REFRESH_INTERVAL = 30000;

export default function DashboardPage() {
  const [quota, setQuota] = useState(null);
  const [health, setHealth] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [quotaRes, healthRes] = await Promise.all([
        fetch('/api/quota').then(r => r.json()),
        fetch('/api/health').then(r => r.json()).catch(() => null),
      ]);
      setQuota(quotaRes);
      setHealth(healthRes);
      setLastUpdate(new Date());
    } catch (e) {
      console.error('Fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchData]);

  // Compute global stats from quota data
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

  if (loading) {
    return (
      <div style={pageStyle}>
        <div style={centerStyle}>
          <div style={spinnerStyle} />
          <p style={{ color: '#64748b', marginTop: '16px' }}>Loading Dashboard...</p>
        </div>
      </div>
    );
  }

  const systemOk = health?.status === 'ok';

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: '1120px', margin: '0 auto' }}>

        {/* Header */}
        <header style={headerStyle}>
          <div>
            <h1 style={titleStyle}>Gemini Proxy <span style={{ color: '#6366f1' }}>Dashboard</span></h1>
            <p style={subtitleStyle}>
              {lastUpdate
                ? `Last updated: ${lastUpdate.toLocaleTimeString()} | Auto-refresh: ${REFRESH_INTERVAL / 1000}s`
                : 'Monitoring your proxy status and quota usage'}
            </p>
          </div>
          <button onClick={fetchData} style={refreshBtnStyle} title="Refresh now">
            &#x21bb;
          </button>
        </header>

        {/* Global Status Bar */}
        <div style={statusBarStyle}>
          <div style={statusItemStyle}>
            <div style={{ ...statusDotStyle, backgroundColor: systemOk ? '#22c55e' : '#ef4444', boxShadow: systemOk ? '0 0 8px rgba(34,197,94,0.5)' : '0 0 8px rgba(239,68,68,0.5)' }} />
            <div>
              <div style={statusLabelStyle}>System</div>
              <div style={{ ...statusValueStyle, color: systemOk ? '#166534' : '#991b1b' }}>
                {systemOk ? 'Online' : 'Offline'}
              </div>
            </div>
          </div>

          <div style={statusDividerStyle} />

          <div style={statusItemStyle}>
            <div style={statusEmojiStyle}>{}</div>
            <div>
              <div style={statusLabelStyle}>Total Requests</div>
              <div style={statusValueStyle}>{(quota?.globalRequests || 0).toLocaleString()}</div>
            </div>
          </div>

          <div style={statusDividerStyle} />

          <div style={statusItemStyle}>
            <div style={statusEmojiStyle}>{}</div>
            <div>
              <div style={statusLabelStyle}>Avg Latency</div>
              <div style={statusValueStyle}>{globalAvgLatency != null ? `${globalAvgLatency}ms` : 'N/A'}</div>
            </div>
          </div>

          <div style={statusDividerStyle} />

          <div style={statusItemStyle}>
            <div style={statusEmojiStyle}>{}</div>
            <div>
              <div style={statusLabelStyle}>Error Rate</div>
              <div style={{ ...statusValueStyle, color: (globalStats?.errorRate || 0) > 5 ? '#dc2626' : '#166534' }}>
                {globalStats ? `${globalStats.errorRate}%` : 'N/A'}
              </div>
            </div>
          </div>
        </div>

        {/* Model Cards */}
        <div style={modelGridStyle}>
          {quota?.data?.map((item, i) => (
            <ModelCard key={i} item={item} />
          ))}
        </div>

        {/* Footer */}
        <footer style={footerStyle}>
          <a href="https://github.com/JE668/gemini-transparent-proxy" target="_blank" rel="noopener noreferrer" style={footerLinkStyle}>
            GitHub
          </a>
          <span style={{ color: '#cbd5e1' }}>|</span>
          <span style={{ color: '#94a3b8', fontSize: '13px' }}>
            Gemini Transparent Proxy &middot; Vercel Edge
          </span>
        </footer>
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
      {/* Model Name & Usage Count */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' }}>
        <h3 style={cardModelNameStyle}>{item.model}</h3>
        <span style={cardUsageStyle}>
          {item.used.toLocaleString()} <span style={{ color: '#94a3b8' }}>/ {item.limit.toLocaleString()}</span>
        </span>
      </div>

      {/* Progress Bar */}
      <div style={progressTrackStyle}>
        <div style={{
          ...progressFillStyle,
          width: `${percent}%`,
          background: `linear-gradient(90deg, ${barColor}, ${isHigh ? '#dc2626' : isMedium ? '#d97706' : '#818cf8'})`,
        }} />
      </div>

      {/* Percentage Label */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', marginBottom: '14px' }}>
        <span style={{ fontSize: '13px', fontWeight: '600', color: barColor }}>
          {percent.toFixed(1)}%
        </span>
        <span style={{ fontSize: '12px', color: '#94a3b8' }}>
          {item.limit - item.used > 0 ? `${(item.limit - item.used).toLocaleString()} remaining` : 'Quota exhausted'}
        </span>
      </div>

      {/* Latency & Error Tags */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <Tag
          label="Latency"
          value={item.avgLatency != null ? `${item.avgLatency}ms` : 'N/A'}
          color={item.avgLatency != null && item.avgLatency > 3000 ? '#dc2626' : item.avgLatency != null && item.avgLatency > 1500 ? '#d97706' : '#059669'}
        />
        <Tag
          label="Errors"
          value={item.errorRate != null ? `${item.errorRate}%` : '0%'}
          color={(item.errorRate || 0) > 5 ? '#dc2626' : (item.errorRate || 0) > 1 ? '#d97706' : '#059669'}
        />
      </div>
    </div>
  );
}

function Tag({ label, value, color }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '3px 10px',
      borderRadius: '6px',
      fontSize: '12px',
      fontFamily: 'monospace',
      backgroundColor: `${color}11`,
      color: color,
      border: `1px solid ${color}33`,
    }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ fontWeight: '600' }}>{value}</span>
    </span>
  );
}

// ===================== Styles =====================

const pageStyle = {
  backgroundColor: '#f1f5f9',
  minHeight: '100vh',
  padding: '32px 20px',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  color: '#1e293b',
};

const centerStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
};

const spinnerStyle = {
  width: '40px',
  height: '40px',
  border: '3px solid #e2e8f0',
  borderTopColor: '#6366f1',
  borderRadius: '50%',
  animation: 'spin 0.8s linear infinite',
};

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '24px',
};

const titleStyle = {
  fontSize: '28px',
  fontWeight: '800',
  color: '#0f172a',
  margin: 0,
  letterSpacing: '-0.025em',
};

const subtitleStyle = {
  color: '#64748b',
  fontSize: '14px',
  marginTop: '4px',
  margin: 0,
};

const refreshBtnStyle = {
  width: '40px',
  height: '40px',
  borderRadius: '12px',
  border: '1px solid #e2e8f0',
  backgroundColor: 'white',
  fontSize: '20px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#6366f1',
  transition: 'all 0.2s',
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
};

const statusBarStyle = {
  display: 'flex',
  alignItems: 'center',
  backgroundColor: 'white',
  borderRadius: '16px',
  padding: '20px 28px',
  marginBottom: '28px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  border: '1px solid #e2e8f0',
  gap: '0',
  flexWrap: 'wrap',
};

const statusItemStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '4px 20px',
};

const statusDotStyle = {
  width: '10px',
  height: '10px',
  borderRadius: '50%',
  flexShrink: 0,
};

const statusEmojiStyle = {
  fontSize: '20px',
  flexShrink: 0,
};

const statusDividerStyle = {
  width: '1px',
  height: '36px',
  backgroundColor: '#e2e8f0',
  flexShrink: 0,
};

const statusLabelStyle = {
  fontSize: '12px',
  color: '#94a3b8',
  fontWeight: '500',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const statusValueStyle = {
  fontSize: '18px',
  fontWeight: '700',
  color: '#0f172a',
};

const modelGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
  gap: '16px',
  marginBottom: '40px',
};

const cardStyle = {
  backgroundColor: 'white',
  borderRadius: '16px',
  padding: '24px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  border: '1px solid #e2e8f0',
  transition: 'box-shadow 0.2s',
};

const cardModelNameStyle = {
  fontSize: '15px',
  fontWeight: '700',
  color: '#1e293b',
  margin: 0,
  fontFamily: 'monospace',
};

const cardUsageStyle = {
  fontSize: '16px',
  fontWeight: '700',
  color: '#6366f1',
};

const progressTrackStyle = {
  backgroundColor: '#f1f5f9',
  height: '8px',
  borderRadius: '4px',
  overflow: 'hidden',
};

const progressFillStyle = {
  height: '100%',
  borderRadius: '4px',
  transition: 'width 0.6s ease',
};

const footerStyle = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  gap: '12px',
  paddingTop: '20px',
  borderTop: '1px solid #e2e8f0',
};

const footerLinkStyle = {
  color: '#6366f1',
  textDecoration: 'none',
  fontSize: '13px',
  fontWeight: '500',
};
