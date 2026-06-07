export const metadata = {
  title: 'Gemini 透明代理',
  description: '实时监控 · 智能分析 · 配额管理',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  );
}