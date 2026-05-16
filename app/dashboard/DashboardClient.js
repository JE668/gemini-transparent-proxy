'use client';
import React, { useState, useEffect } from 'react';

export default function DashboardClient({ config }) {
    const [health, setHealth] = useState({ status: 'unknown', latency: null });
    const [testPrompt, setTestPrompt] = useState('Hello, who are you?');
    const [testResult, setTestResult] = useState('');
    const [testLoading, setTestLoading] = useState(false);

    const checkHealth = async () => {
        const start = Date.now();
        try {
            // Call a lightweight endpoint through the proxy
            const resp = await fetch('/api/v1beta/models');
            const latency = Date.now() - start;
            if (resp.ok) {
                setHealth({ status: 'healthy', latency });
            } else {
                setHealth({ status: 'error', latency });
            }
        } catch (e) {
            setHealth({ status: 'down', latency: null });
        }
    };

    useEffect(() => {
        checkHealth();
        const interval = setInterval(checkHealth, 60000);
        return () => clearInterval(interval);
    }, []);

    const runTest = async () => {
        setTestLoading(true);
        setTestResult('Thinking...');
        try {
            // Use a fast model for testing
            const resp = await fetch('/api/v1beta/models/gemini-1.5-flash:generateContent?key=' + (config.apiKey || ''), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: testPrompt }] }]
                })
            });
            const data = await resp.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data, null, 2);
            setTestResult(text);
        } catch (e) {
            setTestResult('Error: ' + e.message);
        } finally {
            setTestLoading(false);
        }
    };

    const styles = {
        container: {
            padding: '40px 20px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            maxWidth: '900px',
            margin: '0 auto',
            color: '#e2e8f0',
            backgroundColor: '#0f172a',
            minHeight: '100vh'
        },
        header: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '40px',
            borderBottom: '1px solid #1e293b',
            paddingBottom: '20px'
        },
        card: {
            backgroundColor: '#1e293b',
            borderRadius: '12px',
            padding: '24px',
            marginBottom: '24px',
            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
            border: '1px solid #334155'
        },
        title: {
            fontSize: '1.25rem',
            fontWeight: '600',
            marginBottom: '16px',
            color: '#f8fafc',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
        },
        configRow: {
            display: 'flex',
            justifyContent: 'space-between',
            padding: '12px 0',
            borderBottom: '1px solid #334155',
            fontSize: '14px'
        },
        configLabel: { color: '#94a3b8' },
        configValue: { color: '#f1f5f9', fontFamily: 'monospace' },
        statusBadge: (status) => ({
            padding: '4px 12px',
            borderRadius: '9999px',
            fontSize: '12px',
            fontWeight: 'bold',
            textTransform: 'uppercase',
            backgroundColor: status === 'healthy' ? '#065f46' : status === 'down' ? '#991b1b' : '#92400e',
            color: status === 'healthy' ? '#a7f3d0' : status === 'down' ? '#fecaca' : '#fde68a',
        }),
        input: {
            width: '100%',
            padding: '12px',
            borderRadius: '8px',
            border: '1px solid #334155',
            backgroundColor: '#0f172a',
            color: '#f8fafc',
            marginBottom: '12px',
            boxSizing: 'border-box'
        },
        button: {
            padding: '10px 20px',
            borderRadius: '8px',
            border: 'none',
            backgroundColor: '#3b82f6',
            color: '#fff',
            fontWeight: '600',
            cursor: 'pointer',
            transition: 'background 0.2s'
        },
        resultBox: {
            marginTop: '16px',
            padding: '16px',
            backgroundColor: '#0f172a',
            borderRadius: '8px',
            border: '1px solid #334155',
            fontSize: '14px',
            whiteSpace: 'pre-wrap',
            lineHeight: '1.6',
            color: '#cbd5e1'
        }
    };

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <h1 style={{ fontSize: '24px', margin: 0, color: '#f8fafc' }}>🚀 Proxy Control Panel</h1>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '14px', color: '#94a3b8' }}>System Status:</span>
                    <span style={styles.statusBadge(health.status)}>
                        {health.status === 'healthy' ? `Online (${health.latency}ms)` : health.status === 'down' ? 'Offline' : 'Checking...'}
                    </span>
                </div>
            </div>

            <div style={styles.card}>
                <div style={styles.title}>⚙️ Current Configuration</div>
                <div style={styles.configRow}>
                    <span style={styles.configLabel}>API Key</span>
                    <span style={styles.configValue}>{config.apiKey}</span>
                </div>
                <div style={styles.configRow}>
                    <span style={styles.configLabel}>Runtime</span>
                    <span style={styles.configValue}>Edge Runtime</span>
                </div>
                <div style={styles.configRow}>
                    <span style={styles.configLabel}>Proxy Version</span>
                    <span style={styles.configValue}>v0.2.0 Stable</span>
                </div>
            </div>

            <div style={styles.card}>
                <div style={styles.title}>🧪 API Link Tester</div>
                <p style={{ fontSize: '14px', color: '#94a3b8', marginBottom: '16px' }}>
                    Send a test prompt to verify the full chain: <br/>
                    <span style={{ color: '#60a5fa' }}>Client &rarr; Proxy &rarr; Google Gemini &rarr; Result</span>
                </p>
                <textarea 
                    style={styles.input} 
                    rows="3" 
                    value={testPrompt} 
                    onChange={(e) => setTestPrompt(e.target.value)}
                />
                <button 
                    style={{ ...styles.button, opacity: testLoading ? 0.6 : 1 }} 
                    onClick={runTest} 
                    disabled={testLoading}
                >
                    {testLoading ? 'Running...' : 'Run Test Request'}
                </button>
                {testResult && <div style={styles.resultBox}>{testResult}</div>}
            </div>

            <footer style={{ textAlign: 'center', marginTop: '40px', fontSize: '12px', color: '#64748b' }}>
                Absolute Stability Mode • No Route Interference
            </footer>
        </div>
    );
}
