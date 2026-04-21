# DeepSeek Native Chat for VS Code

Integrate DeepSeek AI as a native language model provider in VS Code using your own API key.

## What This Does

This extension adds DeepSeek as a **native language model provider** in VS Code, meaning:
- DeepSeek appears in the model selector alongside Claude, GPT, etc.
- You can use DeepSeek for chat, code completion, and other AI features
- It uses your own DeepSeek API key
- It's integrated into VS Code's native AI experience

## Installation

### Option 1: Development Mode (Quick Test)
1. Open the `deepseek-native-chat` folder in VS Code
2. Press `F5` to launch extension development host
3. In the new VS Code window, the extension will be active

### Option 2: Build and Install Permanently
```bash
# Build the extension
cd deepseek-native-chat
npm run compile

# Package as VSIX
npm install -g @vscode/vsce
vsce package

# Install the VSIX file
code --install-extension deepseek-native-chat-0.1.0.vsix
```

## Configuration

1. Get your API key from [DeepSeek Platform](https://platform.deepseek.com)
2. In VS Code:
   - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
   - Type "Configure DeepSeek API Key"
   - Enter your API key

Or configure in settings:
```json
{
  "deepseek.apiKey": "sk-your-api-key-here",
  "deepseek.baseURL": "https://api.deepseek.com"
}
```

## Usage

1. Open the chat panel (`Cmd+I` on Mac, `Ctrl+I` on Windows/Linux)
2. Click on the model selector (usually shows "Claude" or "GPT")
3. Select "DeepSeek Chat" or "DeepSeek Coder"
4. Start chatting!

## Features

- ✅ **Native Integration**: DeepSeek appears in VS Code's model selector
- ✅ **Your API Key**: Use your own DeepSeek API key
- ✅ **Two Models**: DeepSeek Chat and DeepSeek Coder
- ✅ **Streaming Responses**: Real-time streaming like native AI
- ✅ **Conversation History**: Full chat history support

## Requirements

- VS Code 1.88.0 or higher
- DeepSeek API key (free tier available)
- Node.js 18+ (for building)

## Troubleshooting

1. **Extension not appearing**: Make sure you're running VS Code 1.88+
2. **API errors**: Check your API key is valid and has credits
3. **No model selector**: You need GitHub Copilot individual plan for third-party model providers

## Development

```bash
# Install dependencies
npm install

# Watch for changes
npm run watch

# Rebuild
npm run compile

# Test in development host
Press F5
```

## License

MIT