import DashboardClient from './DashboardClient';

export const runtime = 'edge';

export default async function DashboardPage({ searchParams }) {
    const password = process.env.DASHBOARD_PASSWORD;
    const { pwd } = searchParams;

    if (password && pwd !== password) {
        return (
            <div style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center', 
                justifyContent: 'center', 
                height: '100vh', 
                backgroundColor: '#0f172a', 
                color: '#f8fafc', 
                fontFamily: 'system-ui' 
            }}>
                <div style={{ 
                    padding: '40px', 
                    backgroundColor: '#1e293b', 
                    borderRadius: '16px', 
                    border: '1px solid #334155', 
                    textAlign: 'center',
                    boxShadow: '0 10px 25px rgba(0,0,0,0.3)'
                }}>
                    <h2 style={{ marginBottom: '20px' }}>🔐 Dashboard Access</h2>
                    <form method="GET" style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                        <input 
                            type="password" 
                            name="pwd" 
                            placeholder="Enter Admin Password" 
                            style={{ 
                                padding: '12px', 
                                borderRadius: '8px', 
                                border: '1px solid #334155', 
                                backgroundColor: '#0f172a', 
                                color: '#fff',
                                textAlign: 'center'
                            }} 
                        />
                        <button 
                            type="submit" 
                            style={{ 
                                padding: '12px', 
                                borderRadius: '8px', 
                                border: 'none', 
                                backgroundColor: '#3b82f6', 
                                color: '#fff', 
                                fontWeight: '600', 
                                cursor: 'pointer' 
                            }}
                        >
                            Unlock
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    // Sanitize API Key for display (only show start and end)
    const apiKey = process.env.GEMINI_API_KEY || 'Not Set';
    const maskedKey = apiKey.length > 12 
        ? `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`
        : '********';

    return <DashboardClient config={{ apiKey: maskedKey }} />;
}
