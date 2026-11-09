import { Layout, Typography } from "antd";

const { Header, Sider, Content } = Layout;

export function App() {
  return (
    <Layout data-testid="platform/shell/root" style={{ minHeight: "100vh" }}>
      <Sider width={240} theme="light">
        <Typography.Title level={4} data-testid="platform/shell/title">企业应用平台</Typography.Title>
      </Sider>
      <Layout>
        <Header data-testid="platform/shell/header" />
        <Content data-testid="platform/shell/content">暂无可用菜单</Content>
      </Layout>
    </Layout>
  );
}
