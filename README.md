# Universal LLM Provider for VS Code

A universal language model provider extension for Visual Studio Code that supports multiple LLM providers including DeepSeek, Qwen, Zhipu GLM, Moonshot Kimi, and any OpenAI-compatible API.

## Features

- **Multi-Provider Support**: Configure multiple LLM providers in one extension
- **Native Integration**: Models appear in VS Code's native chat interface
- **Easy Configuration**: Simple API key setup through command palette
- **Streaming Responses**: Real-time token streaming from LLM APIs
- **Remote Development**: Works in remote environments (SSH, containers, Codespaces)

## Supported Providers

- **DeepSeek**: Chat & Coder models
- **Qwen**: Turbo, Plus, Max models  
- **Zhipu AI**: GLM-5, GLM-5.1 models
- **Moonshot AI**: Kimi K2.5, K2.6 models
- **Custom Providers**: Any OpenAI-compatible endpoint

## Installation

1. Install the extension from VSIX file
2. Restart VS Code

## Configuration

1. Open Command Palette (`Cmd+Shift+P`)
2. Run "Universal LLM: Configure Providers"
3. Select a provider (e.g., DeepSeek)
4. Enter your API key
5. Repeat for other providers as needed

## Usage

1. Open VS Code Chat (`Cmd+I`)
2. Click the model selector dropdown
3. Select any configured model (e.g., "DeepSeek Chat")
4. Start chatting!

## Commands

- `Universal LLM: Configure Providers` - Configure API keys for providers
- `Universal LLM: Add Provider` - Add custom OpenAI-compatible provider
- `Universal LLM: Show Status` - View configured providers and models

## Settings

Configure providers in `settings.json`:
```json
{
  "universal-llm.providers": [
    {
      "name": "DeepSeek",
      "vendor": "deepseek",
      "apiKey": "sk-your-key",
      "baseURL": "https://api.deepseek.com",
      "enabled": true,
      "models": ["deepseek-chat", "deepseek-coder"]
    }
  ]
}
```

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package extension
npm run package

# Install locally (requires VSCode CLI)
npm run install:local
```

## License

MIT
