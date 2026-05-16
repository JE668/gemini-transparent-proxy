'use client';
import { useEffect, useState } from 'react';

export default function DashboardPage() {
  const [health, setHealth] = useState(null);
  const [config, setConfig] = useState(null);
  const [quota, setQuota] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    fetch('/api/health').then(res => res.json()).then(setHealth).catch(console.error);
    fetch('/api/config').then(res => res.json()).then(setConfig).catch(console.error);
    fetch('/api/quota').then(res => res.json()).then(setQuota).catch(console.error);
  }, []);

  const testAPI = async () => {
    const apiKey = prompt('请输入你的 API Key（测试用）:');
    if (!apiKey) return;
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

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: '800px', margin: '0 auto', lineHeight: '1.5' }}>
      <h1 style={{ borderBottom: '2px solid #eee', paddingBottom: '0.5rem' }}>Gemini 代理 Dashboard 🦞</h1>
      
      <section style={{ marginBottom: '2rem' }}>
        <h2>健康状态</h2>
        {health ? (
          <p style={{ fontSize: '1.2rem' }}>
            状态: <span style={{ color: health.status === 'ok' ? 'green' : 'red' }}>
              {health.status === 'ok' ? '🟢 正常' : '🔴 异常'}
            </span> | 延迟: <strong>{health.latency}ms</strong>
            <br /><small>{health.message}</small>
          </p>
        ) : '加载中...'}
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2>代理配置</h2>
        {config ? (
          <pre style={{ background: '#f4f4f4', padding: '1rem', borderRadius: '8px', overflowX: 'auto' }}>
            {JSON.stringify(config, null, 2)}
          </pre>
        ) : '加载中...'}
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2>配额情况</h2>
        {quota ? (
          <>
            <p style={{ marginBottom: '1rem', fontSize: '0.9rem', color: '#666' }}>
              总请求数: <strong>{quota.globalRequests || 0}</strong>
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #ccc' }}>
                  <th>模型</th>
                  <th>使用率</th>
                  <th>已用/上限</th>
                </tr>
              </thead>
              <tbody>
                {(quota.data || []).map((item, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                    <td>{item.model}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ background: '#eee', width: '100px', height: '10px', borderRadius: '5px', overflow: 'hidden' }}>
                          <div style={{ background: item.percent > 90 ? 'red' : 'green', width: `${item.percent}%`, height: '100%' }} />
                        </div>
                        {item.percent}%
                      </div>
                    </td>
                    <td>{item.used} / {item.limit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : '加载中...'}
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2>API 测试器</h2>
        <textarea 
          rows="3" 
          style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #ccc', marginBottom: '10px' }} 
          value={prompt} 
          onChange={e => setPrompt(e.target.value)} 
          placeholder="输入消息..." 
        />
        <button 
          onClick={testAPI} 
          style={{ padding: '10px 20px', background: '#007bff', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
        >
          发送测试请求
        </button>
        {testResult && (
          <pre style={{ background: '#222', color: '#fff', padding: '1rem', borderRadius: '8px', marginTop: '1rem', overflowX: 'auto', fontSize: '0.85rem' }}>
            {testResult}
          </pre>
        )}
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2>快速链接</h2>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          <li style={{ marginBottom: '0.5rem' }}>
            <a href="https://ai.google.dev/gemini-api/docs" target="_blank" rel="noopener noreferrer" style={{ color: '#007bff' }}>🌐 Gemini API 官方文档</a>
          </li>
          <li>
            <a href="https://github.com/JE668/gemini-transparent-proxy" target="_blank" rel="noopener noreferrer" style={{ color: '#007bff' }}>💻 GitHub 仓库</a>
          </li>
        </ul>
      </section>
    </div>
  );
}
