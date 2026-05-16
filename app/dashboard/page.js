'use client';
import { useEffect, useState } from 'react';

export default function DashboardPage() {
  const [health, setHealth] = useState(null);
  const [config, setConfig] = useState(null);
  const [quota, setQuota] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [testResult, setTestResult] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/health').then(res => res.json()).then(setHealth).catch(console.error),
      fetch('/api/config').then(res => res.json()).then(setConfig).catch(console.error),
      fetch('/api/quota').then(res => res.json()).then(setQuota).catch(console.error),
    ]).finally(() => setIsLoading(false));
  }, []);

  const testAPI = async () => {
    const apiKey = prompt('请输入你的 API Key（测试用）:');
    if (!apiKey) return;
    setTestResult('Sending request...');
    try {
      const res = await fetch('/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gemma-4-31b-it', messages: [{ role: 'user', content: prompt }] })
      });
      const data = await res.json();
      setTestResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setTestResult('Error: ' + err.message);
    }
  };

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', fontFamily: 'system-ui' }}>
        <p style={{ fontSize: '1.2rem', color: '#666' }}>Loading Dashboard... 🦞</p>
      </div>
    );
  }

  return (
    <div style={{ 
      backgroundColor: '#f8fafc', 
      minHeight: '100vh', 
      padding: '2rem 1rem', 
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
      color: '#1e293b'
    }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
        
        {/* Header */}
        <header style={{ marginBottom: '2.5rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '2.5rem', fontWeight: '800', margin: '0 0 0.5rem 0', color: '#0f172a', letterSpacing: '-0.025em' }}>
            Gemini Proxy <span style={{ color: '#4f46e5' }}>Dashboard</span> 🦞
          </h1>
          <p style={{ color: '#64748b', fontSize: '1.1rem' }}>实时监控您的代理运行状态与配额消耗</p>
        </header>

        {/* Top Stats Grid */}
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', 
          gap: '1.5rem', 
          marginBottom: '2.5rem' 
        }}>
          
          {/* Health Card */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={cardTitleStyle}>系统状态</h3>
              <div style={{ fontSize: '1.5rem' }}>⚡️</div>
            </div>
            {health ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ 
                  width: '12px', height: '12px', borderRadius: '50%', 
                  backgroundColor: health.status === 'ok' ? '#22c55e' : '#ef4444',
                  boxShadow: health.status === 'ok' ? '0 0 8px #22c55e' : '0 0 8px #ef4444',
                  animation: health.status === 'ok' ? 'pulse 2s infinite' : 'none'
                }} />
                <span style={{ fontSize: '1.2rem', fontWeight: '600', color: health.status === 'ok' ? '#166534' : '#991b1b' }}>
                  {health.status === 'ok' ? '运行正常' : '服务异常'}
                </span>
                <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: '0.9rem' }}>{health.latency}ms</span>
              </div>
            ) : '加载中...'}
            <style>{`@keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }`}</style>
          </div>

          {/* Global Usage Card */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={cardTitleStyle}>总请求量</h3>
              <div style={{ fontSize: '1.5rem' }}>📈</div>
            </div>
            <div style={{ fontSize: '2rem', fontWeight: '800', color: '#4f46e5' }}>
              {quota?.globalRequests?.toLocaleString() || 0} <span style={{ fontSize: '1rem', color: '#94a3b8', fontWeight: 'normal' }}>requests</span>
            </div>
          </div>

          {/* Version Card */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={cardTitleStyle}>版本信息</h3>
              <div style={{ fontSize: '1.5rem' }}>⚙️</div>
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: '600' }}>
              v{config?.version || 'Unknown'} <span style={{ marginLeft: '10px', color: '#94a3b8', fontSize: '0.9rem' }}>Next.js Edge</span>
            </div>
          </div>
        </div>

        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', 
          gap: '1.5rem' 
        }}>
          {/* Quota Section */}
          <div style={{ ...cardStyle, gridRow: 'span 2' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={cardTitleStyle}>模型配额</h3>
              <div style={{ fontSize: '1.5rem' }}>💎</div>
            </div>
            {quota?.data ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
                {quota.data.map((item, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', fontWeight: '500' }}>
                      <span>{item.model}</span>
                      <span style={{ color: '#64748b' }}>{item.used} / {item.limit}</span>
                    </div>
                    <div style={{ background: '#e2e8f0', height: '8px', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ 
                        background: `linear-gradient(90deg, ${item.percent > 90 ? '#ef4444' : item.percent > 70 ? '#f59e0b' : '#3b82f6'}, #6366f1)`,
                        width: `${Math.min(item.percent, 100)}%`, 
                        height: '100%', 
                        transition: 'width 0.5s ease'
                      }} />
                    </div>
                    <div style={{ textAlign: 'right', fontSize: '0.75rem', color: '#94a3b8' }}>{item.percent}% used</div>
                  </div>
                ))}
              </div>
            ) : '加载中...'}
          </div>

          {/* API Tester Section */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={cardTitleStyle}>快捷测试</h3>
              <div style={{ fontSize: '1.5rem' }}>🧪</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <textarea 
                rows="3" 
                style={{ 
                  width: '100%', padding: '12px', borderRadius: '12px', border: '1px solid #e2e8f0', 
                  fontSize: '0.95rem', outline: 'none', transition: 'border-color 0.2s',
                  boxSizing: 'border-box'
                }} 
                onFocus={(e) => e.target.style.borderColor = '#4f46e5'}
                onBlur={(e) => e.target.style.borderColor = '#e2e8f0'}
                value={prompt} 
                onChange={e => setPrompt(e.target.value)} 
                placeholder="输入一条测试消息..." 
              />
              <button 
                onClick={testAPI} 
                style={{ 
                  padding: '12px', background: '#4f46e5', color: 'white', border: 'none', 
                  borderRadius: '12px', fontWeight: '600', cursor: 'pointer', 
                  transition: 'background 0.2s', boxShadow: '0 4px 6px -1px rgba(79, 70, 229, 0.3)'
                }}
                onMouseEnter={(e) => e.target.style.background = '#4338ca'}
                onMouseLeave={(e) => e.target.style.background = '#4f46e5'}
              >
                发送测试请求
              </button>
              {testResult && (
                <pre style={{ 
                  background: '#1e293b', color: '#e2e8f0', padding: '1rem', 
                  borderRadius: '12px', marginTop: '1rem', overflowX: 'auto', 
                  fontSize: '0.8rem', lineHeight: '1.4', maxHeight: '200px'
                }}>
                  {testResult}
                </pre>
              )}
            </div>
          </div>

          {/* Config Section */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={cardTitleStyle}>配置概览</h3>
              <div style={{ fontSize: '1.5rem' }}>📄</div>
            </div>
            <pre style={{ 
              background: '#f1f5f9', padding: '1rem', borderRadius: '12px', 
              fontSize: '0.85rem', color: '#475569', overflowX: 'auto', 
              border: '1px solid #e2e8f0'
            }}>
              {config ? JSON.stringify(config, null, 2) : '加载中...'}
            </pre>
          </div>
        </div>

        {/* Footer Links */}
        <footer style={{ marginTop: '3rem', textAlign: 'center', paddingBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '2rem', fontSize: '0.95rem' }}>
            <a href="https://ai.google.dev/gemini-api/docs" target="_blank" rel="noopener noreferrer" style={linkStyle}>🌐 官方文档</a>
            <a href="https://github.com/JE668/gemini-transparent-proxy" target="_blank" rel="noopener noreferrer" style={linkStyle}>💻 GitHub 仓库</a>
          </div>
          <p style={{ marginTop: '1.5rem', color: '#94a3b8', fontSize: '0.85rem' }}>
            &copy; {new Date().getFullYear()} Gemini Transparent Proxy | Powered by Vercel Edge
          </p>
        </footer>
      </div>
    </div>
  );
}

const cardStyle = {
  backgroundColor: 'white',
  padding: '1.5rem',
  borderRadius: '20px',
  boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.05), 0 4px 6px -2px rgba(0, 0, 0, 0.02)',
  border: '1px solid #f1f5f9',
};

const cardTitleStyle = {
  fontSize: '1.1rem',
  fontWeight: '700',
  color: '#475569',
  margin: 0,
};

const linkStyle = {
  color: '#4f46e5',
  textDecoration: 'none',
  fontWeight: '500',
  transition: 'color 0.2s',
};
