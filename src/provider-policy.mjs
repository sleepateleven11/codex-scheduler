// Only public routing metadata belongs here. Never copy raw account/config
// responses into the manager, task records, diagnostics, or errors.
// Provider IDs are configuration keys. A custom "OPENAI" or "openai-proxy"
// must never be mistaken for the built-in, case-sensitive "openai" key.
const providerId = value => typeof value === 'string' && /^[a-z0-9._-]{1,64}$/i.test(value) ? value : null;
export const isSubscriptionModel = value => typeof value === 'string' && /^gpt(?:-|$)/i.test(value);
export const providerLabel = value => value === 'openai' ? 'OpenAI · ChatGPT 订阅' : value === 'deepseek' ? 'DeepSeek' : value ? '其他服务商' : '服务商未确认';

function officialEndpoint(value, allowedHosts) {
  if (value == null || value === '') return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === '443') && allowedHosts.includes(url.hostname.toLowerCase());
  } catch { return false; }
}

export function threadProviderStatus(thread) {
  const modelProvider = providerId(thread?.modelProvider);
  return {
    modelProvider,
    providerLabel: providerLabel(modelProvider),
    providerCompatible: modelProvider === 'openai',
    providerIssue: modelProvider === 'openai' ? null : modelProvider
      ? '这个对话绑定了其他服务商。请先在 Codex 原对话切换到 OpenAI 订阅通道，再刷新；也可以选择已有的 OpenAI 对话。仅选择 GPT 模型不会切换服务商。'
      : '无法确认这个对话的实际服务商，暂不发送。请在 Codex 原对话确认使用 OpenAI 订阅通道后刷新。',
  };
}

export function subscriptionPolicy(accountResponse, configResponse, { openaiBaseUrl } = {}) {
  const accountType = accountResponse?.account?.type === 'chatgpt' ? 'chatgpt' : accountResponse?.account?.type === 'apiKey' ? 'apiKey' : 'unknown';
  const config = configResponse?.config;
  // A null model_provider is the built-in OpenAI default. An unreadable config
  // is different: it cannot establish the route safely.
  const provider = config && (config.model_provider == null ? 'openai' : providerId(config.model_provider));
  const result = { ready: false, accountType, provider: provider || null, providerLabel: providerLabel(provider), issue: null, code: null };
  const deny = (code, issue) => ({ ...result, code, issue });
  if (accountType !== 'chatgpt') return deny('SUBSCRIPTION_LOGIN_REQUIRED', '请在 Codex 中登录自己的 ChatGPT 订阅账号。时序不会改用 API Key 付费通道。');
  if (!config || typeof config !== 'object' || Array.isArray(config)) return deny('PROVIDER_CONFIGURATION_UNAVAILABLE', '无法确认 Codex 的服务商配置，任务尚未发送。请运行连接自检后重试。');
  if (provider !== 'openai') return deny('DEFAULT_PROVIDER_UNSUPPORTED', 'Codex 当前项目默认使用其他服务商。请在 Codex 中切换到 OpenAI 订阅通道后重新自检。');
  const openai = config.model_providers?.openai;
  if (!officialEndpoint(openai?.base_url, ['api.openai.com', 'chatgpt.com']) ||
      !officialEndpoint(config.openai_base_url, ['api.openai.com', 'chatgpt.com']) ||
      !officialEndpoint(config.chatgpt_base_url, ['chatgpt.com']) ||
      !officialEndpoint(openaiBaseUrl, ['api.openai.com', 'chatgpt.com'])) {
    return deny('OPENAI_ENDPOINT_OVERRIDE', 'OpenAI 的连接地址被改为自定义服务。为避免把 GPT 消息发给其他服务商，本条任务不会发送；请恢复 Codex 官方订阅通道后重新自检。');
  }
  if (openai && (openai.requires_openai_auth === false || openai.env_key || Object.hasOwn(openai, 'experimental_bearer_token')) || config.forced_login_method === 'api') {
    return deny('OPENAI_AUTH_OVERRIDE', 'OpenAI 配置使用了 API 认证覆盖。请恢复 Codex 的 ChatGPT 订阅登录方式后重新自检。');
  }
  return { ...result, ready: true };
}

export class ProviderPolicyError extends Error {
  constructor(message, code) { super(message); this.name = 'ProviderPolicyError'; this.code = code; }
}
