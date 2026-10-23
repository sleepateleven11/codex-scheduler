import test from 'node:test';
import assert from 'node:assert/strict';
import { isSubscriptionModel, threadProviderStatus, subscriptionPolicy } from '../src/provider-policy.mjs';

const account = { account: { type: 'chatgpt' } };
const status = (config = {}, options) => subscriptionPolicy(account, { config }, options);

test('only the built-in exact OpenAI provider marks a target subscription-compatible', () => {
  assert.equal(threadProviderStatus({ modelProvider: 'openai' }).providerCompatible, true);
  for (const value of ['deepseek', 'OPENAI', 'openai-proxy', null, undefined, '']) {
    const result = threadProviderStatus({ modelProvider: value });
    assert.equal(result.providerCompatible, false, String(value));
    assert.ok(result.providerIssue);
  }
});

test('the default OpenAI route permits unrelated custom provider definitions', () => {
  const result = status({ model_provider: null, model_providers: { deepseek: { base_url: 'https://api.deepseek.com' } }, chatgpt_base_url: 'https://chatgpt.com/backend-api' });
  assert.equal(result.ready, true);
  assert.equal(result.provider, 'openai');
  assert.equal(result.accountType, 'chatgpt');
  assert.deepEqual(Object.keys(result).sort(), ['accountType', 'code', 'issue', 'provider', 'providerLabel', 'ready'].sort());
});

test('a project effective default provider must be exact OpenAI', () => {
  for (const model_provider of ['deepseek', 'OPENAI', 'openai-proxy', '']) {
    const result = status({ model_provider });
    assert.equal(result.ready, false);
    assert.equal(result.code, 'DEFAULT_PROVIDER_UNSUPPORTED');
  }
});

test('API or unknown login cannot be authorized by an official-looking provider label', () => {
  for (const type of ['apiKey', null, undefined]) {
    const result = subscriptionPolicy({ account: { type, email: 'private@example.test' } }, { config: {} });
    assert.equal(result.ready, false);
    assert.equal(result.code, 'SUBSCRIPTION_LOGIN_REQUIRED');
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('custom OpenAI aliases and external or malformed endpoint overrides fail closed', () => {
  const endpoints = ['https://api.deepseek.com', 'https://api.openai.com.evil.example', 'http://chatgpt.com', 'https://chatgpt.com:8443', 'https://secret-user:secret-pass@chatgpt.com', 'https://chatgpt.com/?token=secret-token', 'not-an-endpoint'];
  for (const endpoint of endpoints) {
    for (const config of [{ model_providers: { openai: { base_url: endpoint } } }, { openai_base_url: endpoint }, { chatgpt_base_url: endpoint }]) {
      const result = status(config);
      assert.equal(result.code, 'OPENAI_ENDPOINT_OVERRIDE', endpoint);
      assert.doesNotMatch(JSON.stringify(result), /secret-|deepseek\.com|evil\.example/);
    }
    assert.equal(status({}, { openaiBaseUrl: endpoint }).code, 'OPENAI_ENDPOINT_OVERRIDE');
  }
});

test('explicit API auth overrides cannot use the subscription dispatcher', () => {
  const tokenTrap = {};
  Object.defineProperty(tokenTrap, 'experimental_bearer_token', { enumerable: true, get() { assert.fail('A credential value must never be read.'); } });
  for (const config of [
    { model_providers: { openai: { requires_openai_auth: false } } },
    { model_providers: { openai: { env_key: 'CUSTOM_API_KEY' } } },
    { model_providers: { openai: tokenTrap } },
    { forced_login_method: 'api' },
  ]) assert.equal(status(config).code, 'OPENAI_AUTH_OVERRIDE');
});

test('missing config is unconfirmed rather than implicitly using OpenAI', () => {
  for (const config of [null, undefined, []]) assert.equal(subscriptionPolicy(account, { config }).code, 'PROVIDER_CONFIGURATION_UNAVAILABLE');
});

test('only GPT catalog identifiers are eligible subscription models', () => {
  assert.equal(isSubscriptionModel('gpt-6.1-sol'), true);
  for (const value of ['deepseek-chat', 'gptfake', 'openai/gpt-6', '', null]) assert.equal(isSubscriptionModel(value), false);
});
