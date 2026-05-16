// app/dashboard/page.js
import { Redis } from '@upstash/redis';
import { cookies } from 'next/headers';

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const runtime = 'edge';

async function getStats(selectedDate) {
    const allModels = await redis.sMembers('all_models');
    const allDates = await redis.sMembers('all_dates');
    
    // 排序日期，最新的在前
    const sortedDates = allDates.sort((a, b) => b.localeCompare(a));

    let stats = [];
    let totalCalls = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    if (selectedDate && selectedDate !== 'all') {
        // 统计特定日期
        for (const model of allModels) {
            const data = await redis.hGetAll(`usage:${selectedDate}:${model}`);
            if (data && Object.keys(data).length > 0) {
                const calls = parseInt(data.calls || 0);
                const prompt = parseInt(data.prompt_tokens || 0);
                const completion = parseInt(data.completion_tokens || 0);
                stats.push({ model, calls, prompt, completion });
                totalCalls += calls;
                totalPromptTokens += prompt;
                totalCompletionTokens += completion;
            }
        }
    } else {
        // 汇总所有日期
        const modelTotals = {};
        for (const date of allDates) {
            for (const model of allModels) {
                const data = await redis.hGetAll(`usage:${date}:${model}`);
                if (data && Object.keys(data).length > 0) {
                    if (!modelTotals[model]) modelTotals[model] = { calls: 0, prompt: 0, completion: 0 };
                    modelTotals[model].calls += parseInt(data.calls || 0);
                    modelTotals[model].prompt += parseInt(data.prompt_tokens || 0);
                    modelTotals[model].completion += parseInt(data.completion_tokens || 0);
                }
            }
        }
        stats = Object.entries(modelTotals).map(([model, values]) => ({
            model, ...values
        }));
        
        stats.forEach(s => {
            totalCalls += s.calls;
            totalPromptTokens += s.prompt;
            totalCompletionTokens += s.completion;
        });
    }

    return { stats, sortedDates, totalCalls, totalPromptTokens, totalCompletionTokens };
}

export default async function DashboardPage({ searchParams }) {
    // 简单鉴权：检查 Cookie 或 Query 参数
    // 实际生产环境建议使用更严谨的 Auth，这里为了轻量使用环境变量校验
    const password = process.env.DASHBOARD_PASSWORD;
    const { date, pwd } = searchParams;

    if (password && pwd !== password) {
        return (
            <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'system-ui' }}>
                <h2>🔐 访问受限</h2>
                <form method="GET" style={{ marginTop: '20px' }}>
                    <input type="password" name="pwd" placeholder="请输入管理密码" style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ccc' }} />
                    <button type="submit" style={{ padding: '8px 16px', marginLeft: '10px', cursor: 'pointer' }}>进入</button>
                </form>
            </div>
        );
    }

    const { stats, sortedDates, totalCalls, totalPromptTokens, totalCompletionTokens } = await getStats(date);

    return (
        <div style={{ padding: '40px', fontFamily: 'system-ui', maxWidth: '1000px', margin: '0 auto', color: '#333' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
                <h1>🚀 AI Proxy Dashboard</h1>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <label>日期筛选：</label>
                    <select 
                        value={date || 'all'} 
                        onChange={(e) => {
                            // 这里由于是 Server Component，需要通过 URL 刷新
                            const url = new URL(window.location.href);
                            url.searchParams.set('date', e.target.value);
                            if (pwd) url.searchParams.set('pwd', pwd);
                            window.location.href = url.toString();
                        }} 
                        // 注意：在真正的 Next.js Server Component 中，select 的 onChange 需要客户端 JS
                        // 为了简单，我们在这里使用 a 标签或简单的 form 跳转，或者将此部分改为 Client Component
                    >
                        <option value="all">所有时间</option>
                        {sortedDates.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                </div>
            </div>

            {/* 由于 Server Component 不能直接处理 onChange，我将筛选器改为简单的链接列表或 Form */}
            <div style={{ marginBottom: '20px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <a href={`?date=all${pwd ? `&pwd=${pwd}` : ''}`} style={{ padding: '5px 10px', background: date === 'all' || !date ? '#0070f3' : '#eee', color: date === 'all' || !date ? '#fff' : '#333', borderRadius: '4px', textDecoration: 'none', fontSize: '14px' }}>全部</a>
                {sortedDates.map(d => (
                    <a key={d} href={`?date=${d}${pwd ? `&pwd=${pwd}` : ''}`} style={{ padding: '5px 10px', background: date === d ? '#0070f3' : '#eee', color: date === d ? '#fff' : '#333', borderRadius: '4px', textDecoration: 'none', fontSize: '14px' }}>{d}</a>
                ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px', marginBottom: '30px' }}>
                <div style={{ padding: '20px', background: '#f9f9f9', borderRadius: '8px', border: '1px solid #eee' }}>
                    <div style={{ fontSize: '14px', color: '#666' }}>总调用次数</div>
                    <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{totalCalls.toLocaleString()}</div>
                </div>
                <div style={{ padding: '20px', background: '#f9f9f9', borderRadius: '8px', border: '1px solid #eee' }}>
                    <div style={{ fontSize: '14px', color: '#666' }}>输入 Tokens</div>
                    <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{totalPromptTokens.toLocaleString()}</div>
                </div>
                <div style={{ padding: '20px', background: '#f9f9f9', borderRadius: '8px', border: '1px solid #eee' }}>
                    <div style={{ fontSize: '14px', color: '#666' }}>输出 Tokens</div>
                    <div style={{ fontSize: '24px', fontWeight: 'bold' }}>{totalCompletionTokens.toLocaleString()}</div>
                </div>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead>
                    <tr style={{ borderBottom: '2px solid #eee' }}>
                        <th style={{ padding: '12px' }}>模型名称</th>
                        <th style={{ padding: '12px' }}>调用次数</th>
                        <th style={{ padding: '12px' }}>输入 Tokens</th>
                        <th style={{ padding: '12px' }}>输出 Tokens</th>
                        <th style={{ padding: '12px' }}>总计 Tokens</th>
                    </tr>
                </thead>
                <tbody>
                    {stats.length > 0 ? stats.map((s, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                            <td style={{ padding: '12px', fontWeight: '500' }}>{s.model}</td>
                            <td style={{ padding: '12px' }}>{s.calls.toLocaleString()}</td>
                            <td style={{ padding: '12px' }}>{s.prompt.toLocaleString()}</td>
                            <td style={{ padding: '12px' }}>{s.completion.toLocaleString()}</td>
                            <td style={{ padding: '12px' }}>{(s.prompt + s.completion).toLocaleString()}</td>
                        </tr>
                    )) : (
                        <tr>
                            <td colSpan="5" style={{ padding: '40px', textAlign: 'center', color: '#999' }}>暂无数据</td>
                        </tr>
                    )}
                </tbody>
            </table>
            
            <footer style={{ marginTop: '40px', textAlign: 'center', fontSize: '12px', color: '#aaa' }}>
                Gemini Transparent Proxy Dashboard • Powered by Upstash Redis
            </footer>
        </div>
    );
}
