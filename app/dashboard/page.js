// app/dashboard/page.js
export const runtime = 'edge';

export default async function DashboardPage() {
    // 只展示静态信息或从环境变量读取的数据
    const modelCount = 8; // 或者从你的模型列表导入
    const proxyVersion = '1.0.0';
    const uptime = process.env.START_TIME || 'Unknown';
    
    return (
        <div style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
            <h1>Gemini 透明代理 Dashboard</h1>
            <p>代理版本: {proxyVersion}</p>
            <p>支持模型数量: {modelCount}</p>
            <p>代理状态: ✅ 运行中</p>
            <hr />
            <h2>模型列表</h2>
            <ul>
                <li>gemma-4-31b-it</li>
                <li>gemma-4-26b-it</li>
                <li>gemini-2.5-flash-exp</li>
                <li>gemma-3-27b-it</li>
                <li>...</li>
            </ul>
            <p><i>此面板仅展示基本信息，不干扰代理转发。</i></p>
        </div>
    );
}
