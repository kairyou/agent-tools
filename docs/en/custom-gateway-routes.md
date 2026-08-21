# Custom gateway routes

Advanced guide for [provider usage](../../README.md#provider-usage): write your own
usage probe for relays the built-in presets cannot reach (e.g. cookie-authenticated
gateways) without modifying package code.

## Declare a route

Write a route module and list it in `providerUsage.routes` (paths resolve against
`~/.agent-tools`). Declared routes are probed first; setting `"preset"` to a route
id selects it directly.

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

## Route module API

```js
// ~/.agent-tools/custom/my-gateway.mjs
export const meta = { id: "my-gateway" }; // optional; id defaults to the file name

export async function run(context, { requestJson, agentConfig }) {
  // context: { baseUrl, key, providerName, provider, label }
  const { myGateway = {} } = await agentConfig(); // the providerUsage object; custom keys welcome

  const login = await fetch(`${context.baseUrl}/api/user/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: myGateway.username, password: myGateway.password }),
  });
  const session = await login.json();

  // requestJson parses JSON and throws on non-2xx responses; pass custom
  // authorization or cookie headers here when needed.
  const me = await requestJson(`${context.baseUrl}/api/user/self`, {
    headers: { authorization: `Bearer ${session?.data?.accessToken}` },
  });
  return { text: `balance ¥${me?.data?.balance}` };
}
```

`text` is a free-form string; return `{ text }` on success, throw to fall through
to the next route. Enable `providerUsage.debug` to log probe failures to
`~/.agent-tools/logs/usage-debug.log`.
