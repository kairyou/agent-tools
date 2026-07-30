# 自定义网关路由

[Provider usage](../../README.zh-CN.md#provider-usage) 的高级指南: 为内置 preset 覆盖不到的中转(比如 cookie 认证的网关)编写自己的用量探测, 无需修改包内代码.

## 声明路由

编写路由模块, 并在 `providerUsage.routes` 里声明(相对 `~/.agent-tools` 解析). 声明的路由优先探测; `"preset"` 填路由 id 可直接选中.

```jsonc
{
  "providerUsage": {
    "routes": [
      "custom/my-gateway.mjs",
      "custom/another-gateway.mjs"
    ],
    "myGateway": { "username": "me", "password": "..." }
  }
}
```

## 路由模块 API

```js
// ~/.agent-tools/custom/my-gateway.mjs
export const meta = { id: "my-gateway" }; // 可选; id 默认取文件名

export async function run(context, { requestJson, agentConfig }) {
  // context: { baseUrl, key, providerName, provider, label }
  const { myGateway = {} } = await agentConfig(); // providerUsage 对象, 自定义键随意加

  const login = await fetch(`${context.baseUrl}/api/user/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: myGateway.username, password: myGateway.password }),
  });
  const session = await login.json();

  // requestJson 会解析 JSON, 并在非 2xx 响应时抛错; 需要时可在这里传入
  // authorization, cookie 等自定义认证 header.
  const me = await requestJson(`${context.baseUrl}/api/user/self`, {
    headers: { authorization: `Bearer ${session?.data?.accessToken}` },
  });
  return { text: `balance ¥${me?.data?.balance}` };
}
```

`text` 是自由字符串; 成功返回 `{ text }`, 抛错则回落到下一条路由. 开启 `providerUsage.debug` 后, 探测失败会记录到 `~/.agent-tools/logs/usage-debug.log`.
