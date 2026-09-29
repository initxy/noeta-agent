# 接入 OpenAI 兼容网关

**目标：** 让工作台用真实模型，而不是离线 mock。

**开始之前：** 你已经按[快速开始](../tutorials/quickstart.md)跑过零凭证模式，并且
手上有网关 URL 和 API key。

## 1. 把凭证写进 `./.env`

工作台对接 **OpenAI-Responses 兼容网关**（OpenAI 官方 API，或任何自建/厂商网关，
只要说 Responses 这套报文）。把 `.env.example` 复制成 `.env`，填两个 key：

```dotenv
LLM_PROVIDER=auto
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=sk-…
```

- `LLM_BASE_URL` 是网关**根地址** —— provider 自己会追加 `/responses`。最常见的
  错误就是填了一个已经以 `/responses` 结尾的地址。
- `LLM_PROVIDER=auto`（默认）在两个值都给了的时候走网关，否则回落到离线 mock，
  所以空 `.env` 永远不会导致启动失败。显式写 `openai` 却不给凭证会**启动即失败**，
  这是有意的：那是笔误，不是回落。
- 环境变量优先于文件；文件是从**进程工作目录**读的。

## 2. 把模型写进 `models.json`

模型选择器里的菜单来自 `./models.json`，不是来自网关：

```json
{
  "models": [
    {
      "id": "your-model-id",
      "label": "Your model",
      "default": true,
      "efforts": ["low", "medium", "high"],
      "default_effort": "medium",
      "context_window": 200000,
      "max_output_tokens": 32000
    }
  ]
}
```

- 有且只有一条带 `default: true`。
- `efforts` / `default_effort` 驱动推理强度选择器；没有推理档位的模型就不列。
- **自定义模型请补上 `context_window` 和 `max_output_tokens`。** 它们用于注册模型
  规格，驱动上下文压缩和输出 token 上限。不填也会注册该模型 —— 用一个保守默认值并
  在启动时打**警告** —— 所以压缩不会静默失效；但默认值只是猜测，请填真实值让它准确
  （并消除警告）。支持图片的模型还需 `"supports_vision": true`，否则发给它的图片输入
  会被拒绝。
- 文件缺失或无法解析时会降级成一个 fallback 模型并打警告；后端不会因为模型配置而
  崩溃。

## 3. 重启并确认

```bash
curl -s http://127.0.0.1:8000/api/v1/health
# {"status":"ok","version":"…","provider":"openai","sandbox_available":false,"data_dir":"…"}
```

`"provider": "mock"` 说明凭证没生效。

## 第二个网关

模型可以路由到第二个 Responses 兼容网关：设置 `SECONDARY_LLM_BASE_URL` +
`SECONDARY_LLM_API_KEY`，并在 `models.json` 里给要路由的条目打上
`"gateway": "secondary"`。第二网关只会叠加在生效的主网关之上，不能单独存在；两个
key 都设置才算配置完成。

## 会话标题

标题由一个独立的、便宜的调用异步生成，且发送的推理强度是 `"none"`，所以
`TITLE_MODEL` **必须是非推理模型**（留空 = 用默认对话模型）。mock provider 下不会
生成标题，会话直接用你消息的第一行作为标签，接上真实网关后再被替换。

## 排障

- **`/health` 显示 `"provider": "mock"`** —— `LLM_BASE_URL` 或 `LLM_API_KEY` 为空
  （auto 回落了），或者你改的 `.env` 不在你启动进程的那个目录里。
- **401 / 鉴权错误** —— 检查 key。两个网关都用 `Authorization: Bearer`。
- **选择器里没有那个模型** —— 菜单是 `models.json`，不是网关。去加条目。
- **长对话不压缩** —— 某个模型的 `context_window` 太小或用了默认值。在 `models.json`
  里填上真实的 `context_window` / `max_output_tokens`（凡是还在用默认值的模型，启动时
  都会打警告）。
- **422 `invalid_model` / `model_not_allowed`** —— 请求里的模型或推理强度不在目录
  内。这是同步拒绝的，永远不会打到 provider。

## 参见

- [配置参考](../reference/configuration.md) —— 每一个 key
- [使用工作台](use-the-workbench.md) —— 界面走查
